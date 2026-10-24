import { MeetingModel, IMeeting } from "../models/Meeting";
import { User } from "../models/User";
import {
  isZohoCalendarConfigured,
  getZohoCalendarSession,
  createZohoEvent,
  updateZohoEvent,
  deleteZohoEvent,
  ZohoEventFields,
} from "./zohoCalendarService";

// ═════════════════════════════════════════════════════════════════
// Keeps the ORGANIZER's Zoho Calendar in step with the meetings they
// own in this app — every meeting, not just ones with a Zoho Meeting
// link. One Zoho event per meeting document, so each occurrence of a
// recurring series is its own event (matching how the app stores and
// edits them individually).
//
// Every function here is best-effort and never throws: Zoho being down,
// or the organizer not having connected their calendar, must not stop a
// meeting from being saved, rescheduled or cancelled. They are AWAITED by
// the controllers (not fire-and-forget) because on Vercel the function is
// frozen once the response is sent, which would silently drop any work
// still in flight.
// ═════════════════════════════════════════════════════════════════

// Zoho throttles per-user calendar calls; a series can have up to 52
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

/** What Zoho shows in the event description. The join link is always
 *  included so every occurrence of a series carries it, even though only
 *  one event can own the generated Zoho Meeting itself. */
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
>;

export function toEventFields(
  m: MeetingLike,
  attendeeEmails: string[],
): ZohoEventFields {
  return {
    title: m.title,
    description: buildMeetingDescription(m),
    location: m.location,
    url: m.meetingLink?.trim() || undefined,
    startTime: m.startTime,
    endTime: m.endTime,
    attendeeEmails,
  };
}

/** Emails of everyone invited besides the organizer (internal accounts +
 *  external invitees), lower-cased and de-duplicated. */
async function resolveGuestEmails(
  m: Pick<IMeeting, "attendees" | "externalAttendees">,
  excludeEmails: (string | undefined)[],
): Promise<string[]> {
  const userIds = m.attendees.map((a) => idOf(a.userId));
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } })
        .select("email")
        .lean()
    : [];
  const skip = new Set(
    excludeEmails.filter(Boolean).map((e) => e!.toLowerCase()),
  );
  const emails = [
    ...users.map((u) => u.email),
    ...m.externalAttendees.map((e) => e.email),
  ]
    .filter((e): e is string => typeof e === "string" && e.includes("@"))
    .map((e) => e.trim().toLowerCase());
  return [...new Set(emails)].filter((e) => !skip.has(e));
}

async function organizerEmailOf(organizerId: string): Promise<string | undefined> {
  const u = await User.findById(organizerId).select("email").lean();
  return u?.email?.toLowerCase();
}

/**
 * After a meeting (or a whole recurring series) is created: give each
 * document its own event on the organizer's Zoho Calendar.
 *
 * A document that already has a calendarEventUid (the first occurrence,
 * when the organizer generated a Zoho Meeting link in the form
 * beforehand) has that event filled in with the full details instead of
 * getting a duplicate.
 */
export async function pushNewMeetingsToZoho(
  created: IMeeting[],
  organizerId: string,
): Promise<void> {
  if (!isZohoCalendarConfigured() || created.length === 0) return;
  try {
    const session = await getZohoCalendarSession(organizerId);
    if (!session) return;
    const guests = await resolveGuestEmails(created[0], [
      await organizerEmailOf(organizerId),
      session.email,
    ]);

    const results = await mapLimit(created, CONCURRENCY, async (m) => {
      const fields = toEventFields(m, guests);
      try {
        if (m.calendarEventUid) {
          // Keep the attached Zoho Meeting as is (conference left unset).
          const r = await updateZohoEvent({
            session,
            uid: m.calendarEventUid,
            etag: m.calendarEventEtag,
            ...fields,
          });
          if (r.status === "updated") {
            return { _id: m._id, uid: r.uid, etag: r.etag };
          }
          // The pre-generated event vanished; fall through and recreate.
        }
        const r = await createZohoEvent({ session, ...fields });
        m.calendarEventUid = r.uid;
        m.calendarEventEtag = r.etag;
        return { _id: m._id, uid: r.uid, etag: r.etag };
      } catch (err: any) {
        console.error(
          `Zoho event for meeting ${m._id} failed (meeting kept):`,
          err?.response?.data || err?.message || err,
        );
        return null;
      }
    });

    const ops = results
      .filter((r): r is { _id: IMeeting["_id"]; uid: string; etag: string } => !!r)
      .map((r) => ({
        updateOne: {
          filter: { _id: r._id },
          update: {
            $set: { calendarEventUid: r.uid, calendarEventEtag: r.etag },
          },
        },
      }));
    if (ops.length) await MeetingModel.bulkWrite(ops);
  } catch (err: any) {
    console.error(
      "Pushing new meetings to Zoho failed (meetings kept):",
      err?.response?.data || err?.message || err,
    );
  }
}

/**
 * After an organizer edits a meeting (already saved on `meeting`): make
 * its Zoho event match. `previous` is what the meeting looked like BEFORE
 * the edit, so we can clean up an event that's no longer used.
 *
 * Meetings created before Zoho Calendar was connected (or before this
 * feature existed) have no event yet — editing one creates it, so they
 * backfill naturally.
 */
export async function syncUpdatedMeetingToZoho(
  meeting: IMeeting,
  previous: { calendarEventUid?: string; conferenceProvider?: string },
): Promise<void> {
  if (!isZohoCalendarConfigured()) return;
  try {
    const organizerId = idOf(meeting.organizer);
    const session = await getZohoCalendarSession(organizerId);
    if (!session) return;

    const uid = meeting.calendarEventUid;

    // A different generated Zoho Meeting event was swapped in: the old
    // one is now unused, delete it so it doesn't linger on the calendar.
    if (previous.calendarEventUid && previous.calendarEventUid !== uid) {
      await deleteZohoEvent({ session, uid: previous.calendarEventUid }).catch(
        (e) => console.error("Deleting replaced Zoho event failed:", e?.message || e),
      );
    }

    const guests = await resolveGuestEmails(meeting, [
      await organizerEmailOf(organizerId),
      session.email,
    ]);
    const fields = toEventFields(meeting, guests);

    if (uid) {
      // The generated Zoho Meeting was dropped for a hand-typed link:
      // detach the meeting from the event.
      const dropMeeting =
        previous.calendarEventUid === uid &&
        previous.conferenceProvider === "zoho_meeting" &&
        meeting.conferenceProvider !== "zoho_meeting";

      const r = await updateZohoEvent({
        session,
        uid,
        etag: meeting.calendarEventEtag,
        conference: dropMeeting ? "none" : undefined,
        ...fields,
      });
      if (r.status === "updated") {
        meeting.calendarEventEtag = r.etag;
        await MeetingModel.updateOne(
          { _id: meeting._id },
          { $set: { calendarEventEtag: r.etag } },
        );
        return;
      }
    }

    // No event yet (older meeting), or the old one is gone: create one.
    const created = await createZohoEvent({ session, ...fields });
    meeting.calendarEventUid = created.uid;
    meeting.calendarEventEtag = created.etag;
    await MeetingModel.updateOne(
      { _id: meeting._id },
      {
        $set: {
          calendarEventUid: created.uid,
          calendarEventEtag: created.etag,
        },
      },
    );
  } catch (err: any) {
    console.error(
      "Syncing updated meeting to Zoho failed (update kept):",
      err?.response?.data || err?.message || err,
    );
  }
}

/** After cancelling meetings: delete each one's Zoho event (whether or
 *  not it had a Zoho Meeting attached). */
export async function removeMeetingsFromZoho(
  meetings: IMeeting[],
  organizerId: string,
): Promise<void> {
  if (!isZohoCalendarConfigured()) return;
  const withEvents = meetings.filter((m) => m.calendarEventUid);
  if (withEvents.length === 0) return;
  try {
    const session = await getZohoCalendarSession(organizerId);
    if (!session) return;
    await mapLimit(withEvents, CONCURRENCY, async (m) => {
      try {
        await deleteZohoEvent({
          session,
          uid: m.calendarEventUid!,
          etag: m.calendarEventEtag,
        });
      } catch (err: any) {
        console.error(
          `Deleting Zoho event for meeting ${m._id} failed:`,
          err?.response?.data || err?.message || err,
        );
      }
    });
  } catch (err: any) {
    console.error(
      "Removing cancelled meetings from Zoho failed:",
      err?.response?.data || err?.message || err,
    );
  }
}