/**
 * East Africa Time (EAT) helpers — UTC+03:00, no daylight saving.
 *
 * Vercel functions run in UTC, so anything that formats a meeting time for
 * a person (notifications, emails, reminders) or reasons about "working
 * hours" / weekdays must be done in EAT explicitly, never in server-local
 * time.
 */

export const EAT_TIMEZONE = "Africa/Nairobi";
export const EAT_LABEL = "EAT";
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** e.g. "Nov 12, 2026, 10:00 AM EAT" */
export const formatEatDateTime = (d: Date | string | number): string =>
  `${new Date(d).toLocaleString("en-US", {
    timeZone: EAT_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  })} ${EAT_LABEL}`;

/** e.g. "10:00 AM EAT" */
export const formatEatTime = (d: Date | string | number): string =>
  `${new Date(d).toLocaleTimeString("en-US", {
    timeZone: EAT_TIMEZONE,
    timeStyle: "short",
  })} ${EAT_LABEL}`;

/** e.g. "Nov 12, 2026, 10:00 AM – 11:00 AM EAT" */
export const formatEatWindow = (
  start: Date | string | number,
  end: Date | string | number,
): string =>
  `${new Date(start).toLocaleString("en-US", {
    timeZone: EAT_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  })} – ${new Date(end).toLocaleTimeString("en-US", {
    timeZone: EAT_TIMEZONE,
    timeStyle: "short",
  })} ${EAT_LABEL}`;

/**
 * Real instant → "frame" Date whose *local* getters (getDay, getHours, …)
 * read as the EAT wall-clock. Lets calendar maths (working hours, weekdays,
 * recurrence) use plain Date methods regardless of the server's timezone.
 */
export const toEatFrame = (d: Date): Date => {
  const s = new Date(d.getTime() + EAT_OFFSET_MS);
  return new Date(
    s.getUTCFullYear(),
    s.getUTCMonth(),
    s.getUTCDate(),
    s.getUTCHours(),
    s.getUTCMinutes(),
    s.getUTCSeconds(),
    s.getUTCMilliseconds(),
  );
};

/** Inverse of toEatFrame. */
export const fromEatFrame = (wall: Date): Date =>
  new Date(
    Date.UTC(
      wall.getFullYear(),
      wall.getMonth(),
      wall.getDate(),
      wall.getHours(),
      wall.getMinutes(),
      wall.getSeconds(),
      wall.getMilliseconds(),
    ) - EAT_OFFSET_MS,
  );