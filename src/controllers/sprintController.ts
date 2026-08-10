import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Sprint } from "../models/Sprint";
import { ProjectTask } from "../models/ProjectTask";

export const listSprints = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.projectId) filter.projectId = req.query.projectId;
    const sprints = await Sprint.find(filter).sort({ startDate: -1 });
    res.json({
      success: true,
      message: "Sprints retrieved",
      data: { sprints },
    });
  } catch (err) {
    next(err);
  }
};

export const createSprint = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { projectId, name, goal, startDate, endDate, status } = req.body;
    if (!projectId || !name?.trim() || !startDate || !endDate) {
      res
        .status(400)
        .json({
          success: false,
          message: "projectId, name, startDate and endDate are required",
        });
      return;
    }
    const sprint = await Sprint.create({
      projectId,
      name: name.trim(),
      goal,
      startDate,
      endDate,
      status,
      createdBy: req.user!.userId,
    });
    res
      .status(201)
      .json({ success: true, message: "Sprint created", data: { sprint } });
  } catch (err) {
    next(err);
  }
};

export const updateSprint = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const sprint = await Sprint.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!sprint) {
      res.status(404).json({ success: false, message: "Sprint not found" });
      return;
    }
    res.json({ success: true, message: "Sprint updated", data: { sprint } });
  } catch (err) {
    next(err);
  }
};

export const deleteSprint = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Unassign rather than delete the tasks that were in this sprint —
    // deleting a sprint shouldn't take its work with it.
    await ProjectTask.updateMany(
      { sprintId: req.params.id },
      { $unset: { sprintId: "" } },
    );
    await Sprint.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Sprint deleted", data: {} });
  } catch (err) {
    next(err);
  }
};

// Points committed vs. points actually completed (using
// ProjectTask.completedAt, set automatically when a task's column
// becomes "done" — see projectController.updateProjectTask) — the
// simplest honest stand-in for a full burndown chart: not a
// day-by-day ideal-vs-actual line, but a real committed/done split
// computed from real task data rather than a fabricated curve.
export const getSprintSummary = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const tasks = await ProjectTask.find({ sprintId: req.params.id }).populate(
      "assignee",
      "name",
    );
    const committedPoints = tasks.reduce((sum, t) => sum + (t.points ?? 0), 0);
    const donePoints = tasks
      .filter((t) => t.column === "done")
      .reduce((sum, t) => sum + (t.points ?? 0), 0);

    res.json({
      success: true,
      message: "Sprint summary retrieved",
      data: {
        summary: {
          taskCount: tasks.length,
          doneCount: tasks.filter((t) => t.column === "done").length,
          committedPoints,
          donePoints,
        },
        tasks,
      },
    });
  } catch (err) {
    next(err);
  }
};
