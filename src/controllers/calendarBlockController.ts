import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { CalendarBlockModel } from "../models/CalendarBlock";
import {
  getZohoCalendarSession,
  createBusyEvent,
  deleteZohoEvent,
} from "../services/zohoCalendarService";

// ─────────────────────────────────────────────────────────────────
// Personal calendar blocks — a user marking themselves unavailable
// (out-of-office, focus time, personal appointment). These are
// private to the owning user; other users only ever see them
// indirectly, as a conflict when scheduling a meeting.
//
// If the user has connected Zoho Calendar, a block is also mirrored
// onto their Zoho Calendar as a private busy event (best-effort: a
// Zoho failure never stops the block from being saved).
// ─────────────────────────────────────────────────────────────────

export const createCalendarBlock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { title, type, startTime, endTime, notes, syncToZoho } =
      req.body as {
        title?: string;
        type?: "busy" | "out_of_office" | "personal";
        startTime: string;
        endTime: string;
        notes?: string;
        syncToZoho?: boolean; // default true when Zoho Calendar is connected
      };

    if (!startTime || !endTime) {
      res.status(400).json({
        success: false,
        message: "startTime and endTime are required",
      });
      return;
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      res
        .status(400)
        .json({ success: false, message: "endTime must be after startTime" });
      return;
    }

    const block = await CalendarBlockModel.create({
      userId: req.user!.userId,
      title: title || "Unavailable",
      type: type ?? "busy",
      startTime: start,
      endTime: end,
      notes,
    });

    // Mirror to Zoho Calendar. Awaited (not fire-and-forget) because
    // on a serverless host the work is cut off once the response is sent.
    let calendarSynced = false;
    if (syncToZoho !== false) {
      try {
        const session = await getZohoCalendarSession(req.user!.userId);
        if (session) {
          const event = await createBusyEvent({
            session,
            title: block.title,
            description: block.notes,
            startTime: start,
            endTime: end,
          });
          block.calendarEventUid = event.uid;
          block.calendarEventEtag = event.etag;
          await block.save();
          calendarSynced = true;
        }
      } catch (err: any) {
        console.error(
          "Mirroring calendar block to Zoho failed (block kept):",
          err?.response?.data || err?.message || err,
        );
      }
    }

    res.status(201).json({
      success: true,
      message: calendarSynced
        ? "Unavailability marked and added to your Zoho Calendar"
        : "Unavailability marked",
      data: { block, calendarSynced },
    });
  } catch (err) {
    next(err);
  }
};

export const getMyCalendarBlocks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { userId: req.user!.userId };
    if (from) filter["endTime"] = { $gt: new Date(from) };
    if (to) filter["startTime"] = { $lt: new Date(to) };

    const blocks = await CalendarBlockModel.find(filter).sort({ startTime: 1 });
    res.json({
      success: true,
      message: "Calendar blocks retrieved",
      data: { blocks },
    });
  } catch (err) {
    next(err);
  }
};

export const deleteCalendarBlock = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const block = await CalendarBlockModel.findById(req.params.id);
    if (!block) {
      res.status(404).json({ success: false, message: "Block not found" });
      return;
    }
    if (String(block.userId) !== req.user!.userId) {
      res.status(403).json({
        success: false,
        message: "You can only remove your own blocks",
      });
      return;
    }
    // Remove the mirrored Zoho event first (best-effort), while we
    // still have its id.
    if (block.calendarEventUid) {
      try {
        const session = await getZohoCalendarSession(req.user!.userId);
        if (session)
          await deleteZohoEvent({
            session,
            uid: block.calendarEventUid,
            etag: block.calendarEventEtag,
          });
      } catch (err: any) {
        console.error(
          "Removing mirrored Zoho event failed (block still deleted):",
          err?.response?.data || err?.message || err,
        );
      }
    }
    await block.deleteOne();
    res.json({ success: true, message: "Unavailability removed" });
  } catch (err) {
    next(err);
  }
};