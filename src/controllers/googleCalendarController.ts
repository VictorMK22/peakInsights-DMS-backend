import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../types/auth";
import { MeetingModel } from "../models/Meeting";
import {
  GoogleCalendarAccountModel,
  setTokens,
  getRefreshToken,
} from "../models/GoogleCalendarAccount";
import {
  isGoogleCalendarConfigured,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleEmail,
  revokeGoogleToken,
  listGoogleEventsForDisplay,
  GoogleCalendarEventView,
} from "../services/googleCalendarService";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const signState = (userId: string) => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  return jwt.sign(
    { userId, purpose: "google_calendar_connect" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );
};

const verifyState = (state: string): string => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  const decoded = jwt.verify(state, process.env.JWT_SECRET) as {
    userId: string;
    purpose: string;
  };
  if (decoded.purpose !== "google_calendar_connect")
    throw new Error("Invalid state");
  return decoded.userId;
};

// GET /integrations/google-calendar/connect — authenticated. Returns an
// authUrl for the frontend to open (can't redirect directly since this
// call carries our own JWT as a header, not something a plain browser
// navigation to Google would have anywhere to put).
export const connectGoogleCalendar = (req: AuthRequest, res: Response) => {
  if (!isGoogleCalendarConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        "Google Calendar isn't configured on the server (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)",
    });
  }
  const state = signState(req.user!.userId);
  return res.json({
    success: true,
    data: { authUrl: buildGoogleAuthUrl(state) },
  });
};

// GET /integrations/google-calendar/callback — PUBLIC. Google redirects
// the user's browser here directly after they accept/deny consent.
export const googleCalendarCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.redirect(`${FRONTEND_URL}/profile?google_calendar=denied`);
  }

  try {
    const userId = verifyState(state);
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Happens if the user previously connected without revoking
      // access first — Google only issues a refresh token on the
      // *first* consent for a given client/user pair.
      return res.redirect(
        `${FRONTEND_URL}/profile?google_calendar=reauth_required`,
      );
    }
    const googleEmail = await fetchGoogleEmail(tokens.access_token);

    const account =
      (await GoogleCalendarAccountModel.findOne({ userId })) ||
      new GoogleCalendarAccountModel({ userId });

    account.googleEmail = googleEmail;
    setTokens(
      account,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
    );
    account.status = "connected";
    account.lastError = undefined;
    await account.save();

    return res.redirect(`${FRONTEND_URL}/profile?google_calendar=connected`);
  } catch (err) {
    console.error("Google Calendar OAuth callback failed:", err);
    return res.redirect(`${FRONTEND_URL}/profile?google_calendar=error`);
  }
};

// GET /integrations/google-calendar/status
export const getGoogleCalendarStatus = async (
  req: AuthRequest,
  res: Response,
) => {
  const account = await GoogleCalendarAccountModel.findOne({
    userId: req.user!.userId,
  }).select("googleEmail status lastError");
  return res.json({
    success: true,
    data: {
      configured: isGoogleCalendarConfigured(),
      account: account || null,
    },
  });
};

// POST /integrations/google-calendar/disconnect
export const disconnectGoogleCalendar = async (
  req: AuthRequest,
  res: Response,
) => {
  // Revoke the grant at Google and delete the stored tokens, rather
  // than just flagging the row — a "disconnected" account shouldn't keep
  // a working refresh token sitting in our database.
  const account = await GoogleCalendarAccountModel.findOne({
    userId: req.user!.userId,
  });
  if (account) {
    try {
      await revokeGoogleToken(getRefreshToken(account));
    } catch {
      /* token undecryptable or already revoked — proceed to delete */
    }
    await account.deleteOne();
  }
  return res.json({ success: true });
};


const MAX_EVENTS_RANGE_DAYS = 100;
const SAME_SLOT_MS = 60_000;

/**
 * Drops Google events that are really an in-app meeting the user was
 * invited to. Their calendar holds a copy of every Meet/meeting event
 * the organizer created (the copy isn't tagged as ours), and the app's
 * own calendar already draws that meeting — so match by event id, or by
 * title + identical time window, and hide the duplicate.
 */
export function dropEventsAlreadyShownAsMeetings(
  events: GoogleCalendarEventView[],
  meetings: { title: string; startTime: Date; endTime: Date; googleEventId?: string }[],
): GoogleCalendarEventView[] {
  const ids = new Set(
    meetings.map((m) => m.googleEventId).filter((x): x is string => !!x),
  );
  return events.filter((ev) => {
    if (ids.has(ev.id)) return false;
    if (ev.allDay) return true;
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    return !meetings.some(
      (m) =>
        m.title.trim().toLowerCase() === ev.title.trim().toLowerCase() &&
        Math.abs(m.startTime.getTime() - s) < SAME_SLOT_MS &&
        Math.abs(m.endTime.getTime() - e) < SAME_SLOT_MS,
    );
  });
}

// GET /integrations/google-calendar/events?from=&to= — the signed-in
// user's OWN Google events in a date range, for the in-app calendar.
// Only ever returns the caller's calendar. Google errors are reported in
// the body (HTTP 200) so a flaky Google never breaks the Meetings page.
export const getGoogleCalendarEvents = async (
  req: AuthRequest,
  res: Response,
) => {
  const from = new Date(String(req.query.from ?? ""));
  const to = new Date(String(req.query.to ?? ""));
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    to <= from
  ) {
    return res.status(400).json({
      success: false,
      message: "from and to must be valid dates, with to after from",
    });
  }
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_EVENTS_RANGE_DAYS) {
    return res.status(400).json({
      success: false,
      message: `Date range can't exceed ${MAX_EVENTS_RANGE_DAYS} days`,
    });
  }

  const userId = req.user!.userId;
  try {
    const { connected, events } = await listGoogleEventsForDisplay(
      userId,
      from,
      to,
    );
    if (!connected) {
      return res.json({ success: true, data: { connected, events: [] } });
    }
    const meetings = await MeetingModel.find({
      status: { $ne: "cancelled" },
      startTime: { $lt: to },
      endTime: { $gt: from },
      $or: [{ organizer: userId }, { "attendees.userId": userId }],
    })
      .select("title startTime endTime googleEventId")
      .lean();
    return res.json({
      success: true,
      data: {
        connected,
        events: dropEventsAlreadyShownAsMeetings(events, meetings),
      },
    });
  } catch (err: any) {
    console.error(
      "Loading Google Calendar events failed:",
      err?.response?.data || err?.message || err,
    );
    return res.json({
      success: true,
      data: {
        connected: true,
        events: [],
        error: "Couldn't load your Google Calendar events right now",
      },
    });
  }
};