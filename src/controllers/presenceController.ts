import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import { User } from "../models/User";

/**
 * Presence is heartbeat-based and stored in MongoDB on purpose: the API runs
 * on Vercel serverless, where websockets and in-memory state don't survive
 * between requests (see socket/socketServer.ts, which is opt-in).
 *
 * The app pings POST /presence/heartbeat about once a minute while a tab is
 * open and visible. A user counts as "online" if they were seen within
 * ONLINE_WINDOW_MS — a little over two heartbeats, so one missed ping
 * doesn't flicker them offline.
 */
export const ONLINE_WINDOW_MS = Number(
  process.env.PRESENCE_ONLINE_WINDOW_MS ?? 150_000,
);
const MAX_LISTED = 200;

const onlineSince = () => new Date(Date.now() - ONLINE_WINDOW_MS);

const listOnline = async () => {
  const filter = { isActive: true, lastSeenAt: { $gte: onlineSince() } };
  const [users, count, totalUsers] = await Promise.all([
    User.find(filter)
      .select("name role department profilePicture lastSeenAt")
      .sort({ name: 1 })
      .limit(MAX_LISTED)
      .lean(),
    User.countDocuments(filter),
    User.countDocuments({ isActive: true }),
  ]);
  return { count, totalUsers, users, windowSeconds: ONLINE_WINDOW_MS / 1000 };
};

// POST /api/presence/heartbeat — marks me online and returns who is online,
// so the client needs just one request per tick.
export const heartbeat = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    await User.updateOne(
      { _id: req.user!.userId },
      { $set: { lastSeenAt: new Date() } },
    );
    res.json({ success: true, data: await listOnline() });
  } catch (err) {
    next(err);
  }
};

// GET /api/presence/online — who is online right now (any signed-in role).
export const getOnline = async (
  _req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    res.json({ success: true, data: await listOnline() });
  } catch (err) {
    next(err);
  }
};