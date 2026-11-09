import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import { AuthRequest } from "../types/auth";
import Notification from "../models/Notification";
import { MeetingModel } from "../models/Meeting";
import { createNotification } from "../services/notificationService";

// "Events" are meetings the user organises or is invited to (and hasn't
// declined). Upcoming events stay listed until they end.
const DEFAULT_WINDOW_DAYS = 7;
const DAY_REMINDER_MS = 24 * 60 * 60 * 1000;
const SOON_REMINDER_MS = 60 * 60 * 1000;

const participantFilter = (userId: string) => {
  const uid = new mongoose.Types.ObjectId(userId);
  return {
    status: "scheduled" as const,
    $or: [
      { organizer: uid },
      { attendees: { $elemMatch: { userId: uid, status: { $ne: "declined" } } } },
    ],
  };
};

/**
 * Creates "event coming up" notifications for this user. Done lazily when the
 * app asks for notifications (instead of relying on a cron job that may not
 * be scheduled): one reminder inside 24h, one inside the final hour. Each is
 * keyed by meeting + start time + stage, so it is created once and a
 * rescheduled meeting gets fresh reminders.
 */
const lastSync = new Map<string, number>();
const syncEventReminders = async (userId: string) => {
  const now = Date.now();
  if (now - (lastSync.get(userId) ?? 0) < 60_000) return;
  lastSync.set(userId, now);

  const meetings = await MeetingModel.find({
    ...participantFilter(userId),
    startTime: { $gt: new Date(now), $lte: new Date(now + DAY_REMINDER_MS) },
  })
    .select("title startTime")
    .lean();

  for (const m of meetings) {
    const msAway = new Date(m.startTime).getTime() - now;
    const stage = msAway <= SOON_REMINDER_MS ? "soon" : "day";
    const startIso = new Date(m.startTime).toISOString();
    const exists = await Notification.exists({
      userId,
      type: "event_reminder",
      "meta.meetingId": String(m._id),
      "meta.startTime": startIso,
      "meta.stage": stage,
    });
    if (exists) continue;
    const mins = Math.max(1, Math.round(msAway / 60000));
    const when =
      stage === "soon"
        ? `starts in ${mins} minute${mins === 1 ? "" : "s"}`
        : `is coming up on ${new Date(m.startTime).toUTCString()}`;
    await createNotification(
      userId,
      `Upcoming event: "${m.title}" ${when}`,
      "event_reminder",
      { meetingId: String(m._id), startTime: startIso, stage },
    );
  }
};

// GET /api/notifications
export const listNotifications = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.userId;
    await syncEventReminders(userId).catch((e) =>
      console.error("❌ syncEventReminders:", e),
    );
    const limit = Math.min(100, parseInt(String(req.query.limit ?? "30"), 10) || 30);
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ userId, read: false }),
    ]);
    res.json({ success: true, data: { notifications, unreadCount } });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/notifications/:id/read
export const markNotificationRead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!.userId },
      { read: true },
      { new: true },
    );
    if (!n) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: n });
  } catch (err) {
    next(err);
    return;
  }
};

// POST /api/notifications/read-all
export const markAllNotificationsRead = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    await Notification.updateMany(
      { userId: req.user!.userId, read: false },
      { read: true },
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// GET /api/notifications/upcoming-events?days=7
// What the dashboard shows: events starting within the window, plus any that
// are in progress. An event drops off as soon as it has ended.
export const getUpcomingEvents = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.userId;
    const days = Math.min(
      30,
      Math.max(1, parseInt(String(req.query.days ?? DEFAULT_WINDOW_DAYS), 10) || DEFAULT_WINDOW_DAYS),
    );
    const now = new Date();
    const events = await MeetingModel.find({
      ...participantFilter(userId),
      endTime: { $gt: now },
      startTime: { $lte: new Date(now.getTime() + days * 86_400_000) },
    })
      .select("title startTime endTime location meetingLink organizer")
      .populate("organizer", "name")
      .sort({ startTime: 1 })
      .limit(20)
      .lean();

    res.json({
      success: true,
      data: {
        now: now.toISOString(),
        events: events.map((e) => ({
          ...e,
          inProgress: new Date(e.startTime) <= now,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};