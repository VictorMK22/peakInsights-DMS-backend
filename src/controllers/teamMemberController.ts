import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { TeamMember } from "../models/TeamMember";

export const listTeamMembers = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const members = await TeamMember.find()
      .populate("userId", "name email")
      .sort({ createdAt: 1 });
    res.json({
      success: true,
      message: "Team members retrieved",
      data: { members },
    });
  } catch (err) {
    next(err);
  }
};

export const addTeamMember = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { userId, title } = req.body as { userId: string; title?: string };
    if (!userId) {
      res.status(400).json({ success: false, message: "userId is required" });
      return;
    }
    const existing = await TeamMember.findOne({ userId });
    if (existing) {
      res
        .status(409)
        .json({
          success: false,
          message: "That person is already on the team roster",
        });
      return;
    }
    const member = await TeamMember.create({
      userId,
      title,
      addedBy: req.user!.userId,
    });
    const populated = await member.populate("userId", "name email");
    res
      .status(201)
      .json({
        success: true,
        message: "Added to team",
        data: { member: populated },
      });
  } catch (err) {
    next(err);
  }
};

export const updateTeamMember = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { title } = req.body as { title?: string };
    const member = await TeamMember.findByIdAndUpdate(
      req.params.id,
      { title },
      { new: true },
    ).populate("userId", "name email");
    if (!member) {
      res
        .status(404)
        .json({ success: false, message: "Team member not found" });
      return;
    }
    res.json({
      success: true,
      message: "Team member updated",
      data: { member },
    });
  } catch (err) {
    next(err);
  }
};

export const removeTeamMember = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await TeamMember.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Removed from team", data: {} });
  } catch (err) {
    next(err);
  }
};
