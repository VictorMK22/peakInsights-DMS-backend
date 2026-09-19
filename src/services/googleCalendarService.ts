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
// Used for exactly one thing: creating a real, clickable Google Meet
// link when a staff member schedules a meeting in-app, by creating a
// Calendar event (on the connecting user's own calendar) with
// conferenceData.createRequest set. Google mints the meet.google.com
// link and hands it back on the event — we store that link as the
// meeting's meetingLink, nothing else about the user's calendar is
// ever read.
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
    `${CALENDAR_API}/calendars/primary/events/${input.eventId}`,
    patch,
    {
      params: { sendUpdates: "none" },
      headers: { Authorization: `Bearer ${input.accessToken}` },
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

/** Best-effort cleanup when a meeting with a Google Meet link is
 *  cancelled — deletes the underlying Calendar event. */
export async function deleteMeetEvent(
  accessToken: string,
  eventId: string,
): Promise<void> {
  await axios.delete(`${CALENDAR_API}/calendars/primary/events/${eventId}`, {
    params: { sendUpdates: "none" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
