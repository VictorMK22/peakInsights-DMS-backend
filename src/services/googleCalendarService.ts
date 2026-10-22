import axios from "axios";
import {
  GoogleCalendarAccountModel,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from "../models/GoogleCalendarAccount";

// ═════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR API CLIENT
// ═════════════════════════════════════════════════════════════════
// Used for three things, all on the connecting user's own "primary"
// calendar and all within the single `calendar.events` scope:
//   1. Creating a real, clickable Google Meet link when a staff member
//      schedules a meeting in-app (Calendar event + conferenceData).
//   2. Mirroring "Mark Unavailable" blocks onto their Google Calendar
//      as private busy events, so the block shows up in Google too.
//   3. Reading their existing Google events (as bare busy/free time
//      windows — titles are never exposed to other users) so meeting
//      conflict checks respect the calendar they actually live in.
//
// Docs: https://developers.google.com/calendar/api/v3/reference/events/insert
//       https://developers.google.com/calendar/api/guides/create-events#video-conferencing
//
// Required env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI   — e.g. https://yourdomain.com/api/integrations/google-calendar/callback
//                            (must be registered exactly in the Google Cloud Console
//                            OAuth client's "Authorized redirect URIs")
// ═════════════════════════════════════════════════════════════════

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// Narrow, single-purpose scope: only the events this app itself
// creates on the "primary" calendar (readable in full so we can also
// patch/delete the specific event later), nothing else on the user's
// calendar and no access to other Google data.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const HTTP_TIMEOUT_MS = 8000;
// Reads sit on the request path of the conflict checker, so they get a
// tighter budget and fail open (treated as "no extra busy time").
const READ_TIMEOUT_MS = 4000;

// Stamped on every event this app creates (Meet events and busy blocks),
// so that when we read a user's calendar back we can tell our own events
// from theirs and not double-count them.
export const APP_EVENT_TAG = { peakinsightsHub: "1" };

export const isGoogleCalendarConfigured = () =>
  Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID || "",
    redirect_uri: REDIRECT_URI || "",
    response_type: "code",
    scope: SCOPES,
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // required every time to reliably get one back
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  scope: string;
  token_type: string;
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<TokenResponse> {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: CLIENT_ID || "",
      client_secret: CLIENT_SECRET || "",
      redirect_uri: REDIRECT_URI || "",
      grant_type: "authorization_code",
    }),
  );
  return res.data;
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID || "",
      client_secret: CLIENT_SECRET || "",
      grant_type: "refresh_token",
    }),
  );
  return res.data;
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (res.data?.email || "").toLowerCase();
}

export interface CreateMeetEventInput {
  accessToken: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  attendeeEmails?: string[];
}

export interface CreateMeetEventResult {
  eventId: string;
  hangoutLink: string;
  htmlLink: string;
}

/**
 * Creates a Calendar event with a Google Meet conference attached and
 * returns the meet.google.com link. `conferenceDataVersion=1` is what
 * tells the API to actually honor conferenceData.createRequest — it's
 * silently ignored without that query param.
 */
export async function createMeetEvent(
  input: CreateMeetEventInput,
): Promise<CreateMeetEventResult> {
  const requestId = `peakinsights-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const res = await axios.post(
    `${CALENDAR_API}/calendars/primary/events`,
    {
      summary: input.title,
      description: input.description,
      start: { dateTime: input.startTime.toISOString() },
      end: { dateTime: input.endTime.toISOString() },
      attendees: (input.attendeeEmails ?? []).map((email) => ({ email })),
      extendedProperties: { private: APP_EVENT_TAG },
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
    {
      params: {
        conferenceDataVersion: 1,
        // Attendees are informational on our side (we send our own
        // invite emails) — don't ask Google to email them too.
        sendUpdates: "none",
      },
      headers: { Authorization: `Bearer ${input.accessToken}` },
      timeout: HTTP_TIMEOUT_MS,
    },
  );

  const hangoutLink: string | undefined = res.data?.hangoutLink;
  if (!hangoutLink) {
    throw new Error(
      "Google did not return a Meet link for this event (conference creation may still be pending)",
    );
  }

  return {
    eventId: res.data.id,
    hangoutLink,
    htmlLink: res.data.htmlLink,
  };
}

export interface UpdateMeetEventInput {
  accessToken: string;
  eventId: string;
  title?: string;
  startTime?: Date;
  endTime?: Date;
}

/** Best-effort — keeps the Google Calendar event's time in sync when a
 *  meeting is rescheduled. Failures are caught by the caller. */
export async function updateMeetEventTime(
  input: UpdateMeetEventInput,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.summary = input.title;
  if (input.startTime)
    patch.start = { dateTime: input.startTime.toISOString() };
  if (input.endTime) patch.end = { dateTime: input.endTime.toISOString() };
  if (Object.keys(patch).length === 0) return;

  await axios.patch(
    `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
    patch,
    {
      params: { sendUpdates: "none" },
      headers: { Authorization: `Bearer ${input.accessToken}` },
      timeout: HTTP_TIMEOUT_MS,
    },
  );
}

/**
 * Returns a currently-valid access token for a user's connected Google
 * account, transparently refreshing it first if it's expired (or about
 * to, within a minute of skew). Returns null if the user has never
 * connected a Google account or the connection needs re-authorizing.
 */
export async function getValidGoogleAccessToken(
  userId: string,
): Promise<string | null> {
  const account = await GoogleCalendarAccountModel.findOne({
    userId,
    status: "connected",
  });
  if (!account) return null;

  const expiringSoon = account.tokenExpiresAt.getTime() - 60_000 < Date.now();
  if (!expiringSoon) return getAccessToken(account);

  try {
    const refreshed = await refreshGoogleAccessToken(getRefreshToken(account));
    setTokens(
      account,
      refreshed.access_token,
      refreshed.refresh_token,
      refreshed.expires_in,
    );
    account.status = "connected";
    account.lastError = undefined;
    await account.save();
    return refreshed.access_token;
  } catch (err: any) {
    account.status = "error";
    account.lastError =
      err?.response?.data?.error_description ||
      err?.message ||
      "Refresh failed";
    await account.save();
    return null;
  }
}

/** Deletes a Calendar event from the user's primary calendar. Treats
 *  "already gone" (404/410) as success so cleanup is safe to repeat. */
export async function deleteMeetEvent(
  accessToken: string,
  eventId: string,
): Promise<void> {
  try {
    await axios.delete(
      `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(eventId)}`,
      {
        params: { sendUpdates: "none" },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: HTTP_TIMEOUT_MS,
      },
    );
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 410) return;
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════
// MEETINGS — mirror every saved meeting onto the organizer's calendar
// ═════════════════════════════════════════════════════════════════

export interface MeetingEventFields {
  title: string;
  description?: string;
  location?: string;
  startTime: Date;
  endTime: Date;
  /** Everyone else invited (internal + external). Google adds the event
   *  to their calendar silently — sendUpdates is "none" because this app
   *  sends its own invitation emails. */
  attendeeEmails?: string[];
  reminderMinutes?: number;
}

const meetingEventBody = (f: MeetingEventFields) => ({
  summary: f.title,
  // Always sent (even empty) so clearing a field in the app clears it in
  // Google too, rather than leaving the old text behind on a patch.
  description: f.description ?? "",
  location: f.location ?? "",
  start: { dateTime: f.startTime.toISOString() },
  end: { dateTime: f.endTime.toISOString() },
  attendees: (f.attendeeEmails ?? []).map((email) => ({ email })),
  reminders:
    typeof f.reminderMinutes === "number" && f.reminderMinutes >= 0
      ? {
          useDefault: false,
          overrides: [
            {
              method: "popup",
              minutes: Math.min(Math.round(f.reminderMinutes), 40320),
            },
          ],
        }
      : { useDefault: true },
  extendedProperties: { private: APP_EVENT_TAG },
});

/** Creates a plain (no Meet conference) event for a saved meeting. */
export async function createMeetingEvent(
  input: { accessToken: string } & MeetingEventFields,
): Promise<{ eventId: string; htmlLink: string }> {
  const res = await axios.post(
    `${CALENDAR_API}/calendars/primary/events`,
    meetingEventBody(input),
    {
      params: { sendUpdates: "none" },
      headers: { Authorization: `Bearer ${input.accessToken}` },
      timeout: HTTP_TIMEOUT_MS,
    },
  );
  return { eventId: res.data.id, htmlLink: res.data.htmlLink };
}

/** Rewrites an existing meeting event to match the app. Returns "gone"
 *  if the event no longer exists on Google's side (so the caller can
 *  create a fresh one instead of silently losing the meeting). */
export async function updateMeetingEvent(
  input: { accessToken: string; eventId: string } & MeetingEventFields,
): Promise<"updated" | "gone"> {
  try {
    await axios.patch(
      `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(input.eventId)}`,
      meetingEventBody(input),
      {
        // Keeps an attached Meet conference intact while patching.
        params: { sendUpdates: "none", conferenceDataVersion: 1 },
        headers: { Authorization: `Bearer ${input.accessToken}` },
        timeout: HTTP_TIMEOUT_MS,
      },
    );
    return "updated";
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404 || status === 410) return "gone";
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════
// BUSY BLOCKS — mirror a "Mark Unavailable" block onto Google Calendar
// ═════════════════════════════════════════════════════════════════

export interface CreateBusyEventInput {
  accessToken: string;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
}

/** Creates a private, opaque ("busy") event on the user's primary
 *  calendar. No attendees, no Meet link, no emails sent. */
export async function createBusyEvent(
  input: CreateBusyEventInput,
): Promise<{ eventId: string; htmlLink: string }> {
  const res = await axios.post(
    `${CALENDAR_API}/calendars/primary/events`,
    {
      summary: input.title,
      description: input.description,
      start: { dateTime: input.startTime.toISOString() },
      end: { dateTime: input.endTime.toISOString() },
      transparency: "opaque",
      visibility: "private",
      reminders: { useDefault: false },
      extendedProperties: { private: APP_EVENT_TAG },
    },
    {
      params: { sendUpdates: "none" },
      headers: { Authorization: `Bearer ${input.accessToken}` },
      timeout: HTTP_TIMEOUT_MS,
    },
  );
  return { eventId: res.data.id, htmlLink: res.data.htmlLink };
}

// ═════════════════════════════════════════════════════════════════
// BUSY TIME — read the user's Google events as bare time windows
// ═════════════════════════════════════════════════════════════════

export interface GoogleBusyWindow {
  start: Date;
  end: Date;
}

/** The subset of a Calendar API event resource we read. */
export interface GoogleEventLike {
  id?: string;
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

/**
 * Turns raw Calendar events into the windows that should count as
 * "busy". Pure function (no I/O) so the rules are easy to test:
 *   - cancelled events, and events marked "free" (transparent): skipped
 *   - events the user has declined: skipped
 *   - events this app created (tagged): skipped — they're already
 *     counted from our own meetings / calendar blocks
 *   - all-day events: skipped (birthdays, holidays and reminders would
 *     otherwise block the whole day), except Google "Out of office"
 */
export function parseGoogleBusyEvents(
  items: GoogleEventLike[],
): GoogleBusyWindow[] {
  const windows: GoogleBusyWindow[] = [];
  for (const ev of items) {
    if (ev.status === "cancelled") continue;
    if (ev.transparency === "transparent") continue;
    if (ev.extendedProperties?.private?.peakinsightsHub === APP_EVENT_TAG.peakinsightsHub)
      continue;
    if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined"))
      continue;

    const startStr = ev.start?.dateTime ?? ev.start?.date;
    const endStr = ev.end?.dateTime ?? ev.end?.date;
    if (!startStr || !endStr) continue;

    const isAllDay = !ev.start?.dateTime;
    if (isAllDay && ev.eventType !== "outOfOffice") continue;

    const start = new Date(startStr);
    const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end <= start) continue;
    windows.push({ start, end });
  }
  return windows;
}

const BUSY_CACHE_TTL_MS = 60_000;
const BUSY_FAILURE_TTL_MS = 30_000;
const busyCache = new Map<
  string,
  { at: number; ttl: number; windows: GoogleBusyWindow[] }
>();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The user's Google Calendar busy windows overlapping [from, to].
 * Never throws: if Google is unreachable, the token has lapsed, or the
 * user isn't connected, this returns [] so scheduling keeps working off
 * our own data. Results are cached per user for a minute (on a
 * day-aligned window) because the live conflict check fires repeatedly
 * as someone edits the meeting form.
 */
export async function getGoogleBusyWindows(
  userId: string,
  from: Date,
  to: Date,
): Promise<GoogleBusyWindow[]> {
  if (!isGoogleCalendarConfigured()) return [];

  const dayFrom = new Date(Math.floor(from.getTime() / DAY_MS) * DAY_MS);
  const dayTo = new Date(Math.ceil(to.getTime() / DAY_MS) * DAY_MS);
  const key = `${userId}|${dayFrom.getTime()}|${dayTo.getTime()}`;

  const cached = busyCache.get(key);
  let windows: GoogleBusyWindow[];
  if (cached && Date.now() - cached.at < cached.ttl) {
    windows = cached.windows;
  } else {
    try {
      const accessToken = await getValidGoogleAccessToken(userId);
      if (!accessToken) return [];
      const res = await axios.get(
        `${CALENDAR_API}/calendars/primary/events`,
        {
          params: {
            timeMin: dayFrom.toISOString(),
            timeMax: dayTo.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 250,
            fields:
              "items(id,status,transparency,eventType,start,end,attendees(self,responseStatus),extendedProperties/private)",
          },
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: READ_TIMEOUT_MS,
        },
      );
      windows = parseGoogleBusyEvents(res.data?.items ?? []);
      busyCache.set(key, { at: Date.now(), ttl: BUSY_CACHE_TTL_MS, windows });
    } catch (err: any) {
      console.warn(
        "Google Calendar busy-time read failed (ignored):",
        err?.response?.data?.error?.message || err?.message || err,
      );
      busyCache.set(key, { at: Date.now(), ttl: BUSY_FAILURE_TTL_MS, windows: [] });
      windows = [];
    }
    if (busyCache.size > 500) busyCache.clear();
  }

  return windows.filter((w) => w.start < to && w.end > from);
}

/** Best-effort: tells Google to revoke the grant. Never throws. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await axios.post(
      "https://oauth2.googleapis.com/revoke",
      new URLSearchParams({ token }),
      { timeout: HTTP_TIMEOUT_MS },
    );
  } catch {
    /* already revoked / expired — nothing more to do */
  }
}


// ═════════════════════════════════════════════════════════════════
// CALENDAR VIEW — the user's own Google events, for display in-app
// ═════════════════════════════════════════════════════════════════

export interface GoogleCalendarEventView {
  id: string;
  title: string;
  /** ISO date-time, or a plain YYYY-MM-DD date for all-day events. */
  start: string;
  /** Exclusive end, same format as `start`. */
  end: string;
  allDay: boolean;
  location?: string;
  htmlLink?: string;
  meetLink?: string;
  /** Marked "free" in Google (doesn't block time). */
  free: boolean;
}

export interface GoogleDisplayEventLike extends GoogleEventLike {
  summary?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
}

/**
 * Raw Calendar events -> what the in-app calendar draws. Unlike the
 * busy-time reader this keeps titles (it's the owner's own calendar) and
 * keeps free/all-day events, but still drops cancelled and declined
 * events and anything this app created (those are already shown as the
 * app's own meetings and unavailability blocks). Pure, so it's testable.
 */
export function parseGoogleEventsForDisplay(
  items: GoogleDisplayEventLike[],
): GoogleCalendarEventView[] {
  const out: GoogleCalendarEventView[] = [];
  for (const ev of items) {
    if (!ev.id || ev.status === "cancelled") continue;
    if (ev.extendedProperties?.private?.peakinsightsHub === APP_EVENT_TAG.peakinsightsHub)
      continue;
    if (ev.attendees?.some((a) => a.self && a.responseStatus === "declined"))
      continue;

    const start = ev.start?.dateTime ?? ev.start?.date;
    const end = ev.end?.dateTime ?? ev.end?.date;
    if (!start || !end) continue;
    if (Number.isNaN(new Date(start).getTime())) continue;

    out.push({
      id: ev.id,
      title: ev.summary?.trim() || "(No title)",
      start,
      end,
      allDay: !ev.start?.dateTime,
      location: ev.location || undefined,
      htmlLink: ev.htmlLink || undefined,
      meetLink: ev.hangoutLink || undefined,
      free: ev.transparency === "transparent",
    });
  }
  return out;
}

/** The user's primary-calendar events in [from, to], for display.
 *  Throws on Google errors (the controller decides how to report them). */
export async function listGoogleEventsForDisplay(
  userId: string,
  from: Date,
  to: Date,
): Promise<{ connected: boolean; events: GoogleCalendarEventView[] }> {
  if (!isGoogleCalendarConfigured()) return { connected: false, events: [] };
  const accessToken = await getValidGoogleAccessToken(userId);
  if (!accessToken) return { connected: false, events: [] };

  const items: GoogleDisplayEventLike[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const res = await axios.get(`${CALENDAR_API}/calendars/primary/events`, {
      params: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
        fields:
          "nextPageToken,items(id,status,summary,location,htmlLink,hangoutLink,transparency,eventType,start,end,attendees(self,responseStatus),extendedProperties/private)",
      },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: HTTP_TIMEOUT_MS,
    });
    items.push(...(res.data?.items ?? []));
    pageToken = res.data?.nextPageToken;
    if (!pageToken) break;
  }
  return { connected: true, events: parseGoogleEventsForDisplay(items) };
}