import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Deployment } from "../models/Deployment";

export const listDeployments = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const deployments = await Deployment.find()
      .populate("deployedBy", "name email")
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, message: "Deployments retrieved", data: { deployments } });
  } catch (err) {
    next(err);
  }
};

export const createDeployment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { project, version, environment, status, scheduledFor, notes } = req.body;
    if (!project?.trim() || !version?.trim() || !environment) {
      res.status(400).json({ success: false, message: "project, version and environment are required" });
      return;
    }
    const deployment = await Deployment.create({
      project: project.trim(),
      version: version.trim(),
      environment,
      status,
      scheduledFor,
      notes,
      deployedBy: req.user!.userId,
    });
    res.status(201).json({ success: true, message: "Deployment logged", data: { deployment } });
  } catch (err) {
    next(err);
  }
};

export const updateDeployment = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const deployment = await Deployment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!deployment) {
      res.status(404).json({ success: false, message: "Deployment not found" });
      return;
    }
    res.json({ success: true, message: "Deployment updated", data: { deployment } });
  } catch (err) {
    next(err);
  }
};
