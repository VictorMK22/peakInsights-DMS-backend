import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import { TodoListModel } from "../models/TodoList";

// ─────────────────────────────────────────────────────────────────
// Personal to-do lists. Every query is scoped to the signed-in user,
// so one user can never read or change another user's lists.
// ─────────────────────────────────────────────────────────────────

const parseDate = (v: unknown): Date | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const cleanItems = (raw: unknown) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i: any) => {
      const text = typeof i === "string" ? i : i?.text;
      if (typeof text !== "string" || !text.trim()) return null;
      const dueDate = i?.dueDate ? parseDate(i.dueDate) : null;
      return {
        ...(i?._id && mongoose.isValidObjectId(i._id) ? { _id: i._id } : {}),
        text: text.trim().slice(0, 500),
        done: !!i?.done,
        completedAt: i?.done ? (parseDate(i?.completedAt) ?? new Date()) : undefined,
        dueDate: dueDate ?? undefined,
      };
    })
    .filter(Boolean);
};

const findOwned = async (req: AuthRequest, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ success: false, message: "To-do list not found" });
    return null;
  }
  const list = await TodoListModel.findOne({
    _id: req.params.id,
    userId: req.user!.userId,
  });
  if (!list) {
    res.status(404).json({ success: false, message: "To-do list not found" });
    return null;
  }
  return list;
};

export const createTodoList = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { title, description, startDate, endDate, items } = req.body;

    if (typeof title !== "string" || !title.trim()) {
      res.status(400).json({ success: false, message: "title is required" });
      return;
    }
    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (!start || !end) {
      res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
      return;
    }
    if (end < start) {
      res.status(400).json({
        success: false,
        message: "endDate must be on or after startDate",
      });
      return;
    }

    const list = await TodoListModel.create({
      userId: req.user!.userId,
      title: title.trim(),
      description: typeof description === "string" ? description : undefined,
      startDate: start,
      endDate: end,
      items: cleanItems(items),
    });

    res.status(201).json({
      success: true,
      message: "To-do list created",
      data: { list },
    });
  } catch (err) {
    next(err);
  }
};

export const getMyTodoLists = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { userId: req.user!.userId };
    // Lists whose period overlaps [from, to]
    const f = from ? parseDate(from) : null;
    const t = to ? parseDate(to) : null;
    if (f) filter["endDate"] = { $gte: f };
    if (t) filter["startDate"] = { $lte: t };

    const lists = await TodoListModel.find(filter).sort({
      startDate: 1,
      createdAt: -1,
    });
    res.json({
      success: true,
      message: "To-do lists retrieved",
      data: { lists },
    });
  } catch (err) {
    next(err);
  }
};

export const updateTodoList = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const list = await findOwned(req, res);
    if (!list) return;

    const { title, description, startDate, endDate, items } = req.body;

    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        res.status(400).json({ success: false, message: "title is required" });
        return;
      }
      list.title = title.trim();
    }
    if (description !== undefined) list.description = description || undefined;

    const start = startDate !== undefined ? parseDate(startDate) : list.startDate;
    const end = endDate !== undefined ? parseDate(endDate) : list.endDate;
    if (!start || !end) {
      res.status(400).json({ success: false, message: "Invalid date" });
      return;
    }
    if (end < start) {
      res.status(400).json({
        success: false,
        message: "endDate must be on or after startDate",
      });
      return;
    }
    list.startDate = start;
    list.endDate = end;

    if (items !== undefined) list.set("items", cleanItems(items));

    await list.save();
    res.json({ success: true, message: "To-do list updated", data: { list } });
  } catch (err) {
    next(err);
  }
};

/** Tick / untick a single item without resending the whole list. */
export const toggleTodoItem = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const list = await findOwned(req, res);
    if (!list) return;

    const item = list.items.find((i) => String(i._id) === req.params.itemId);
    if (!item) {
      res.status(404).json({ success: false, message: "Item not found" });
      return;
    }
    const done =
      typeof req.body?.done === "boolean" ? req.body.done : !item.done;
    item.done = done;
    item.completedAt = done ? new Date() : undefined;

    await list.save();
    res.json({ success: true, message: "Item updated", data: { list } });
  } catch (err) {
    next(err);
  }
};

export const deleteTodoList = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const list = await findOwned(req, res);
    if (!list) return;
    await list.deleteOne();
    res.json({ success: true, message: "To-do list deleted" });
  } catch (err) {
    next(err);
  }
};