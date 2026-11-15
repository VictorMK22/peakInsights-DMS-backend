import mongoose from "mongoose";
import {
  MeetingModel,
  IMeeting,
  RsvpStatus,
  MAX_DECLINE_REASON_LENGTH,
} from "../models/Meeting";
import { User } from "../models/User";
import { createNotification } from "./notificationService";
import { logMeetingActivity } from "./meetingActivityService";
import type { RsvpTokenActor } from "../utils/meetingRsvpToken";

/**
 * Answering a meeting invitation — the one place that knows how.
 *
 * Two doors lead here and must behave identically:
 *   - PATCH /api/meetings/:id/respond   a logged-in attendee, in the app
 *   - /api/meeting-rsvp/:token          the Accept / Decline links in the
 *                                       invitation email (no login)
 *
 * Keeping the rules in one service means "declining requires a reason"
 * and "you can't answer a cancelled meeting" can't drift between them.
 */

export type RsvpResponseStatus = Exclude<RsvpStatus, "pending">;
export type RsvpActor = RsvpTokenActor;

export type RsvpErrorCode =
  | "INVALID_LINK"
  | "INVALID_INPUT"
  | "REASON_REQUIRED"
  | "NOT_FOUND"
  | "NOT_INVITED"
  | "MEETING_CANCELLED"
  | "MEETING_POSTPONED"
  | "MEETING_ENDED"
  | "CONFLICT";

export interface RsvpFailure {
  ok: false;
  httpStatus: number;
  code: RsvpErrorCode;
  message: string;
}

const fail = (
  httpStatus: number,
  code: RsvpErrorCode,
  message: string,
): RsvpFailure => ({ ok: false, httpStatus, code, message });

const idOf = (v: unknown): string =>
  v && typeof v === "object" && "_id" in (v as any)
    ? String((v as any)._id)
    : String(v);

// ─────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────

// Control characters other than tab / newline have no business in a reason
// (they'd only show up as garbage in notifications).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Validates a response body. `allowed` differs by door: the in-app UI
 * offers accepted / tentative / declined, the email only accepted / declined.
 *
 * A reason is mandatory when declining and ignored for anything else.
 */
export const parseRsvpInput = (
  body: unknown,
  allowed: readonly RsvpResponseStatus[],
):
  | { ok: true; status: RsvpResponseStatus; reason?: string }
  | RsvpFailure => {
  const { status, reason } = (body ?? {}) as {
    status?: unknown;
    reason?: unknown;
  };

  if (!allowed.includes(status as RsvpResponseStatus)) {
    return fail(
      400,
      "INVALID_INPUT",
      `status must be one of: ${allowed.join(", ")}`,
    );
  }
  if (status !== "declined") {
    return { ok: true, status: status as RsvpResponseStatus };
  }

  const cleaned =
    typeof reason === "string" ? reason.replace(CONTROL_CHARS, "").trim() : "";
  if (!cleaned) {
    return fail(
      400,
      "REASON_REQUIRED",
      "Please give a reason for declining this meeting",
    );
  }
  if (cleaned.length > MAX_DECLINE_REASON_LENGTH) {
    return fail(
      400,
      "INVALID_INPUT",
      `Reason must be ${MAX_DECLINE_REASON_LENGTH} characters or fewer`,
    );
  }
  return { ok: true, status: "declined", reason: cleaned };
};

// ─────────────────────────────────────────────────────────────────
// Looking up the invitee / whether the meeting still takes answers
// ─────────────────────────────────────────────────────────────────

export type InviteeRef =
  | { kind: "user"; attendee: IMeeting["attendees"][number] }
  | { kind: "external"; attendee: IMeeting["externalAttendees"][number] };

export const findInvitee = (
  meeting: Pick<IMeeting, "attendees" | "externalAttendees">,
  actor: RsvpActor,
): InviteeRef | null => {
  if (actor.kind === "user") {
    const attendee = meeting.attendees.find(
      (a) => idOf(a.userId) === actor.userId,
    );
    return attendee ? { kind: "user", attendee } : null;
  }
  const email = actor.email.trim().toLowerCase();
  const attendee = (meeting.externalAttendees ?? []).find(
    (e) => e.email === email,
  );
  return attendee ? { kind: "external", attendee } : null;
};

export type ClosedReason = "cancelled" | "postponed" | "ended";

/** Why this meeting can no longer be answered, or null if it still can. */
export const getClosedReason = (
  meeting: Pick<IMeeting, "status" | "endTime">,
): ClosedReason | null => {
  if (meeting.status === "cancelled") return "cancelled";
  if (meeting.status === "postponed") return "postponed";
  if (meeting.status === "completed" || meeting.endTime.getTime() <= Date.now())
    return "ended";
  return null;
};

const closedFailure = (reason: ClosedReason): RsvpFailure =>
  reason === "cancelled"
    ? fail(410, "MEETING_CANCELLED", "This meeting has been cancelled")
    : reason === "postponed"
      ? fail(
          409,
          "MEETING_POSTPONED",
          "This meeting has been postponed. You'll get a new invitation once a new time is set",
        )
      : fail(410, "MEETING_ENDED", "This meeting has already taken place");

// ─────────────────────────────────────────────────────────────────
// Recording the answer
// ─────────────────────────────────────────────────────────────────

export const recordRsvp = async (
  meetingId: string,
  actor: RsvpActor,
  status: RsvpResponseStatus,
  reason?: string,
): Promise<{ ok: true; responderName: string } | RsvpFailure> => {
  if (!mongoose.isValidObjectId(meetingId)) {
    return fail(404, "NOT_FOUND", "Meeting not found");
  }
  const meeting = await MeetingModel.findById(meetingId);
  if (!meeting) return fail(404, "NOT_FOUND", "Meeting not found");

  const invitee = findInvitee(meeting, actor);
  if (!invitee) {
    return fail(403, "NOT_INVITED", "You were not invited to this meeting");
  }
  const closed = getClosedReason(meeting);
  if (closed) return closedFailure(closed);

  // One atomic write, guarded by the same "still open" conditions we just
  // checked: if the organizer cancels or the time passes between our read
  // and this write, it simply doesn't match instead of recording a stale
  // answer. Positional update (not doc.save()) so two people answering at
  // once can't trip over each other's array edits.
  const now = new Date();
  const field = invitee.kind === "user" ? "attendees" : "externalAttendees";
  const who =
    actor.kind === "user"
      ? { "attendees.userId": new mongoose.Types.ObjectId(actor.userId) }
      : { "externalAttendees.email": actor.email.trim().toLowerCase() };

  const update: Record<string, Record<string, unknown>> = {
    $set: {
      [`${field}.$.status`]: status,
      [`${field}.$.respondedAt`]: now,
    },
  };
  if (status === "declined") {
    update.$set[`${field}.$.declineReason`] = reason;
  } else {
    // Changing your mind to accept/tentative drops the old reason.
    update.$unset = { [`${field}.$.declineReason`]: "" };
  }

  const written = await MeetingModel.updateOne(
    { _id: meeting._id, status: "scheduled", endTime: { $gt: now }, ...who },
    update,
  );
  if (written.matchedCount === 0) {
    return fail(
      409,
      "CONFLICT",
      "This meeting was just changed — please reload and try again",
    );
  }

  // ── Tell the organizer + write the automatic activity trail ────
  let responderName: string;
  if (invitee.kind === "user") {
    const u = await User.findById((actor as { userId: string }).userId)
      .select("name")
      .lean();
    responderName = u?.name ?? "A participant";
  } else {
    const e = invitee.attendee;
    responderName = e.name ? `${e.name} (${e.email})` : e.email;
  }

  const organizerId = idOf(meeting.organizer);
  const base =
    status === "tentative"
      ? `${responderName} responded tentatively to the invite for "${meeting.title}"`
      : `${responderName} ${status} the invite for "${meeting.title}"`;

  // The organizer's own notification carries the reason — they're the one
  // person it's meant for. (The activity feed is readable by every
  // participant, so the reason is deliberately NOT written there.)
  await createNotification(
    organizerId,
    status === "declined" ? `${base}. Reason: ${reason}` : base,
    "meeting_response",
    {
      meetingId: String(meeting._id),
      status,
      respondentName: responderName,
      ...(status === "declined" ? { reason } : {}),
      ...(invitee.kind === "external" ? { external: true } : {}),
    },
  );

  await logMeetingActivity({
    meetingId: meeting._id,
    seriesId: meeting.seriesId,
    clientId: meeting.clientId,
    // Activity entries need a user actor; an external invitee isn't one,
    // so those are attributed to the organizer (the message says who
    // really answered, and `details.external` marks it).
    actorId: actor.kind === "user" ? actor.userId : organizerId,
    action:
      status === "accepted"
        ? "participant_accepted"
        : status === "declined"
          ? "participant_declined"
          : "participant_tentative",
    message: base,
    ...(invitee.kind === "external" ? { details: { external: true } } : {}),
  });

  return { ok: true, responderName };
};

// ─────────────────────────────────────────────────────────────────
// Privacy
// ─────────────────────────────────────────────────────────────────

/**
 * Returns a plain-object copy of a meeting with decline reasons removed
 * unless the viewer is the organizer (who needs them) — or the attendee
 * whose own reason it is.
 *
 * Why: meeting documents are returned in full to every participant, and
 * "I'm unwell" / "this meeting is a waste of time" is meant for the
 * organizer, not for the other attendees. Apply to every endpoint that
 * returns a meeting to someone who might not be its organizer.
 */
export const redactDeclineReasons = <T>(meeting: T, viewerId: string): T => {
  if (!meeting) return meeting;
  const obj: any =
    typeof (meeting as any).toObject === "function"
      ? (meeting as any).toObject()
      : { ...(meeting as any) };
  if (idOf(obj.organizer) === viewerId) return obj;

  const strip = (entry: any, isViewer: boolean) => {
    if (isViewer || !("declineReason" in entry)) return entry;
    const { declineReason: _dropped, ...rest } = entry;
    return rest;
  };
  obj.attendees = (obj.attendees ?? []).map((a: any) =>
    strip(a, idOf(a.userId) === viewerId),
  );
  obj.externalAttendees = (obj.externalAttendees ?? []).map((e: any) =>
    strip(e, false),
  );
  return obj;
};