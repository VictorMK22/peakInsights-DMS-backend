import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { SecurityEvent } from "../models/SecurityEvent";
import { User } from "../models/User";

export const listSecurityEvents = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const events = await SecurityEvent.find()
      .populate("actor", "name email")
      .sort({ timestamp: -1 })
      .limit(100);
    res.json({ success: true, message: "Security events retrieved", data: { events } });
  } catch (err) {
    next(err);
  }
};

// Manual entry point for things nothing in the codebase can detect on
// its own yet — a vulnerability found in a pen test, an incident
// write-up, a permission change made outside the app. `login` and
// `failed_login` events are written automatically by authController
// and shouldn't be posted here.
export const logSecurityEvent = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { type, detail, severity, actor, actorLabel } = req.body;
    if (!type || !detail?.trim()) {
      res.status(400).json({ success: false, message: "type and detail are required" });
      return;
    }
    if (type === "login" || type === "failed_login") {
      res.status(400).json({
        success: false,
        message: "login/failed_login events are recorded automatically and can't be posted manually",
      });
      return;
    }
    const event = await SecurityEvent.create({
      type,
      detail: detail.trim(),
      severity: severity ?? "medium",
      actor,
      actorLabel,
    });
    res.status(201).json({ success: true, message: "Security event logged", data: { event } });
  } catch (err) {
    next(err);
  }
};

export const getSecuritySummary = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const [mfaTotal, mfaEnabled, failedLogins24h, openVulnerabilities, criticalVulnerabilities, activeDevices] =
      await Promise.all([
        User.countDocuments({ isActive: true }),
        User.countDocuments({ isActive: true, mfaEnabled: true }),
        SecurityEvent.countDocuments({ type: "failed_login", timestamp: { $gte: new Date(Date.now() - 86400000) } }),
        SecurityEvent.countDocuments({ type: "vulnerability", severity: { $in: ["medium", "high", "critical"] } }),
        SecurityEvent.countDocuments({ type: "vulnerability", severity: "critical" }),
        SecurityEvent.distinct("actor", { type: "login", timestamp: { $gte: new Date(Date.now() - 30 * 86400000) } }),
      ]);

    res.json({
      success: true,
      message: "Security summary retrieved",
      data: {
        summary: {
          mfaEnabled,
          mfaTotal,
          failedLogins24h,
          openVulnerabilities,
          criticalVulnerabilities,
          activeDevices: activeDevices.length,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};
