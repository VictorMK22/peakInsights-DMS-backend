import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { TaskModel } from "../models/Task";
import { TaskReminderModel } from "../models/TaskReminder";
import { createNotification } from "../services/notificationService";
import { idOf } from "./documentController";

/**
 * Task reminders — a personal "remind me at …" on a task.
 *
 *   GET    /tasks/reminders/mine   the caller's upcoming reminders
 *   PUT    /tasks/:id/reminder     set / replace the caller's reminder
 *   DELETE /tasks/:id/reminder     clear it
 *
 * Delivery is a cron sweep (runTaskReminderSweep, called from
 * POST /api/cron/task-reminders) that sends an in-app notification.
 */

// Statuses in which the work is still "to be done".
const ACTIONABLE = ["pending", "in_progress", "rejected"];

const canSeeTask = (
  task: {
    assignedBy: unknown;
    assignedTo: unknown;
    collaborators: { userId: unknown; status: string }[];
  },
  userId: string,
  role: string,
): boolean =>
  role === "ceo" ||
  idOf(task.assignedBy) === userId ||
  idOf(task.assignedTo) === userId ||
  task.collaborators.some(
    (c) => idOf(c.userId) === userId && c.status === "active",
  );

export const getMyTaskReminders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const reminders = await TaskReminderModel.find({
      userId: req.user!.userId,
      sentAt: { $exists: false },
    })
      .select("taskId remindAt")
      .sort({ remindAt: 1 })
      .lean();
    res.json({
      success: true,
      message: "Reminders retrieved",
      data: { reminders },
    });
  } catch (err) {
    next(err);
  }
};

export const setTaskReminder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const { remindAt } = req.body as { remindAt?: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid task" });
      return;
    }
    const when = remindAt ? new Date(remindAt) : null;
    if (!when || Number.isNaN(when.getTime())) {
      res
        .status(400)
        .json({ success: false, message: "A valid reminder time is required" });
      return;
    }
    // A small grace window so "in 1 minute" from a slightly-slow client works.
    if (when.getTime() < Date.now() - 60_000) {
      res
        .status(400)
        .json({ success: false, message: "Reminder time must be in the future" });
      return;
    }

    const task = await TaskModel.findById(id).select(
      "assignedBy assignedTo collaborators status",
    );
    if (!task) {
      res.status(404).json({ success: false, message: "Task not found" });
      return;
    }
    if (!canSeeTask(task, req.user!.userId, req.user!.role)) {
      res.status(403).json({ success: false, message: "Access denied" });
      return;
    }
    if (!ACTIONABLE.includes(task.status)) {
      res.status(400).json({
        success: false,
        message: "Reminders can only be set on tasks that still need doing",
      });
      return;
    }

    const reminder = await TaskReminderModel.findOneAndUpdate(
      { taskId: task._id, userId: req.user!.userId },
      { $set: { remindAt: when }, $unset: { sentAt: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({
      success: true,
      message: "Reminder set",
      data: { reminder: { taskId: reminder.taskId, remindAt: reminder.remindAt } },
    });
  } catch (err) {
    next(err);
  }
};

export const clearTaskReminder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await TaskReminderModel.deleteOne({
      taskId: req.params.id,
      userId: req.user!.userId,
    });
    res.json({ success: true, message: "Reminder cleared" });
  } catch (err) {
    next(err);
  }
};

/**
 * CRON — send every reminder whose time has arrived.
 *
 * Each reminder is "claimed" with an atomic update (sentAt unset → set)
 * before notifying, so overlapping cron runs can't double-send.
 */
export const runTaskReminderSweep = async (): Promise<{ sent: number }> => {
  const now = new Date();
  const due = await TaskReminderModel.find({
    sentAt: { $exists: false },
    remindAt: { $lte: now },
  })
    .limit(500)
    .lean();
  if (due.length === 0) return { sent: 0 };

  const tasks = await TaskModel.find({ _id: { $in: due.map((d) => d.taskId) } })
    .select("title status dueDate")
    .lean();
  const taskById = new Map(tasks.map((t) => [String(t._id), t]));

  let sent = 0;
  for (const reminder of due) {
    const claimed = await TaskReminderModel.updateOne(
      { _id: reminder._id, sentAt: { $exists: false } },
      { $set: { sentAt: now } },
    );
    if (claimed.modifiedCount === 0) continue; // another run got it

    const task = taskById.get(String(reminder.taskId));
    // Task deleted, or no longer something to be done → consume silently.
    if (!task || !ACTIONABLE.includes(task.status)) continue;

    const dueText = task.dueDate
      ? ` Due ${task.dueDate.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        })}.`
      : "";
    await createNotification(
      String(reminder.userId),
      `Reminder: "${task.title}" is waiting for you.${dueText}`,
      "task_reminder",
      { taskId: String(task._id), title: task.title, dueDate: task.dueDate },
    );
    sent += 1;
  }
  return { sent };
};