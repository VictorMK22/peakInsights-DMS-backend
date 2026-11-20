import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { User } from "../models/User";
import {
  ClientAuditLog,
  ClientAuditCategory,
} from "../models/ClientAuditLog";

interface ClientAuditParams {
  clientId: string | mongoose.Types.ObjectId;
  clientName?: string;
  category: ClientAuditCategory;
  action: string;
  summary: string;
  /** Never put passwords / secret values in here. */
  details?: Record<string, unknown>;
}

/**
 * Record one thing somebody did under a client. Never throws and never
 * blocks the real action — a failed audit write is only logged. Await it
 * before responding so serverless doesn't cut the write off.
 */
export const logClientActivity = async (
  req: AuthRequest,
  p: ClientAuditParams,
): Promise<void> => {
  try {
    const actorId = req.user?.userId;
    const actor = actorId
      ? await User.findById(actorId).select("name role").lean()
      : null;
    await ClientAuditLog.create({
      clientId: new mongoose.Types.ObjectId(String(p.clientId)),
      clientName: p.clientName,
      actorId: actorId ? new mongoose.Types.ObjectId(actorId) : undefined,
      actorName: actor?.name,
      actorRole: actor?.role ?? req.user?.role,
      category: p.category,
      action: p.action,
      summary: p.summary.slice(0, 1000),
      details: p.details,
      ipAddress:
        (req.headers?.["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() || req.ip,
      userAgent: req.headers?.["user-agent"],
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("Failed to write client audit log:", err);
  }
};