import axios from "axios";
import {
  ZohoCalendarAccountModel,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from "../models/ZohoCalendarAccount";

// ═════════════════════════════════════════════════════════════════
// ZOHO CALENDAR API CLIENT
// ═════════════════════════════════════════════════════════════════
// Docs: https://www.zoho.com/calendar/help/api/introduction.html
//
// Used for three things, all on the connecting user's DEFAULT calendar:
//   1. Putting every meeting they organize on their calendar, with a
//      Zoho Meeting link when asked (conference: "zmeeting").
//   2. Mirroring "Mark Unavailable" blocks as private busy events.
//   3. Reading their existing events — as bare busy windows for conflict
//      checks (titles never exposed to others), and in full for showing
//      on their own in-app calendar.
//
// Env vars:
//   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET   the same Zoho API Console client
//        as Zoho Mail works (or set ZOHO_CALENDAR_CLIENT_ID / _SECRET)
//   ZOHO_CALENDAR_REDIRECT_URI   e.g. https://YOUR-API/api/integrations/zoho-calendar/callback
//   ZOHO_ACCOUNTS_DOMAIN         region, e.g. accounts.zoho.com | .eu | .in | .com.au | .jp
//   ZOHO_CALENDAR_API_DOMAIN     optional; defaults to calendar.<region>
//   ZOHO_MEETING_DOMAIN          optional; defaults to meeting.<region>
// ═════════════════════════════════════════════════════════════════

const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || "accounts.zoho.com";
// "accounts.zoho.eu" -> "zoho.eu": every Zoho product lives under the same
// regional suffix, so one setting covers Calendar and Meeting too.
const REGION_SUFFIX = ACCOUNTS_DOMAIN.replace(/^accounts\./, "");
const CALENDAR_API = `https://${
  process.env.ZOHO_CALENDAR_API_DOMAIN || `calendar.${REGION_SUFFIX}`
}/api/v1`;
const MEETING_DOMAIN =
  process.env.ZOHO_MEETING_DOMAIN || `meeting.${REGION_SUFFIX}`;

const CLIENT_ID = process.env.ZOHO_CALENDAR_CLIENT_ID || process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET =
  process.env.ZOHO_CALENDAR_CLIENT_SECRET || process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI = process.env.ZOHO_CALENDAR_REDIRECT_URI;

const HTTP_TIMEOUT_MS = 8000;
// Reads sit on the request path of the conflict checker, so they get a
// tighter budget and fail open (treated as "no extra busy time").
const READ_TIMEOUT_MS = 4000;

// Calendar scopes + Zoho Meeting (needed to attach a meeting to an event)
// + profile (to show which account is connected).
const SCOPES = [
  "ZohoCalendar.calendar.READ",
  "ZohoCalendar.event.ALL",
  "ZohoMeeting.meeting.ALL",
  "AaaServer.profile.READ",
].join(",");

export const isZohoCalendarConfigured = () =>
  Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

// ── OAuth ───────────────────────────────────────────────────────

export function buildZohoCalendarAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID || "",
    response_type: "code",
    redirect_uri: REDIRECT_URI || "",
    scope: SCOPES,
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // required every time to actually get one back
    state,
  });
  return `https://${ACCOUNTS_DOMAIN}/oauth/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
}

/** Thrown when Zoho's token endpoint rejects a request. `transient` means
 *  "try again later, the connection itself is probably still fine". */
export class ZohoCalendarTokenError extends Error {
  constructor(
    message: string,
    public readonly zohoError: string,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "ZohoCalendarTokenError";
  }
}

/** Zoho's token endpoint often answers HTTP 200 with an error body, so
 *  axios never throws; validate here so the real reason surfaces. */
export function parseTokenResponse(data: any): TokenResponse {
  if (!data?.access_token) {
    const code = String(data?.error ?? "no_access_token");
    const detail = data?.error_description ? ` - ${data.error_description}` : "";
    const transient = /access denied|too many|rate/i.test(
      `${code} ${data?.error_description ?? ""}`,
    );
    throw new ZohoCalendarTokenError(
      `Zoho token request failed: ${code}${detail}`,
      code,
      transient,
    );
  }
  // Zoho returns expires_in in seconds on some endpoints, milliseconds
  // on others — normalise to seconds.
  const raw = Number(data.expires_in_sec ?? data.expires_in ?? 3600);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: raw > 100000 ? Math.round(raw / 1000) : raw,
  };
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const res = await axios.post(`https://${ACCOUNTS_DOMAIN}/oauth/v2/token`, null, {
    params: {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    },
    timeout: HTTP_TIMEOUT_MS,
  });
  return parseTokenResponse(res.data);
}

export async function refreshZohoAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await axios.post(`https://${ACCOUNTS_DOMAIN}/oauth/v2/token`, null, {
    params: {
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
    },
    timeout: HTTP_TIMEOUT_MS,
  });
  return parseTokenResponse(res.data);
}

/** Best-effort: tells Zoho to revoke the grant. Never throws. */
export async function revokeZohoToken(refreshToken: string): Promise<void> {
  try {
    await axios.post(`https://${ACCOUNTS_DOMAIN}/oauth/v2/token/revoke`, null, {
      params: { token: refreshToken },
      timeout: HTTP_TIMEOUT_MS,
    });
  } catch {
    /* already revoked / expired — nothing more to do */
  }
}

const authHeader = (accessToken: string) => ({
  Authorization: `Zoho-oauthtoken ${accessToken}`,
});

/** The connected account's email, or null if Zoho won't say (the caller
 *  falls back to the staff member's own login email). */
export async function fetchZohoProfileEmail(
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await axios.get(`https://${ACCOUNTS_DOMAIN}/oauth/user/info`, {
      headers: authHeader(accessToken),
      timeout: HTTP_TIMEOUT_MS,
    });
    return res.data?.Email ? String(res.data.Email) : null;
  } catch {
    return null;
  }
}

/** The uid of the user's default calendar. */
export async function fetchDefaultCalendarUid(
  accessToken: string,
): Promise<string> {
  const res = await axios.get(`${CALENDAR_API}/calendars`, {
    headers: authHeader(accessToken),
    timeout: HTTP_TIMEOUT_MS,
  });
  const calendars: { uid?: string; isdefault?: boolean }[] =
    res.data?.calendars ?? [];
  const chosen = calendars.find((c) => c.isdefault) ?? calendars[0];
  if (!chosen?.uid) throw new Error("No calendar found on this Zoho account");
  return chosen.uid;
}

// ── Session: a usable access token + which calendar to use ──────

export interface ZohoCalendarSession {
  accessToken: string;
  calendarUid: string;
  email: string;
}

/**
 * Returns a valid access token for the user's Zoho Calendar (refreshing
 * it if it's within a minute of expiring), or null if they've never
 * connected or the connection needs re-authorizing. Never throws.
 */
export async function getZohoCalendarSession(
  userId: string,
): Promise<ZohoCalendarSession | null> {
  if (!isZohoCalendarConfigured()) return null;
  const account = await ZohoCalendarAccountModel.findOne({
    userId,
    status: "connected",
  });
  if (!account) return null;

  const session = (accessToken: string): ZohoCalendarSession => ({
    accessToken,
    calendarUid: account.calendarUid,
    email: account.zohoEmail,
  });

  const expiringSoon = account.tokenExpiresAt.getTime() - 60_000 < Date.now();
  if (!expiringSoon) return session(getAccessToken(account));

  try {
    const refreshed = await refreshZohoAccessToken(getRefreshToken(account));
    setTokens(
      account,
      refreshed.access_token,
      refreshed.refresh_token,
      refreshed.expires_in,
    );
    account.status = "connected";
    account.lastError = undefined;
    await account.save();
    return session(refreshed.access_token);
  } catch (err: any) {
    // A transient hiccup (rate limit etc.) shouldn't kick the user out
    // of their connection — only a real rejection should.
    if (!(err instanceof ZohoCalendarTokenError && err.transient)) {
      account.status = "error";
      account.lastError = err?.message || "Refresh failed";
      await account.save();
    }
    return null;
  }
}

// ── Date helpers ────────────────────────────────────────────────

/** Date -> Zoho's yyyyMMdd'T'HHmmss'Z' (GMT). */
export const toZohoDateTime = (d: Date): string =>
  d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export interface ParsedZohoTime {
  date: Date;
  allDay: boolean;
  /** YYYY-MM-DD, for all-day values. */
  ymd?: string;
}

/**
 * Zoho returns times like 20170718T205000+0530, 20170718T205000Z,
 * a floating 20170718T205000, or a bare 20170718 for all-day events.
 * A floating time has no zone to go on, so it's read as UTC.
 */
export function parseZohoTime(s?: string): ParsedZohoTime | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?)?$/.exec(
    s.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, zone] = m;
  if (hh === undefined) {
    return {
      date: new Date(Number(y), Number(mo) - 1, Number(d)),
      allDay: true,
      ymd: `${y}-${mo}-${d}`,
    };
  }
  const offset =
    !zone || zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const date = new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss}${offset}`);
  if (Number.isNaN(date.getTime())) return null;
  return { date, allDay: false };
}

// ── Meetings: create / update / delete ──────────────────────────

export interface ZohoEventFields {
  title: string;
  description?: string;
  location?: string;
  /** A link shown on the event (e.g. the join link). */
  url?: string;
  startTime: Date;
  endTime: Date;
  /** Everyone else invited. Zoho is told NOT to email them
   *  (notify_attendee: 0) because this app sends its own invitations. */
  attendeeEmails?: string[];
  isPrivate?: boolean;
  /** Blocks time on the calendar (default true). */
  busy?: boolean;
}

// eventdata travels in the URL query string, so keep free text bounded.
const MAX_DESCRIPTION = 2000;
const MAX_LOCATION = 255;

export function buildEventData(f: ZohoEventFields): Record<string, unknown> {
  const data: Record<string, unknown> = {
    title: f.title,
    dateandtime: {
      start: toZohoDateTime(f.startTime),
      end: toZohoDateTime(f.endTime),
    },
    isallday: false,
    // Always sent (even empty): an update replaces the whole event, so a
    // field cleared in the app must be cleared in Zoho too.
    description: (f.description ?? "").slice(0, MAX_DESCRIPTION),
    location: (f.location ?? "").slice(0, MAX_LOCATION),
    isprivate: !!f.isPrivate,
    transparency: f.busy === false ? 1 : 0,
    notify_attendee: 0,
  };
  if (f.url) data.url = f.url;
  const attendees = (f.attendeeEmails ?? []).map((email) => ({
    email,
    permission: 1,
    attendance: 1,
  }));
  if (attendees.length) data.attendees = attendees;
  return data;
}

export interface ZohoEventResult {
  uid: string;
  etag: string;
  viewUrl?: string;
  /** Zoho Meeting key, when the event has a meeting attached. */
  meetingKey?: string;
}

/** The link attendees use to join a Zoho Meeting. (The link Zoho Calendar
 *  hands back is the host's *start* link, which isn't for guests.) */
export const zohoMeetingJoinLink = (meetingKey: string): string =>
  `https://${MEETING_DOMAIN}/join?key=${encodeURIComponent(meetingKey)}`;

export function parseEventResult(ev: any): ZohoEventResult {
  if (!ev?.uid) throw new Error("Zoho Calendar returned no event");
  const md = ev.conference_data?.meetingdata;
  const key = md?.meeting_id ?? md?.zoho_meeting_id;
  return {
    uid: String(ev.uid),
    etag: String(ev.etag ?? ""),
    viewUrl: ev.viewEventURL || undefined,
    meetingKey: key ? String(key) : undefined,
  };
}

const eventsUrl = (calendarUid: string, eventUid?: string) =>
  `${CALENDAR_API}/calendars/${encodeURIComponent(calendarUid)}/events${
    eventUid ? `/${encodeURIComponent(eventUid)}` : ""
  }`;

/** Creates an event. With `withZohoMeeting`, Zoho also creates a Zoho
 *  Meeting and returns its key. */
export async function createZohoEvent(
  input: {
    session: ZohoCalendarSession;
    withZohoMeeting?: boolean;
  } & ZohoEventFields,
): Promise<ZohoEventResult> {
  const eventdata = {
    ...buildEventData(input),
    ...(input.withZohoMeeting ? { conference: "zmeeting" } : {}),
  };
  const res = await axios.post(
    eventsUrl(input.session.calendarUid),
    null,
    {
      params: { eventdata: JSON.stringify(eventdata) },
      headers: authHeader(input.session.accessToken),
      timeout: HTTP_TIMEOUT_MS,
    },
  );
  return parseEventResult(res.data?.events?.[0]);
}

/** One event, or null if it no longer exists. */
export async function getZohoEvent(
  session: ZohoCalendarSession,
  eventUid: string,
): Promise<any | null> {
  try {
    const res = await axios.get(eventsUrl(session.calendarUid, eventUid), {
      headers: authHeader(session.accessToken),
      timeout: HTTP_TIMEOUT_MS,
    });
    return res.data?.events?.[0] ?? null;
  } catch (err: any) {
    if (isGone(err)) return null;
    throw err;
  }
}

const isGone = (err: any) => {
  const s = err?.response?.status;
  return s === 404 || s === 410;
};

export type ZohoUpdateResult =
  | ({ status: "updated" } & ZohoEventResult)
  | { status: "gone" };

/**
 * Rewrites an existing event to match the app. Zoho's update replaces the
 * whole event and insists on the event's *latest* etag, which changes any
 * time the event is touched (including an attendee's RSVP). So: try the
 * etag we stored; if Zoho rejects it, fetch the current one and retry
 * once. Returns "gone" if the event no longer exists so the caller can
 * create a fresh one instead of silently losing the meeting.
 *
 * `conference`: leave undefined to keep whatever meeting is attached;
 * "none" detaches the Zoho Meeting.
 */
export async function updateZohoEvent(
  input: {
    session: ZohoCalendarSession;
    uid: string;
    etag?: string;
    conference?: "none";
  } & ZohoEventFields,
): Promise<ZohoUpdateResult> {
  const { session, uid } = input;
  const attempt = (etag: string) =>
    axios.put(eventsUrl(session.calendarUid, uid), null, {
      params: {
        eventdata: JSON.stringify({
          ...buildEventData(input),
          ...(input.conference ? { conference: input.conference } : {}),
          uid,
          etag: Number(etag),
        }),
      },
      headers: { ...authHeader(session.accessToken), etag },
      timeout: HTTP_TIMEOUT_MS,
    });

  let etag = input.etag;
  if (!etag) {
    const current = await getZohoEvent(session, uid);
    if (!current) return { status: "gone" };
    etag = String(current.etag);
  }

  try {
    const res = await attempt(etag);
    return { status: "updated", ...parseEventResult(res.data?.events?.[0]) };
  } catch (err: any) {
    if (isGone(err)) return { status: "gone" };
    // Possibly a stale etag: refetch and retry once.
    const fresh = await getZohoEvent(session, uid);
    if (!fresh) return { status: "gone" };
    if (String(fresh.etag) === etag) throw err; // not an etag problem
    const res = await attempt(String(fresh.etag));
    return { status: "updated", ...parseEventResult(res.data?.events?.[0]) };
  }
}

/** Deletes an event. "Already gone" counts as success so cleanup is safe
 *  to repeat. Same stale-etag handling as updateZohoEvent. */
export async function deleteZohoEvent(input: {
  session: ZohoCalendarSession;
  uid: string;
  etag?: string;
}): Promise<void> {
  const { session, uid } = input;
  const attempt = (etag: string) =>
    axios.delete(eventsUrl(session.calendarUid, uid), {
      params: { eventdata: JSON.stringify({ uid, etag: Number(etag) }) },
      headers: { ...authHeader(session.accessToken), etag },
      timeout: HTTP_TIMEOUT_MS,
    });

  let etag = input.etag;
  if (!etag) {
    const current = await getZohoEvent(session, uid);
    if (!current) return;
    etag = String(current.etag);
  }
  try {
    await attempt(etag);
  } catch (err: any) {
    if (isGone(err)) return;
    const fresh = await getZohoEvent(session, uid);
    if (!fresh) return;
    if (String(fresh.etag) === etag) throw err;
    try {
      await attempt(String(fresh.etag));
    } catch (err2: any) {
      if (isGone(err2)) return;
      throw err2;
    }
  }
}

// ── Busy blocks ─────────────────────────────────────────────────

/** A private, busy event with no attendees (for "Mark Unavailable"). */
export async function createBusyEvent(input: {
  session: ZohoCalendarSession;
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
}): Promise<ZohoEventResult> {
  return createZohoEvent({
    session: input.session,
    title: input.title,
    description: input.description,
    startTime: input.startTime,
    endTime: input.endTime,
    isPrivate: true,
    busy: true,
  });
}

// ── Reading the user's calendar ─────────────────────────────────

/** The subset of a Zoho Calendar event resource we read. */
export interface ZohoEventLike {
  uid?: string;
  title?: string;
  location?: string;
  viewEventURL?: string;
  isallday?: boolean;
  /** 0 = shows as busy, 1 = shows as free. */
  transparency?: number;
  estatus?: string;
  etype?: string;
  dateandtime?: { start?: string; end?: string; timezone?: string };
  attendees?: { email?: string; status?: string }[];
  conference_data?: { meetingdata?: { meeting_id?: string; zoho_meeting_id?: string } };
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Zoho caps an events query at 31 days; stay safely under it.
const CHUNK_MS = 30 * DAY_MS;
const MAX_CHUNKS = 4;

/** All events in [from, to] on the user's calendar, with recurring
 *  events expanded into their individual occurrences. */
export async function listZohoEvents(
  session: ZohoCalendarSession,
  from: Date,
  to: Date,
): Promise<ZohoEventLike[]> {
  const out: ZohoEventLike[] = [];
  let cursor = from.getTime();
  for (let i = 0; i < MAX_CHUNKS && cursor < to.getTime(); i++) {
    const end = Math.min(cursor + CHUNK_MS, to.getTime());
    const res = await axios.get(eventsUrl(session.calendarUid), {
      params: {
        range: JSON.stringify({
          start: toZohoDateTime(new Date(cursor)),
          end: toZohoDateTime(new Date(end)),
        }),
        byinstance: true,
      },
      headers: authHeader(session.accessToken),
      timeout: READ_TIMEOUT_MS,
    });
    out.push(...(res.data?.events ?? []));
    cursor = end;
  }
  return out;
}

const isCancelled = (ev: ZohoEventLike) =>
  /^(cancel|delet)/i.test(ev.estatus ?? "");

const declinedBy = (ev: ZohoEventLike, selfEmail?: string) =>
  !!selfEmail &&
  !!ev.attendees?.some(
    (a) =>
      a.email?.toLowerCase() === selfEmail.toLowerCase() &&
      /^declin/i.test(a.status ?? ""),
  );

export interface ZohoBusyWindow {
  start: Date;
  end: Date;
  /** Event uid, so the caller can drop events this app created itself. */
  uid?: string;
}

/**
 * Raw events -> the windows that should count as "busy". Pure function.
 *   - cancelled/deleted events, events marked free, and events the user
 *     has declined: skipped
 *   - all-day events: skipped (birthdays, holidays and reminders would
 *     otherwise block the whole day)
 */
export function parseZohoBusyEvents(
  items: ZohoEventLike[],
  selfEmail?: string,
): ZohoBusyWindow[] {
  const windows: ZohoBusyWindow[] = [];
  for (const ev of items) {
    if (isCancelled(ev)) continue;
    if (ev.transparency === 1) continue;
    if (ev.isallday) continue;
    if (declinedBy(ev, selfEmail)) continue;
    const start = parseZohoTime(ev.dateandtime?.start);
    const end = parseZohoTime(ev.dateandtime?.end);
    if (!start || !end || start.allDay || end.allDay) continue;
    if (end.date <= start.date) continue;
    windows.push({ start: start.date, end: end.date, uid: ev.uid });
  }
  return windows;
}

const BUSY_CACHE_TTL_MS = 60_000;
const BUSY_FAILURE_TTL_MS = 30_000;
const busyCache = new Map<
  string,
  { at: number; ttl: number; windows: ZohoBusyWindow[] }
>();

/**
 * The user's Zoho Calendar busy windows overlapping [from, to]. Never
 * throws: if Zoho is unreachable, the token has lapsed, or the user isn't
 * connected, this returns [] so scheduling keeps working off our own
 * data. Cached per user for a minute (on a day-aligned window) because
 * the live conflict check fires repeatedly while someone edits the form.
 */
export async function getZohoBusyWindows(
  userId: string,
  from: Date,
  to: Date,
): Promise<ZohoBusyWindow[]> {
  if (!isZohoCalendarConfigured()) return [];

  const dayFrom = new Date(Math.floor(from.getTime() / DAY_MS) * DAY_MS);
  const dayTo = new Date(Math.ceil(to.getTime() / DAY_MS) * DAY_MS);
  const key = `${userId}|${dayFrom.getTime()}|${dayTo.getTime()}`;

  const cached = busyCache.get(key);
  let windows: ZohoBusyWindow[];
  if (cached && Date.now() - cached.at < cached.ttl) {
    windows = cached.windows;
  } else {
    try {
      const session = await getZohoCalendarSession(userId);
      if (!session) return [];
      const items = await listZohoEvents(session, dayFrom, dayTo);
      windows = parseZohoBusyEvents(items, session.email);
      busyCache.set(key, { at: Date.now(), ttl: BUSY_CACHE_TTL_MS, windows });
    } catch (err: any) {
      console.warn(
        "Zoho Calendar busy-time read failed (ignored):",
        err?.response?.data?.message || err?.message || err,
      );
      busyCache.set(key, { at: Date.now(), ttl: BUSY_FAILURE_TTL_MS, windows: [] });
      windows = [];
    }
    if (busyCache.size > 500) busyCache.clear();
  }
  return windows.filter((w) => w.start < to && w.end > from);
}

// ── For display on the in-app calendar ──────────────────────────

export interface ZohoCalendarEventView {
  /** Unique per occurrence (a recurring event's uid repeats). */
  id: string;
  uid: string;
  title: string;
  /** ISO date-time, or a plain YYYY-MM-DD date for all-day events. */
  start: string;
  /** Exclusive end, same format as `start`. */
  end: string;
  allDay: boolean;
  location?: string;
  /** Opens the event in Zoho Calendar. */
  htmlLink?: string;
  /** Join link, when the event has a Zoho Meeting. */
  meetLink?: string;
  /** Marked "free" in Zoho (doesn't block time). */
  free: boolean;
}

/**
 * Raw events -> what the in-app calendar draws. Unlike the busy-time
 * reader this keeps titles (it's the owner's own calendar) and keeps
 * free/all-day events, but still drops cancelled and declined events.
 * Events this app created are dropped by the controller, which knows
 * their uids. Pure, so it's testable.
 */
export function parseZohoEventsForDisplay(
  items: ZohoEventLike[],
  selfEmail?: string,
): ZohoCalendarEventView[] {
  const out: ZohoCalendarEventView[] = [];
  for (const ev of items) {
    if (!ev.uid || isCancelled(ev) || declinedBy(ev, selfEmail)) continue;
    const start = parseZohoTime(ev.dateandtime?.start);
    const end = parseZohoTime(ev.dateandtime?.end);
    if (!start || !end) continue;

    const allDay = start.allDay;
    let endValue: string;
    if (allDay) {
      // Make sure an all-day event spans at least its start day.
      let endYmd = end.ymd ?? start.ymd!;
      if (endYmd <= start.ymd!) {
        const next = new Date(start.date.getTime() + DAY_MS);
        endYmd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
      }
      endValue = endYmd;
    } else {
      endValue = end.date.toISOString();
    }
    const startValue = allDay ? start.ymd! : start.date.toISOString();

    const md = ev.conference_data?.meetingdata;
    const key = md?.meeting_id ?? md?.zoho_meeting_id;
    out.push({
      id: `${ev.uid}|${startValue}`,
      uid: ev.uid,
      title: ev.title?.trim() || "(No title)",
      start: startValue,
      end: endValue,
      allDay,
      location: ev.location || undefined,
      htmlLink: ev.viewEventURL || undefined,
      meetLink: key ? zohoMeetingJoinLink(String(key)) : undefined,
      free: ev.transparency === 1,
    });
  }
  return out;
}

/** The user's own events in [from, to], for the in-app calendar.
 *  Throws on Zoho errors (the controller decides how to report them). */
export async function listZohoEventsForDisplay(
  userId: string,
  from: Date,
  to: Date,
): Promise<{ connected: boolean; events: ZohoCalendarEventView[] }> {
  const session = await getZohoCalendarSession(userId);
  if (!session) return { connected: false, events: [] };
  const items = await listZohoEvents(session, from, to);
  return {
    connected: true,
    events: parseZohoEventsForDisplay(items, session.email),
  };
}