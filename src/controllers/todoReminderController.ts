import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { TodoListModel } from "../models/TodoList";
import { TodoReminderModel } from "../models/TodoReminder"
import { createNotification } from "../services/notificationService";

/**
 * To-do item reminders — a personal "remind me at …" on one item.
 *
 *   GET    /todos/reminders/mine                 my pending reminders
 *   PUT    /todos/:id/items/:itemId/reminder     set / replace
 *   DELETE /todos/:id/items/:itemId/reminder     clear
 *
 * Lists are private to their owner, so every lookup is scoped to the caller.
 * Delivery is runTodoReminderSweep, called from POST /api/cron/task-reminders.
 */

export const getMyTodoReminders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const reminders = await TodoReminderModel.find({
      userId: req.user!.userId,
      sentAt: { $exists: false },
    })
      .select("listId itemId remindAt")
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

export const setTodoReminder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id, itemId } = req.params;
    const { remindAt } = req.body as { remindAt?: string };

    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(itemId)) {
      res.status(404).json({ success: false, message: "Item not found" });
      return;
    }
    const when = remindAt ? new Date(remindAt) : null;
    if (!when || Number.isNaN(when.getTime())) {
      res
        .status(400)
        .json({ success: false, message: "A valid reminder time is required" });
      return;
    }
    // Small grace window so "in 1 minute" from a slightly-slow clock works.
    if (when.getTime() < Date.now() - 60_000) {
      res
        .status(400)
        .json({ success: false, message: "Reminder time must be in the future" });
      return;
    }

    const list = await TodoListModel.findOne({
      _id: id,
      userId: req.user!.userId,
    }).select("items");
    const item = list?.items.find((i) => String(i._id) === itemId);
    if (!list || !item) {
      res.status(404).json({ success: false, message: "Item not found" });
      return;
    }
    if (item.done) {
      res.status(400).json({
        success: false,
        message: "That item is already done",
      });
      return;
    }

    const reminder = await TodoReminderModel.findOneAndUpdate(
      { listId: list._id, itemId: item._id },
      { $set: { remindAt: when, userId: req.user!.userId }, $unset: { sentAt: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({
      success: true,
      message: "Reminder set",
      data: {
        reminder: {
          listId: reminder.listId,
          itemId: reminder.itemId,
          remindAt: reminder.remindAt,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

export const clearTodoReminder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id, itemId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(itemId)) {
      res.json({ success: true, message: "Reminder cleared" });
      return;
    }
    // Scoped to the caller, so one user can't clear another's reminder.
    await TodoReminderModel.deleteOne({
      listId: id,
      itemId,
      userId: req.user!.userId,
    });
    res.json({ success: true, message: "Reminder cleared" });
  } catch (err) {
    next(err);
  }
};

/**
 * CRON — send every to-do reminder whose time has arrived.
 *
 * Each reminder is claimed atomically (sentAt unset → set) before notifying,
 * so overlapping cron runs can't double-send.
 */
export const runTodoReminderSweep = async (): Promise<{ sent: number }> => {
  const now = new Date();
  const due = await TodoReminderModel.find({
    sentAt: { $exists: false },
    remindAt: { $lte: now },
  })
    .limit(500)
    .lean();
  if (due.length === 0) return { sent: 0 };

  const lists = await TodoListModel.find({
    _id: { $in: due.map((d) => d.listId) },
  })
    .select("title items")
    .lean();
  const listById = new Map(lists.map((l) => [String(l._id), l]));

  let sent = 0;
  for (const reminder of due) {
    const claimed = await TodoReminderModel.updateOne(
      { _id: reminder._id, sentAt: { $exists: false } },
      { $set: { sentAt: now } },
    );
    if (claimed.modifiedCount === 0) continue; // another run got it

    const list = listById.get(String(reminder.listId));
    const item = list?.items.find(
      (i) => String(i._id) === String(reminder.itemId),
    );
    // List/item deleted, or already ticked off → consume silently.
    if (!list || !item || item.done) continue;

    await createNotification(
      String(reminder.userId),
      `Reminder: "${item.text}" (${list.title})`,
      "todo_reminder",
      { listId: String(list._id), itemId: String(item._id), text: item.text },
    );
    sent += 1;
  }
  return { sent };
};