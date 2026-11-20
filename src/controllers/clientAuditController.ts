import { Response } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { ClientModel } from "../models/Client";
import {
  ClientAuditLog,
  CLIENT_AUDIT_CATEGORIES,
} from "../models/ClientAuditLog";
import { MeetingActivityModel } from "../models/MeetingActivity";
import { User } from "../models/User";
import { isTechDepartmentName } from "../middleware/auth";

// ═══════════════════════════════════════════════════════════════
// CLIENT AUDIT TRAIL — everything done under one client.
// Visible ONLY to the CEO and Tech-department supervisors.
// ═══════════════════════════════════════════════════════════════

const canViewAudit = async (req: AuthRequest): Promise<boolean> => {
  const { role, userId } = req.user!;
  if (role === "ceo") return true;
  if (role === "supervisor") {
    const me = await User.findById(userId).select("department").lean();
    return isTechDepartmentName(me?.department);
  }
  return false;
};

// GET /clients/:id/audit-trail?category=&limit=&before=
export const getClientAuditTrail = async (req: AuthRequest, res: Response) => {
  try {
    if (!(await canViewAudit(req)))
      return res.status(403).json({
        success: false,
        message:
          "Only the CEO or a Tech department supervisor can view a client's audit trail",
      });

    const clientId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(clientId))
      return res.status(404).json({ success: false, message: "Client not found" });

    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
      200,
    );
    const category =
      typeof req.query.category === "string" &&
      (CLIENT_AUDIT_CATEGORIES as readonly string[]).includes(req.query.category)
        ? req.query.category
        : undefined;
    const beforeRaw = req.query.before ? new Date(String(req.query.before)) : null;
    const before = beforeRaw && !isNaN(beforeRaw.getTime()) ? beforeRaw : null;
    const cid = new mongoose.Types.ObjectId(clientId);

    const auditFilter: Record<string, unknown> = { clientId: cid };
    if (category) auditFilter.category = category;
    if (before) auditFilter.timestamp = { $lt: before };

    // The meeting module already records calendar lifecycle events per
    // client (scheduled / rescheduled / cancelled / RSVPs …). Fold them in.
    const includeMeetings = !category || category === "meeting";
    const meetingFilter: Record<string, unknown> = { clientId: cid };
    if (before) meetingFilter.timestamp = { $lt: before };

    const [audit, meetingActs, client] = await Promise.all([
      ClientAuditLog.find(auditFilter)
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean(),
      includeMeetings
        ? MeetingActivityModel.find(meetingFilter)
            .sort({ timestamp: -1 })
            .limit(limit + 1)
            .populate("actorId", "name role")
            .lean()
        : Promise.resolve([] as any[]),
      ClientModel.findById(clientId).select("name").lean(),
    ]);

    const unified = [
      ...audit.map((a: any) => ({
        _id: String(a._id),
        category: a.category,
        action: a.action,
        summary: a.summary,
        details: a.details,
        actor: {
          _id: a.actorId ? String(a.actorId) : null,
          name: a.actorName ?? "Unknown user",
          role: a.actorRole ?? null,
        },
        ipAddress: a.ipAddress,
        timestamp: a.timestamp,
      })),
      ...meetingActs.map((m: any) => ({
        _id: `meeting-${String(m._id)}`,
        category: "meeting",
        action: m.action,
        summary: m.message,
        details: m.details,
        actor: {
          _id: m.actorId?._id ? String(m.actorId._id) : null,
          name: m.actorId?.name ?? "Unknown user",
          role: m.actorId?.role ?? null,
        },
        ipAddress: undefined,
        timestamp: m.timestamp,
      })),
    ].sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const hasMore = unified.length > limit;
    const entries = unified.slice(0, limit);
    return res.json({
      success: true,
      data: {
        clientName: client?.name,
        entries,
        hasMore,
        nextBefore: hasMore ? entries[entries.length - 1].timestamp : null,
      },
    });
  } catch (err) {
    console.error("getClientAuditTrail error:", err);
    return res.status(500).json({ success: false });
  }
};