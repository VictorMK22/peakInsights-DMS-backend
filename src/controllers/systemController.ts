import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { SystemService } from "../models/SystemService";

export const listSystems = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const systems = await SystemService.find().populate("owner", "name").sort({ name: 1 });
    res.json({ success: true, message: "Systems retrieved", data: { systems } });
  } catch (err) {
    next(err);
  }
};

export const createSystem = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { name, type, owner } = req.body;
    if (!name?.trim() || !type) {
      res.status(400).json({ success: false, message: "name and type are required" });
      return;
    }
    const system = await SystemService.create({ name: name.trim(), type, owner, createdBy: req.user!.userId });
    res.status(201).json({ success: true, message: "System registered", data: { system } });
  } catch (err) {
    next(err);
  }
};

export const updateSystemStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { status, nextRunAt } = req.body;
    const system = await SystemService.findByIdAndUpdate(
      req.params.id,
      { status, nextRunAt, lastRunAt: new Date() },
      { new: true },
    );
    if (!system) {
      res.status(404).json({ success: false, message: "System not found" });
      return;
    }
    res.json({ success: true, message: "System updated", data: { system } });
  } catch (err) {
    next(err);
  }
};

export const restartSystem = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // No real process supervisor is wired up — this only flips the
    // recorded status back to "running" so the UI reflects intent.
    // Wiring this to an actual restart requires an agent on the host
    // running the service, same as infrastructure heartbeats.
    const system = await SystemService.findByIdAndUpdate(
      req.params.id,
      { status: "running", lastRunAt: new Date() },
      { new: true },
    );
    if (!system) {
      res.status(404).json({ success: false, message: "System not found" });
      return;
    }
    res.json({ success: true, message: "Restart recorded (no live process attached)", data: { system } });
  } catch (err) {
    next(err);
  }
};
