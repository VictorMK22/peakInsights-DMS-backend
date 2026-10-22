import { MeetingModel, IMeeting } from "../models/Meeting";
import { User } from "../models/User";
import {
  isGoogleCalendarConfigured,
  getValidGoogleAccessToken,
  createMeetingEvent,
  updateMeetingEvent,
  deleteMeetEvent,
  MeetingEventFields,
} from "./googleCalendarService";

// ═════════════════════════════════════════════════════════════════
// Keeps the ORGANIZER's Google Calendar in step with the meetings they
// own in this app — every meeting, not just ones with a generated Meet
// link. One Google event per meeting document, so each occurrence of a
// recurring series is its own event (matching how the app stores and
// edits them individually).
//
// Every function here is best-effort and never throws: Google being
// down, or the organizer not having connected an account, must not stop
// a meeting from being saved, rescheduled or cancelled. They are
// AWAITED by the controllers (not fire-and-forget) because on Vercel the
// function is frozen once the response is sent, which would silently
// drop any work still in flight.
// ═════════════════════════════════════════════════════════════════

// Google throttles per-user calendar writes; a series can have up to 52
// occurrences, so cap parallelism instead of firing them all at once.
const CONCURRENCY = 4;

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const idOf = (v: any): string => String(v?._id ?? v);

/** What Google shows in the event description. The join link is always
 *  included so every occurrence of a series carries it, even though only
 *  one event can own the generated Meet conference itself. */
export function buildMeetingDescription(m: {
  description?: string;
  agenda?: string;
  meetingLink?: string;
}): string {
  const parts: string[] = [];
  if (m.description?.trim()) parts.push(m.description.trim());
  if (m.agenda?.trim()) parts.push(`Agenda:\n${m.agenda.trim()}`);
  if (m.meetingLink?.trim()) parts.push(`Join: ${m.meetingLink.trim()}`);
  return parts.join("\n\n");
}

type MeetingLike = Pick<
  IMeeting,
  | "title"
  | "description"
  | "agenda"
  | "location"
  | "meetingLink"
  | "startTime"
  | "endTime"
  | "reminderMinutesBefore"
>;

export function toEventFields(
  m: MeetingLike,
  attendeeEmails: string[],
): MeetingEventFields {
  return {
    title: m.title,
    description: buildMeetingDescription(m),
    location: m.location,
    startTime: m.startTime,
    endTime: m.endTime,
    attendeeEmails,
    reminderMinutes: m.reminderMinutesBefore,
  };
}

/** Emails of everyone invited besides the organizer (internal accounts +
 *  external invitees), lower-cased and de-duplicated. */
async function resolveGuestEmails(
  m: Pick<IMeeting, "attendees" | "externalAttendees">,
  organizerEmail?: string,
): Promise<string[]> {
  const userIds = m.attendees.map((a) => idOf(a.userId));
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select("email")
        .lean()
    : [];
  const emails = [
    ...users.map((u) => u.email),
    ...m.externalAttendees.map((e) => e.email),
  ]
    .filter((e): e is string => typeof e === "string" && e.includes("@"))
    .map((e) => e.trim().toLowerCase());
  return [...new Set(emails)].filter((e) => e !== organizerEmail);
}

async function organizerEmailOf(organizerId: string): Promise<string | undefined> {
  const u = await User.findById(organizerId).select("email").lean();
  return u?.email?.toLowerCase();
}

/**
 * After a meeting (or a whole recurring series) is created: give each
 * document its own Google event on the organizer's calendar.
 *
 * A document that already has a googleEventId (the first occurrence,
 * when the organizer generated a Meet link in the form beforehand) has
 * that event filled in with the full details instead of getting a
 * duplicate.
 */
export async function pushNewMeetingsToGoogle(
  created: IMeeting[],
  organizerId: string,
): Promise<void> {
  if (!isGoogleCalendarConfigured() || created.length === 0) return;
  try {
    const accessToken = await getValidGoogleAccessToken(organizerId);
    if (!accessToken) return;
    const guests = await resolveGuestEmails(
      created[0],
      await organizerEmailOf(organizerId),
    );

    const results = await mapLimit(created, CONCURRENCY, async (m) => {
      const fields = toEventFields(m, guests);
      try {
        if (m.googleEventId) {
          const r = await updateMeetingEvent({
            accessToken,
            eventId: m.googleEventId,
            ...fields,
          });
          if (r === "updated") return null;
          // The pre-generated event vanished; fall through and recreate.
        }
        const { eventId } = await createMeetingEvent({ accessToken, ...fields });
        m.googleEventId = eventId;
        return { _id: m._id, eventId };
      } catch (err: any) {
        console.error(
          `Google event for meeting ${m._id} failed (meeting kept):`,
          err?.response?.data || err?.message || err,
        );
        return null;
      }
    });

    const ops = results
      .filter((r): r is { _id: IMeeting["_id"]; eventId: string } => !!r)
      .map((r) => ({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { googleEventId: r.eventId } },
        },
      }));
    if (ops.length) await MeetingModel.bulkWrite(ops);
  } catch (err: any) {
    console.error(
      "Pushing new meetings to Google failed (meetings kept):",
      err?.response?.data || err?.message || err,
    );
  }
}

/**
 * After an organizer edits a meeting (already saved on `meeting`): make
 * its Google event match. `previous` is what the meeting looked like
 * BEFORE the edit, so we can clean up an event that's no longer used.
 *
 * Meetings created before Google was connected (or before this feature
 * existed) have no event yet — editing one creates it, so they backfill
 * naturally.
 */
export async function syncUpdatedMeetingToGoogle(
  meeting: IMeeting,
  previous: { googleEventId?: string; conferenceProvider?: string },
): Promise<void> {
  if (!isGoogleCalendarConfigured()) return;
  try {
    const organizerId = idOf(meeting.organizer);
    const accessToken = await getValidGoogleAccessToken(organizerId);
    if (!accessToken) return;

    let eventId = meeting.googleEventId;

    // A different generated Meet event was swapped in: the old one is
    // now unused, delete it so it doesn't linger on the calendar.
    if (previous.googleEventId && previous.googleEventId !== eventId) {
      await deleteMeetEvent(accessToken, previous.googleEventId).catch((e) =>
        console.error("Deleting replaced Google event failed:", e?.message || e),
      );
    }
    // The generated Meet was dropped for a hand-typed link. A Calendar
    // event can't have its Meet conference stripped by a patch, so replace
    // the whole event with a plain one.
    if (
      eventId &&
      previous.googleEventId === eventId &&
      previous.conferenceProvider === "google_meet" &&
      meeting.conferenceProvider !== "google_meet"
    ) {
      await deleteMeetEvent(accessToken, eventId).catch((e) =>
        console.error("Deleting Meet-backed Google event failed:", e?.message || e),
      );
      eventId = undefined;
    }

    const guests = await resolveGuestEmails(
      meeting,
      await organizerEmailOf(organizerId),
    );
    const fields = toEventFields(meeting, guests);

    if (eventId) {
      const r = await updateMeetingEvent({ accessToken, eventId, ...fields });
      if (r === "updated") return;
    }
    const created = await createMeetingEvent({ accessToken, ...fields });
    meeting.googleEventId = created.eventId;
    await MeetingModel.updateOne(
      { _id: meeting._id },
      { $set: { googleEventId: created.eventId } },
    );
  } catch (err: any) {
    console.error(
      "Syncing updated meeting to Google failed (update kept):",
      err?.response?.data || err?.message || err,
    );
  }
}

/** After cancelling meetings: delete each one's Google event (whether
 *  or not it had a Meet link). */
export async function removeMeetingsFromGoogle(
  meetings: IMeeting[],
  organizerId: string,
): Promise<void> {
  if (!isGoogleCalendarConfigured()) return;
  const withEvents = meetings.filter((m) => m.googleEventId);
  if (withEvents.length === 0) return;
  try {
    const accessToken = await getValidGoogleAccessToken(organizerId);
    if (!accessToken) return;
    await mapLimit(withEvents, CONCURRENCY, async (m) => {
      try {
        await deleteMeetEvent(accessToken, m.googleEventId!);
      } catch (err: any) {
        console.error(
          `Deleting Google event for meeting ${m._id} failed:`,
          err?.response?.data || err?.message || err,
        );
      }
    });
  } catch (err: any) {
    console.error(
      "Removing cancelled meetings from Google failed:",
      err?.response?.data || err?.message || err,
    );
  }
}