import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { Project } from "../models/Project";
import { ProjectTask } from "../models/ProjectTask";

export const listProjects = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const projects = await Project.find()
      .populate("lead", "name email")
      .populate("members", "name email")
      .sort({ createdAt: -1 });

    // Attach task counts so the portfolio view doesn't need N+1 calls.
    const counts = await ProjectTask.aggregate([
      {
        $group: {
          _id: { projectId: "$projectId", done: { $eq: ["$column", "done"] } },
          count: { $sum: 1 },
        },
      },
    ]);
    const totals = new Map<string, { total: number; done: number }>();
    for (const c of counts) {
      const key = String(c._id.projectId);
      const entry = totals.get(key) ?? { total: 0, done: 0 };
      entry.total += c.count;
      if (c._id.done) entry.done += c.count;
      totals.set(key, entry);
    }

    const data = projects.map((p) => {
      const t = totals.get(String(p._id)) ?? { total: 0, done: 0 };
      return {
        ...p.toObject(),
        tasksTotal: t.total,
        tasksDone: t.done,
        progress: t.total ? Math.round((t.done / t.total) * 100) : 0,
      };
    });

    res.json({
      success: true,
      message: "Projects retrieved",
      data: { projects: data },
    });
  } catch (err) {
    next(err);
  }
};

export const createProject = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      key,
      name,
      description,
      priority,
      startDate,
      dueDate,
      lead,
      members,
    } = req.body;
    if (!key?.trim() || !name?.trim() || !lead) {
      res
        .status(400)
        .json({ success: false, message: "key, name and lead are required" });
      return;
    }
    const project = await Project.create({
      key: key.trim(),
      name: name.trim(),
      description,
      priority,
      startDate,
      dueDate,
      lead,
      members: members ?? [],
      createdBy: req.user!.userId,
    });
    res
      .status(201)
      .json({ success: true, message: "Project created", data: { project } });
  } catch (err) {
    next(err);
  }
};

export const updateProject = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const project = await Project.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }
    res.json({ success: true, message: "Project updated", data: { project } });
  } catch (err) {
    next(err);
  }
};

export const deleteProject = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await Project.findByIdAndDelete(req.params.id);
    await ProjectTask.deleteMany({ projectId: req.params.id });
    res.json({ success: true, message: "Project deleted", data: {} });
  } catch (err) {
    next(err);
  }
};

// ── Kanban tasks ────────────────────────────────────────────────

export const listProjectTasks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.projectId) filter.projectId = req.query.projectId;
    if (req.query.sprintId) filter.sprintId = req.query.sprintId;
    const tasks = await ProjectTask.find(filter)
      .populate("assignee", "name email")
      .sort({ column: 1, order: 1 });
    res.json({ success: true, message: "Tasks retrieved", data: { tasks } });
  } catch (err) {
    next(err);
  }
};

export const createProjectTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const {
      projectId,
      title,
      description,
      column,
      assignee,
      priority,
      labels,
      dueDate,
      points,
    } = req.body;
    if (!projectId || !title?.trim()) {
      res
        .status(400)
        .json({ success: false, message: "projectId and title are required" });
      return;
    }
    const task = await ProjectTask.create({
      projectId,
      title: title.trim(),
      description,
      column,
      assignee,
      priority,
      labels,
      dueDate,
      points,
      createdBy: req.user!.userId,
    });
    res
      .status(201)
      .json({ success: true, message: "Task created", data: { task } });
  } catch (err) {
    next(err);
  }
};

export const updateProjectTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const updates: Record<string, unknown> = { ...req.body };
    // Burndown/velocity need to know *when* a task was actually
    // finished, not just its current column — set that automatically
    // rather than trusting the frontend to send a timestamp, and
    // clear it if a task gets moved back out of done.
    if (updates.column === "done") {
      updates.completedAt = new Date();
    } else if (updates.column !== undefined) {
      updates.completedAt = null;
    }
    const task = await ProjectTask.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }
    res.json({ success: true, message: "Task updated", data: { task } });
  } catch (err) {
    next(err);
  }
};

export const deleteProjectTask = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await ProjectTask.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Task deleted", data: {} });
  } catch (err) {
    next(err);
  }
};

// ── Roadmap milestones ──────────────────────────────────────────
// Dedicated endpoints rather than folding this into updateProject's
// generic findByIdAndUpdate(req.body) — milestones is an array of
// subdocuments, and a generic update would require the frontend to
// resend the *entire* array (including untouched milestones) just to
// add or toggle one, which is both wasteful and racy under
// concurrent edits.

export const addMilestone = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { title, date } = req.body as { title: string; date: string };
    if (!title?.trim() || !date) {
      res
        .status(400)
        .json({ success: false, message: "title and date are required" });
      return;
    }
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $push: { milestones: { title: title.trim(), date, done: false } } },
      { new: true },
    );
    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }
    res
      .status(201)
      .json({ success: true, message: "Milestone added", data: { project } });
  } catch (err) {
    next(err);
  }
};

export const updateMilestone = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { title, date, done } = req.body as {
      title?: string;
      date?: string;
      done?: boolean;
    };
    const set: Record<string, unknown> = {};
    if (title !== undefined) set["milestones.$.title"] = title;
    if (date !== undefined) set["milestones.$.date"] = date;
    if (done !== undefined) set["milestones.$.done"] = done;

    const project = await Project.findOneAndUpdate(
      { _id: req.params.id, "milestones._id": req.params.milestoneId },
      { $set: set },
      { new: true },
    );
    if (!project) {
      res
        .status(404)
        .json({ success: false, message: "Project or milestone not found" });
      return;
    }
    res.json({
      success: true,
      message: "Milestone updated",
      data: { project },
    });
  } catch (err) {
    next(err);
  }
};

export const deleteMilestone = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $pull: { milestones: { _id: req.params.milestoneId } } },
      { new: true },
    );
    if (!project) {
      res.status(404).json({ success: false, message: "Project not found" });
      return;
    }
    res.json({
      success: true,
      message: "Milestone removed",
      data: { project },
    });
  } catch (err) {
    next(err);
  }
};
