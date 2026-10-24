import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../types/auth";
import { MeetingModel } from "../models/Meeting";
import { User } from "../models/User";
import {
  ZohoCalendarAccountModel,
  setTokens,
  getRefreshToken,
} from "../models/ZohoCalendarAccount";
import {
  isZohoCalendarConfigured,
  buildZohoCalendarAuthUrl,
  exchangeCodeForTokens,
  fetchZohoProfileEmail,
  fetchDefaultCalendarUid,
  revokeZohoToken,
  listZohoEventsForDisplay,
  ZohoCalendarEventView,
} from "../services/zohoCalendarService";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const signState = (userId: string) => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  return jwt.sign(
    { userId, purpose: "zoho_calendar_connect" },
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
  if (decoded.purpose !== "zoho_calendar_connect")
    throw new Error("Invalid state");
  return decoded.userId;
};

// GET /integrations/zoho-calendar/connect — authenticated. Returns an
// authUrl for the frontend to redirect to (can't redirect directly since
// this call carries our own JWT as a header, which a plain browser
// navigation to Zoho wouldn't have anywhere to put).
export const connectZohoCalendar = (req: AuthRequest, res: Response) => {
  if (!isZohoCalendarConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        "Zoho Calendar isn't configured on the server (missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_CALENDAR_REDIRECT_URI)",
    });
  }
  return res.json({
    success: true,
    data: { authUrl: buildZohoCalendarAuthUrl(signState(req.user!.userId)) },
  });
};

// GET /integrations/zoho-calendar/callback — PUBLIC. Zoho redirects the
// user's browser here directly after they accept/deny consent.
export const zohoCalendarCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.redirect(`${FRONTEND_URL}/profile?zoho_calendar=denied`);
  }

  try {
    const userId = verifyState(state);
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Zoho only issues a refresh token on consent; without one the
      // connection would die within the hour.
      return res.redirect(
        `${FRONTEND_URL}/profile?zoho_calendar=reauth_required`,
      );
    }
    const calendarUid = await fetchDefaultCalendarUid(tokens.access_token);
    // Prefer what Zoho says; fall back to the staff member's own login
    // email (which is their Zoho address).
    const zohoEmail =
      (await fetchZohoProfileEmail(tokens.access_token)) ||
      (await User.findById(userId).select("email").lean())?.email ||
      "unknown";

    const account =
      (await ZohoCalendarAccountModel.findOne({ userId })) ||
      new ZohoCalendarAccountModel({ userId });

    account.zohoEmail = zohoEmail;
    account.calendarUid = calendarUid;
    setTokens(
      account,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
    );
    account.status = "connected";
    account.lastError = undefined;
    await account.save();

    return res.redirect(`${FRONTEND_URL}/profile?zoho_calendar=connected`);
  } catch (err) {
    console.error("Zoho Calendar OAuth callback failed:", err);
    return res.redirect(`${FRONTEND_URL}/profile?zoho_calendar=error`);
  }
};

// GET /integrations/zoho-calendar/status
export const getZohoCalendarStatus = async (req: AuthRequest, res: Response) => {
  const account = await ZohoCalendarAccountModel.findOne({
    userId: req.user!.userId,
  }).select("zohoEmail status lastError");
  return res.json({
    success: true,
    data: {
      configured: isZohoCalendarConfigured(),
      account: account || null,
    },
  });
};

// POST /integrations/zoho-calendar/disconnect
export const disconnectZohoCalendar = async (
  req: AuthRequest,
  res: Response,
) => {
  // Revoke the grant at Zoho and delete the stored tokens, rather than
  // just flagging the row — a "disconnected" account shouldn't keep a
  // working refresh token sitting in our database.
  const account = await ZohoCalendarAccountModel.findOne({
    userId: req.user!.userId,
  });
  if (account) {
    try {
      await revokeZohoToken(getRefreshToken(account));
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
 * Drops Zoho events that are really an in-app meeting (or block) the user
 * already sees drawn natively: the organizer's own event for it, or the
 * copy on an invitee's calendar. Matched by event uid, or failing that by
 * title + identical time window.
 */
export function dropEventsAlreadyShownAsMeetings(
  events: ZohoCalendarEventView[],
  known: {
    title: string;
    startTime: Date;
    endTime: Date;
    calendarEventUid?: string;
  }[],
): ZohoCalendarEventView[] {
  const uids = new Set(
    known.map((m) => m.calendarEventUid).filter((x): x is string => !!x),
  );
  return events.filter((ev) => {
    if (uids.has(ev.uid)) return false;
    if (ev.allDay) return true;
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    return !known.some(
      (m) =>
        m.title.trim().toLowerCase() === ev.title.trim().toLowerCase() &&
        Math.abs(m.startTime.getTime() - s) < SAME_SLOT_MS &&
        Math.abs(m.endTime.getTime() - e) < SAME_SLOT_MS,
    );
  });
}

// GET /integrations/zoho-calendar/events?from=&to= — the signed-in user's
// OWN Zoho events in a date range, for the in-app calendar. Only ever
// returns the caller's calendar. Zoho errors are reported in the body
// (HTTP 200) so a flaky Zoho never breaks the Meetings page.
export const getZohoCalendarEvents = async (req: AuthRequest, res: Response) => {
  const from = new Date(String(req.query.from ?? ""));
  const to = new Date(String(req.query.to ?? ""));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
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
    const { connected, events } = await listZohoEventsForDisplay(
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
      .select("title startTime endTime calendarEventUid")
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
      "Loading Zoho Calendar events failed:",
      err?.response?.data || err?.message || err,
    );
    return res.json({
      success: true,
      data: {
        connected: true,
        events: [],
        error: "Couldn't load your Zoho Calendar events right now",
      },
    });
  }
};