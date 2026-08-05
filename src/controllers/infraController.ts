import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { InfraResource, STALE_AFTER_MINUTES } from "../models/InfraResource";

// A resource that hasn't reported a heartbeat within STALE_AFTER_MINUTES
// is shown as "offline" regardless of the status field it last set —
// silence is the one signal we can always trust without an agent.
const withComputedStatus = (r: ReturnType<InstanceType<typeof InfraResource>["toObject"]>) => {
  const staleMs = STALE_AFTER_MINUTES * 60000;
  const isStale = !r.lastHeartbeatAt || Date.now() - new Date(r.lastHeartbeatAt).getTime() > staleMs;
  return { ...r, status: isStale ? "offline" : r.status };
};

export const listInfra = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const resources = await InfraResource.find().sort({ name: 1 });
    const data = resources.map((r) => withComputedStatus(r.toObject()));
    res.json({ success: true, message: "Infrastructure retrieved", data: { resources: data } });
  } catch (err) {
    next(err);
  }
};

export const createInfra = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { name, type, region } = req.body;
    if (!name?.trim() || !type) {
      res.status(400).json({ success: false, message: "name and type are required" });
      return;
    }
    const resource = await InfraResource.create({ name: name.trim(), type, region, createdBy: req.user!.userId });
    res.status(201).json({ success: true, message: "Resource registered", data: { resource } });
  } catch (err) {
    next(err);
  }
};

// Called by an agent/cron job running on or near the actual resource.
// No such agent ships with this codebase yet — this is the endpoint
// one would be pointed at. No auth-role restriction beyond a valid
// token would normally be appropriate for a machine-to-machine
// heartbeat; for now it shares the same tech/ceo requirement as the
// rest of this router until a dedicated service-account token exists.
export const heartbeatInfra = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { status, uptimePercent, cpuPercent, memoryPercent, diskPercent, responseMs } = req.body;
    const resource = await InfraResource.findByIdAndUpdate(
      req.params.id,
      { status, uptimePercent, cpuPercent, memoryPercent, diskPercent, responseMs, lastHeartbeatAt: new Date() },
      { new: true },
    );
    if (!resource) {
      res.status(404).json({ success: false, message: "Resource not found" });
      return;
    }
    res.json({ success: true, message: "Heartbeat recorded", data: { resource } });
  } catch (err) {
    next(err);
  }
};

export const deleteInfra = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await InfraResource.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Resource removed", data: {} });
  } catch (err) {
    next(err);
  }
};
