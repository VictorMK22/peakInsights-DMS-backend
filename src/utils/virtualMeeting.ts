/**
 * Virtual-meeting rules shared by the meeting create/update flow.
 *
 * A meeting whose location says it is virtual ("Virtual", "Online", "Zoom",
 * "Google Meet", ...) must carry a join link, otherwise invitees get an
 * invitation with nothing to click. The organizer either generates a Zoho
 * Meeting link or types / pastes one created elsewhere.
 */
const VIRTUAL_LOCATION_PATTERN =
  /\b(virtual|virtually|online|remote|zoom|ms teams|microsoft teams|google meet|gmeet|zoho meeting|webex|skype|video\s*(call|conference)|web\s*conference)\b/i;

export const isVirtualLocation = (location?: string | null): boolean =>
  !!location && VIRTUAL_LOCATION_PATTERN.test(location);

export const VIRTUAL_MEETING_LINK_REQUIRED_MESSAGE =
  "A virtual meeting needs a meeting link. Generate a Zoho Meeting link, or paste the link if you created it elsewhere.";


/**
 * Make a user-typed meeting link safe to use as an <a href>.
 *
 * Links pasted as "meet.google.com/abc-defg-hij" have no scheme, so the browser
 * resolves them relative to the current page (e.g. /sales/meet.google.com/...)
 * and the SPA router then bounces the user to their dashboard. Prefix https://
 * when no scheme is present.
 */
export const normalizeMeetingUrl = (raw?: string | null): string => {
  const v = (raw ?? "").trim();
  if (!v) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v; // http:, https:, mailto:, etc.
  if (v.startsWith("//")) return `https:${v}`;
  return `https://${v.replace(/^\/+/, "")}`;
};