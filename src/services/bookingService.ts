import crypto from "crypto";
import {
  BookingLinkModel,
  IBookingLink,
  BOOKING_LIMITS,
  CallType,
  callTypeTitleSuffix,
} from "../models/BookingLink";
import { BookingRequestModel, IBookingRequest } from "../models/BookingRequest";
import { MeetingModel, IMeeting } from "../models/Meeting";
import { ClientModel } from "../models/Client";
import { User } from "../models/User";
import { getUserBusyIntervals } from "./calendarService";
import { computeSlots, Slot, SlotConfig, TimeInterval, eatDateKey } from "./bookingSlots";
import { pushNewMeetingsToZoho } from "./meetingZohoSyncService";
import {
  getZohoCalendarSession,
  createZohoEvent,
  zohoMeetingJoinLink,
  fetchZohoMeetingPassword,
} from "./zohoCalendarService";
import {
  sendMeetingInviteEmail,
  sendBookingRequestReceivedEmail,
  sendBookingRequestDeclinedEmail,
  sendBookingRequestOwnerEmail,
  sendBookingRequestExpiredEmail,
  sendBookingRequestReminderEmail,
} from "./emailService";
import { withBookingLock, BookingLockTimeout } from "./bookingLock";
import { createNotification } from "./notificationService";
import { logMeetingActivity } from "./meetingActivityService";
import { createRsvpToken } from "../utils/meetingRsvpToken";
import { createOfferToken, verifyOfferToken } from "../utils/bookingOfferToken";
import { formatEatDateTime } from "../utils/eatTime";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest window one slots request may cover. */
const MAX_RANGE_DAYS = 62;

export class BookingError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const generateSlug = (): string => crypto.randomBytes(5).toString("hex");

export const bookingUrl = (slug: string): string =>
  `${process.env.FRONTEND_URL ?? "http://localhost:5173"}/book/${slug}`;

export const toSlotConfig = (l: IBookingLink): SlotConfig => ({
  durationMinutes: l.durationMinutes,
  bufferMinutes: l.bufferMinutes,
  minNoticeHours: l.minNoticeHours,
  maxDaysAhead: l.maxDaysAhead,
  workStartHour: l.workStartHour,
  workEndHour: l.workEndHour,
  workDays: l.workDays,
  slotStepMinutes: l.slotStepMinutes,
});

// ─────────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────────

// The public slots endpoint is unauthenticated, and every cache miss can
// mean a Zoho Calendar read — so identical requests within a few seconds
// share one result. (Per server instance; best-effort on serverless.)
const SLOT_CACHE_TTL_MS = 20_000;
const slotCache = new Map<string, { at: number; slots: Slot[] }>();

/**
 * Times held by requests still waiting for this owner's approval. They count
 * as busy so two clients are never promised the same slot.
 */
/**
 * Requests that are still waiting AND haven't lapsed. Lapsing is judged
 * here, at read time, so a slot is released the instant a request's
 * expiresAt passes — even if the periodic sweep that emails people is late.
 * (Records from before expiresAt existed fall back to the meeting's end.)
 */
const liveRequestFilter = (now: Date) => ({
  status: "pending" as const,
  $or: [{ expiresAt: { $gt: now } }, { expiresAt: null, endTime: { $gt: now } }],
});

/** A pending request past its expiry: no longer holds the slot, can't be approved. */
const isLapsed = (r: { expiresAt?: Date | null; endTime: Date }) =>
  (r.expiresAt ?? r.endTime).getTime() <= Date.now();

/** When a new request stops holding its slot: after the link's window, but never later than the requested time. */
const requestExpiry = (windowHours: number, createdAt: Date, start: Date): Date =>
  new Date(
    Math.min(
      windowHours > 0 ? createdAt.getTime() + windowHours * 3_600_000 : Infinity,
      start.getTime(),
    ),
  );

async function pendingRequestIntervals(
  ownerId: string,
  from: Date,
  to: Date,
  excludeRequestId?: string,
): Promise<TimeInterval[]> {
  const rows = await BookingRequestModel.find({
    ownerId,
    ...liveRequestFilter(new Date()),
    ...(excludeRequestId ? { _id: { $ne: excludeRequestId } } : {}),
    startTime: { $lt: to },
    endTime: { $gt: from },
  })
    .select("startTime endTime")
    .lean();
  return rows.map((r) => ({ start: r.startTime, end: r.endTime }));
}

/**
 * Does anything — a meeting, blocked time, a Zoho event or another pending
 * request — overlap [start, end)? Used when approving a request, where the
 * rules that depend on "now" (minimum notice, booking window) must NOT be
 * re-applied: only a real clash matters.
 */
async function hasConflict(
  ownerId: string,
  start: Date,
  end: Date,
  excludeRequestId?: string,
): Promise<boolean> {
  const [busy, held] = await Promise.all([
    getUserBusyIntervals(ownerId, start, end),
    pendingRequestIntervals(ownerId, start, end, excludeRequestId),
  ]);
  return [...busy, ...held].some((b) => b.start < end && b.end > start);
}

/**
 * Free slots for a link, in [from, to). Defaults to the link's whole
 * booking window. `fresh` skips the cache — used when actually booking,
 * where a stale "free" answer would be a double-booking.
 */
export async function getSlotsForLink(
  link: IBookingLink,
  range: { from?: Date; to?: Date } = {},
  opts: { fresh?: boolean; excludeRequestId?: string } = {},
): Promise<Slot[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + link.maxDaysAhead * DAY_MS);
  const from = range.from && range.from > now ? range.from : now;
  let to = range.to && range.to < windowEnd ? range.to : windowEnd;
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    to = new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS);
  }
  if (!(from < to)) return [];

  const key = `${link._id}|${link.updatedAt?.getTime()}|${from.getTime()}|${to.getTime()}`;
  if (!opts.fresh) {
    const hit = slotCache.get(key);
    if (hit && Date.now() - hit.at < SLOT_CACHE_TTL_MS) return hit.slots;
  }

  // Busy time = the owner's meetings, "Mark Unavailable" blocks and Zoho
  // Calendar events (see calendarService.getUserBusyIntervals). Only the
  // resulting free slots ever leave this function — never titles.
  const padMs = link.bufferMinutes * 60_000;
  const busyFrom = new Date(from.getTime() - padMs);
  const busyTo = new Date(to.getTime() + padMs + link.durationMinutes * 60_000);
  const busy = [
    ...(await getUserBusyIntervals(String(link.ownerId), busyFrom, busyTo)),
    ...(await pendingRequestIntervals(String(link.ownerId), busyFrom, busyTo, opts.excludeRequestId)),
  ];

  const slots = computeSlots(toSlotConfig(link), busy, now, { from, to });

  if (!opts.fresh) {
    if (slotCache.size > 200) slotCache.clear();
    slotCache.set(key, { at: Date.now(), slots });
  }
  return slots;
}

/** Slots grouped by EAT calendar day, as the API returns them. */
export const groupSlotsByEatDay = (slots: Slot[]) => {
  const byDay = new Map<string, { start: string; end: string }[]>();
  for (const s of slots) {
    const k = eatDateKey(s.start.getTime());
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push({ start: s.start.toISOString(), end: s.end.toISOString() });
  }
  return [...byDay.entries()].map(([date, daySlots]) => ({ date, slots: daySlots }));
};

// ─────────────────────────────────────────────────────────────────
// Booking
// ─────────────────────────────────────────────────────────────────

export interface BookingInput {
  start: Date;
  name: string;
  email: string;
  topic?: string;
  /** What the client chose. Omitted → the link's first allowed type. */
  callType?: CallType;
}

export interface BookingResult {
  /** "confirmed": it is a meeting now. "pending": waiting for the host to approve. */
  status: "confirmed" | "pending";
  callType: CallType;
  title: string;
  startTime: Date;
  endTime: Date;
  hostName: string;
  meetingId?: string;
  requestId?: string;
  /** For "pending": when the request lapses if the host hasn't answered. */
  expiresAt?: Date;
  location?: string;
  meetingLink?: string;
  /** Password the client must enter to join the meeting link, when there is one. */
  meetingPassword?: string;
}

const lockKey = (ownerId: string) => `owner:${ownerId}`;
const callTypeSuffix = callTypeTitleSuffix;

/**
 * The fixed meeting link to use for a call type, if the link has one. A voice
 * call prefers its own link (e.g. an audio-only room) and otherwise shares
 * the video one. `link` may be missing (deleted since the request was made).
 */
const fixedLinkFor = (
  link: { meetingLink?: string; voiceMeetingLink?: string } | null | undefined,
  callType: CallType,
): string | undefined =>
  (callType === "voice" ? link?.voiceMeetingLink || link?.meetingLink : link?.meetingLink) ||
  undefined;

/** "Online" for video; says so for a voice call. */
const onlineLocation = (callType: CallType) =>
  callType === "voice" ? "Online (voice call)" : "Online";

const busyError = () =>
  new BookingError(
    503,
    "BUSY",
    "We're handling a lot of bookings right now. Please try again in a moment.",
  );

/** Everything a confirmed booking needs after the Meeting row exists. */
interface ConfirmContext {
  meeting: IMeeting;
  ownerId: string;
  ownerName: string;
  /** Link title for notifications / the activity trail. */
  linkTitle: string;
  autoZohoMeeting: boolean;
  callType: CallType;
  clientName: string;
  clientEmail: string;
  clientId?: unknown;
  /** Tell the owner in-app (true when the client booked on their own; false when the owner just approved it). */
  notifyOwner: boolean;
  activityMessage: string;
  linkId?: string;
}

/**
 * The steps that turn a saved Meeting into a finished booking: a Zoho
 * Meeting video link, the event on the owner's Zoho Calendar, the client's
 * invitation, the owner's notification and the activity trail. Shared by
 * instant bookings and approvals so both behave identically.
 *
 * Runs OUTSIDE the booking lock and never throws: by now the client has
 * been promised the slot, so a Zoho or email hiccup must not undo it.
 */
async function finishConfirmedMeeting(c: ConfirmContext): Promise<void> {
  const { meeting, ownerId } = c;
  const start = meeting.startTime;
  const end = meeting.endTime;

  // Why a Zoho Meeting password couldn't be fetched, if that happened. Zoho
  // asks guests for it, so the host needs to know it's missing.
  let passwordIssue: "needs_reconnect" | "masked" | "error" | undefined;

  if (c.autoZohoMeeting && !meeting.meetingLink) {
    try {
      const session = await getZohoCalendarSession(ownerId);
      if (session) {
        const ev = await createZohoEvent({
          session,
          withZohoMeeting: true,
          title: meeting.title,
          startTime: start,
          endTime: end,
        });
        meeting.calendarEventUid = ev.uid;
        meeting.calendarEventEtag = ev.etag;
        if (ev.meetingKey) {
          meeting.meetingLink = zohoMeetingJoinLink(ev.meetingKey);
          meeting.conferenceProvider = "zoho_meeting";
          // The join link doesn't contain the password, so a guest would be
          // asked for one they were never given. Fetch it for the invitation.
          if (ev.meetingPassword) {
            meeting.meetingPassword = ev.meetingPassword;
          } else {
            const pw = await fetchZohoMeetingPassword(session, ev.meetingKey);
            if (pw.status === "ok") {
              if (pw.password) meeting.meetingPassword = pw.password;
              // Zoho's own link already carries the password: use it, so the
              // client joins with one click.
              if (pw.joinLink) meeting.meetingLink = pw.joinLink;
            } else {
              passwordIssue = pw.reason;
            }
          }
        }
      }
    } catch (err: any) {
      console.error(
        "Booking: Zoho Meeting creation failed (booking kept):",
        err?.response?.data || err?.message || err,
      );
    }
  }
  if (!meeting.location && meeting.meetingLink) meeting.location = onlineLocation(c.callType);
  await meeting.save();

  // Full details onto the owner's Zoho Calendar (updates the event made
  // above, or creates one). Best-effort and never throws.
  await pushNewMeetingsToZoho([meeting], ownerId);
  slotCache.clear();

  const passwordNote =
    passwordIssue === "needs_reconnect"
      ? "The Zoho Meeting password couldn't be retrieved, so the client may be asked for it. Reconnect Zoho Calendar (Meetings) so it can be."
      : passwordIssue === "masked"
        ? "Zoho hides the meeting password from apps, so the client may be asked for it. Send it to them yourself (you can see it in Zoho Meeting) or use a fixed meeting link in this booking link's settings."
        : passwordIssue
          ? "The Zoho Meeting password couldn't be retrieved just now, so the client may be asked for it. Send it to them yourself, or run \"Check Zoho Meeting\" under Booking links to see why."
          : "";

  if (!c.notifyOwner && passwordNote) {
    // An approved request doesn't ping the host about the booking itself,
    // but a missing password still needs their attention.
    await createNotification(
      ownerId,
      `${c.clientName}'s meeting on ${formatEatDateTime(start)} is confirmed. ${passwordNote}`,
      "meeting_booked",
      { meetingId: String(meeting._id), title: meeting.title, startTime: start, endTime: end },
    ).catch((err) => console.error("Booking notification failed:", err));
  }

  if (c.notifyOwner) {
    const missingLink = !meeting.meetingLink && c.autoZohoMeeting;
    await createNotification(
      ownerId,
      `${c.clientName} booked "${c.linkTitle}"${c.callType === "voice" ? " (voice call)" : ""} for ${formatEatDateTime(start)}${
        missingLink ? ". No meeting link could be generated — add one before the call." : ""
      }${passwordNote ? `. ${passwordNote}` : ""}`,
      "meeting_booked",
      {
        meetingId: String(meeting._id),
        title: meeting.title,
        startTime: start,
        endTime: end,
        clientName: c.clientName,
        clientEmail: c.clientEmail,
      },
    ).catch((err) => console.error("Booking notification failed:", err));
  }

  // The client's invitation, with working Accept / Decline links.
  try {
    let rsvpToken: string | undefined;
    try {
      rsvpToken = createRsvpToken(String(meeting._id), { kind: "external", email: c.clientEmail });
    } catch (err) {
      console.error("Could not create RSVP token:", err);
    }
    await sendMeetingInviteEmail({
      toEmail: c.clientEmail,
      toName: c.clientName,
      meetingId: String(meeting._id),
      title: meeting.title,
      organizerName: c.ownerName,
      startTime: start,
      endTime: end,
      location: meeting.location,
      meetingLink: meeting.meetingLink,
      meetingPassword: meeting.meetingPassword,
      callType: c.callType,
      isRecurring: false,
      isExternal: true,
      rsvpToken,
    });
  } catch (err) {
    console.error("Booking confirmation email failed:", err);
  }

  await logMeetingActivity({
    meetingId: meeting._id,
    clientId: c.clientId as any,
    actorId: ownerId,
    action: "meeting_created",
    message: c.activityMessage,
    details: { bookingLinkId: c.linkId, clientEmail: c.clientEmail },
  }).catch((err) => console.error("Booking activity log failed:", err));
}

const toResult = (
  status: BookingResult["status"],
  hostName: string,
  r: {
    callType: CallType;
    title: string;
    startTime: Date;
    endTime: Date;
    meetingId?: string;
    requestId?: string;
    expiresAt?: Date;
    location?: string;
    meetingLink?: string;
    meetingPassword?: string;
  },
): BookingResult => ({ status, hostName, ...r });

/**
 * A client books `input.start` on `link`.
 *
 *  - Instant link  → a Meeting is created right away (and fully confirmed).
 *  - Approval link → a pending BookingRequest is created instead. It holds
 *    the slot, the host is told, the client is told it's awaiting approval,
 *    and nothing reaches any calendar until the host approves.
 *
 * Either way the slot is re-verified against live calendars inside a
 * per-owner lock, so simultaneous bookings produce exactly one winner.
 */
export async function createBookingForLink(
  link: IBookingLink,
  input: BookingInput,
  /** The `o` token from a "pick another time" email, when the client came from one. */
  offerToken?: string,
): Promise<BookingResult> {
  const ownerId = String(link.ownerId);
  const owner = await User.findById(ownerId).select("name email isActive").lean();
  if (!owner || !owner.isActive) {
    throw new BookingError(404, "NOT_FOUND", "This booking link is no longer available.");
  }
  const hostName = owner.name ?? "Your host";

  const start = input.start;
  const end = new Date(start.getTime() + link.durationMinutes * 60_000);
  const email = input.email.toLowerCase();
  const now = new Date();

  // Which kind of call. When the host allows only one, that's it; when both,
  // the client's pick (the first allowed if they somehow sent none).
  const allowed: CallType[] = link.callTypes?.length ? link.callTypes : ["video"];
  const callType: CallType = input.callType ?? allowed[0];

  // A time the host offered after declining: confirm it straight away, even
  // on an approval link. Anything that doesn't check out is just ignored and
  // the booking proceeds as an ordinary one.
  if (offerToken) {
    const offer = await findUsableOffer(link, offerToken);
    if (
      offer &&
      offer.email === email &&
      offer.alternatives.some((a) => a.getTime() === start.getTime())
    ) {
      return bookViaOffer(link, input, offer, hostName);
    }
  }

  if (!allowed.includes(callType)) {
    throw new BookingError(
      400,
      "INVALID",
      `${callType === "voice" ? "Voice" : "Video"} calls aren't available for this booking page.`,
    );
  }

  // Stops one person hoarding the calendar — counts confirmed bookings AND
  // requests still waiting for approval.
  const [upcomingMeetings, upcomingRequests] = await Promise.all([
    MeetingModel.countDocuments({
      bookingLinkId: link._id,
      status: "scheduled",
      startTime: { $gte: now },
      "externalAttendees.email": email,
    }),
    BookingRequestModel.countDocuments({
      linkId: link._id,
      ...liveRequestFilter(now),
      email,
    }),
  ]);
  if (upcomingMeetings + upcomingRequests >= BOOKING_LIMITS.maxUpcomingPerEmail) {
    throw new BookingError(
      429,
      "TOO_MANY_BOOKINGS",
      "You already have several upcoming meetings booked. Please use the links in your confirmation emails to change them.",
    );
  }
  if (link.requireApproval) {
    // Every pending request holds a slot, so cap how many can wait at once.
    const waiting = await BookingRequestModel.countDocuments({
      linkId: link._id,
      ...liveRequestFilter(now),
    });
    if (waiting >= BOOKING_LIMITS.maxPendingPerLink) {
      throw new BookingError(
        429,
        "TOO_MANY_PENDING",
        "This booking page has several requests waiting for a reply. Please try again later.",
      );
    }
  }

  const title = `${link.title} – ${input.name}${callTypeSuffix(callType)}`;
  // Tie a confirmed meeting to a CRM client when this email is already one.
  const knownClient = link.requireApproval
    ? null
    : await ClientModel.findOne({ $or: [{ email }, { "additionalEmails.email": email }] }).select("_id").lean();

  // Verify-then-create must be ONE step per owner. Without the lock, two
  // people booking the same slot at the same instant can both pass the
  // check before either record exists. Inside it, the second person's
  // check runs after the first record is saved, so they see it and get a
  // clean "slot taken". Only quick database work happens in here.
  let created: { meeting?: IMeeting; request?: IBookingRequest };
  try {
    created = await withBookingLock(lockKey(ownerId), async () => {
      // Authoritative check against live calendars, never the cache.
      const open = await getSlotsForLink(
        link,
        { from: start, to: new Date(start.getTime() + 1) },
        { fresh: true },
      );
      if (!open.some((s) => s.start.getTime() === start.getTime())) {
        throw new BookingError(
          409,
          "SLOT_TAKEN",
          "Sorry, that time is no longer available. Please pick another.",
        );
      }
      if (link.requireApproval) {
        const expiresAt = requestExpiry(link.approvalWindowHours, now, start);
        const request = await BookingRequestModel.create({
          linkId: link._id,
          ownerId: link.ownerId,
          linkTitle: link.title,
          startTime: start,
          endTime: end,
          name: input.name,
          email,
          topic: input.topic || undefined,
          callType,
          expiresAt,
          // Nudge the host halfway to the deadline.
          reminderAt: new Date(now.getTime() + (expiresAt.getTime() - now.getTime()) / 2),
        });
        return { request };
      }
      const meeting = await MeetingModel.create({
        title,
        description: `Booked through the booking link "${link.title}" by ${input.name} (${email}).`,
        agenda: input.topic || undefined,
        organizer: link.ownerId,
        attendees: [],
        externalAttendees: [{ email, name: input.name, status: "pending" }],
        startTime: start,
        endTime: end,
        location: link.location || undefined,
        meetingLink: fixedLinkFor(link, callType),
        conferenceProvider: fixedLinkFor(link, callType) ? "custom" : undefined,
        callType,
        status: "scheduled",
        reminderMinutesBefore: 15,
        clientId: knownClient?._id,
        bookingLinkId: link._id,
      });
      return { meeting };
    });
  } catch (err) {
    if (err instanceof BookingLockTimeout) throw busyError();
    throw err;
  }
  slotCache.clear();

  // ── Waiting for the host's approval ─────────────────────────────
  if (created.request) {
    const req = created.request;
    await createNotification(
      ownerId,
      `${input.name} requested "${link.title}"${callType === "voice" ? " (voice call)" : ""} for ${formatEatDateTime(start)}. Approve or decline it in Meetings → Booking links.`,
      "meeting_booking_request",
      { title, startTime: start, endTime: end, clientName: input.name, clientEmail: email },
    ).catch((err) => console.error("Booking request notification failed:", err));

    if (owner.email) {
      await sendBookingRequestOwnerEmail({
        toEmail: owner.email,
        ownerName: hostName,
        clientName: input.name,
        clientEmail: email,
        title: link.title,
        startTime: start,
        endTime: end,
        topic: input.topic,
        callType,
      }).catch((err) => console.error("Booking request owner email failed:", err));
    }
    await sendBookingRequestReceivedEmail({
      toEmail: email,
      toName: input.name,
      hostName,
      title: link.title,
      startTime: start,
      endTime: end,
      callType,
    }).catch((err) => console.error("Booking request received email failed:", err));

    return toResult("pending", hostName, {
      callType,
      title: link.title,
      startTime: start,
      endTime: end,
      requestId: String(req._id),
      expiresAt: req.expiresAt,
    });
  }

  // ── Instant confirmation ────────────────────────────────────────
  const meeting = created.meeting!;
  await finishConfirmedMeeting({
    meeting,
    ownerId,
    ownerName: hostName,
    linkTitle: link.title,
    autoZohoMeeting: link.autoZohoMeeting,
    callType,
    clientName: input.name,
    clientEmail: email,
    clientId: knownClient?._id,
    notifyOwner: true,
    activityMessage: `${input.name} booked "${link.title}"${callType === "voice" ? " (voice call)" : ""} through the booking link for ${formatEatDateTime(start)}`,
    linkId: String(link._id),
  });

  return toResult("confirmed", hostName, {
    callType,
    title,
    startTime: start,
    endTime: end,
    meetingId: String(meeting._id),
    location: meeting.location,
    meetingLink: meeting.meetingLink,
    meetingPassword: meeting.meetingPassword,
  });
}

// ─────────────────────────────────────────────────────────────────
// Approving and declining requests
// ─────────────────────────────────────────────────────────────────

const loadOwnRequest = async (requestId: string, ownerId: string) => {
  // Anything that isn't a valid id is simply "not found".
  const req = /^[a-f0-9]{24}$/i.test(requestId)
    ? await BookingRequestModel.findOne({ _id: requestId, ownerId })
    : null;
  if (!req) throw new BookingError(404, "NOT_FOUND", "Request not found.");
  return req;
};

export interface PendingRequestView {
  _id: string;
  linkId: string;
  linkTitle: string;
  name: string;
  email: string;
  topic: string;
  callType: CallType;
  startTime: Date;
  endTime: Date;
  createdAt: Date;
  /** When it lapses if nobody answers. */
  expiresAt: Date;
}

/** The owner's requests that still need a decision. */
export async function listPendingRequests(ownerId: string): Promise<PendingRequestView[]> {
  // Catch up on anything that lapsed since the last scheduled sweep, so the
  // client hears about it even if the scheduler is late (or not set up).
  await sweepBookingRequests({ ownerId }).catch((err) =>
    console.error("Booking request sweep (on list) failed:", err),
  );
  const rows = await BookingRequestModel.find({
    ownerId,
    ...liveRequestFilter(new Date()),
  }).sort({ startTime: 1 });
  return rows.map((r) => ({
    _id: String(r._id),
    linkId: String(r.linkId),
    linkTitle: r.linkTitle,
    name: r.name,
    email: r.email,
    topic: r.topic ?? "",
    callType: r.callType ?? "video",
    startTime: r.startTime,
    endTime: r.endTime,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? r.endTime,
  }));
}

/**
 * Owner approves: the request becomes a real, fully confirmed Meeting.
 * Safe to click twice or from two tabs — only one approval can win.
 */
export async function approveBookingRequest(
  requestId: string,
  ownerId: string,
): Promise<BookingResult> {
  const req = await loadOwnRequest(requestId, ownerId);
  if (req.status !== "pending") {
    throw new BookingError(409, "ALREADY_DECIDED", `This request was already ${req.status}.`);
  }
  if (isLapsed(req)) {
    throw new BookingError(
      409,
      "EXPIRED",
      "This request has expired, so its time was released. The client is told to request another time.",
    );
  }

  const owner = await User.findById(ownerId).select("name isActive").lean();
  const hostName = owner?.name ?? "Your host";
  // The link may have been edited or deleted since the request was made.
  const link = await BookingLinkModel.findById(req.linkId);
  const knownClient = await ClientModel.findOne({ $or: [{ email: req.email }, { "additionalEmails.email": req.email }] }).select("_id").lean();
  const callType: CallType = req.callType ?? "video";
  const title = `${req.linkTitle} – ${req.name}${callTypeSuffix(callType)}`;

  let meeting: IMeeting;
  try {
    meeting = await withBookingLock(lockKey(ownerId), async () => {
      // Claim it atomically: a concurrent decline, or a second approval,
      // finds it no longer pending and backs off.
      const claimed = await BookingRequestModel.findOneAndUpdate(
        { _id: req._id, ownerId, status: "pending" },
        { status: "approved", decidedAt: new Date() },
        { new: true },
      );
      if (!claimed) {
        throw new BookingError(409, "ALREADY_DECIDED", "This request was already handled.");
      }
      const undo = () =>
        BookingRequestModel.updateOne(
          { _id: req._id },
          { status: "pending", $unset: { decidedAt: 1, meetingId: 1 } },
        );
      try {
        // Only a REAL clash blocks approval — e.g. the host has since put a
        // meeting there. (Notice period / booking window are about when the
        // client asked, so they are not re-checked.)
        if (await hasConflict(ownerId, req.startTime, req.endTime, String(req._id))) {
          throw new BookingError(
            409,
            "SLOT_CONFLICT",
            "You now have something else at that time. Move or cancel it first, or decline this request.",
          );
        }
        const m = await MeetingModel.create({
          title,
          description: `Booked through the booking link "${req.linkTitle}" by ${req.name} (${req.email}) and approved by ${hostName}.`,
          agenda: req.topic || undefined,
          organizer: ownerId,
          attendees: [],
          externalAttendees: [{ email: req.email, name: req.name, status: "pending" }],
          startTime: req.startTime,
          endTime: req.endTime,
          location: link?.location || undefined,
          meetingLink: fixedLinkFor(link, callType),
          conferenceProvider: fixedLinkFor(link, callType) ? "custom" : undefined,
          callType,
          status: "scheduled",
          reminderMinutesBefore: 15,
          clientId: knownClient?._id,
          bookingLinkId: req.linkId,
        });
        await BookingRequestModel.updateOne({ _id: req._id }, { meetingId: m._id });
        return m;
      } catch (err) {
        await undo(); // leave it pending so the owner can try again or decline
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof BookingLockTimeout) throw busyError();
    throw err;
  }

  await finishConfirmedMeeting({
    meeting,
    ownerId,
    ownerName: hostName,
    linkTitle: req.linkTitle,
    // A deleted link has no settings left: default to making a video link.
    autoZohoMeeting: link ? link.autoZohoMeeting : true,
    callType,
    clientName: req.name,
    clientEmail: req.email,
    clientId: knownClient?._id,
    notifyOwner: false,
    activityMessage: `${hostName} approved ${req.name}'s booking request for ${formatEatDateTime(req.startTime)}`,
    linkId: String(req.linkId),
  });

  return toResult("confirmed", hostName, {
    callType,
    title,
    startTime: req.startTime,
    endTime: req.endTime,
    meetingId: String(meeting._id),
    requestId: String(req._id),
    location: meeting.location,
    meetingLink: meeting.meetingLink,
    meetingPassword: meeting.meetingPassword,
  });
}

/**
 * Checks that every alternative the host wants to offer is genuinely
 * bookable right now (so a client is never sent to a taken time), and
 * returns them de-duplicated and sorted.
 */
async function validateAlternatives(
  req: IBookingRequest,
  alternatives: Date[],
): Promise<{ link: IBookingLink; times: Date[] }> {
  const unique = [...new Map(alternatives.map((d) => [d.getTime(), d])).values()].sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  if (unique.length > BOOKING_LIMITS.maxAlternatives) {
    throw new BookingError(
      400,
      "TOO_MANY_ALTERNATIVES",
      `You can offer up to ${BOOKING_LIMITS.maxAlternatives} alternative times.`,
    );
  }
  const link = await BookingLinkModel.findOne({ _id: req.linkId, isActive: true });
  if (!link) {
    throw new BookingError(
      400,
      "NO_LINK",
      "This booking link is paused or deleted, so other times can't be offered. Decline without offering times, or turn the link back on.",
    );
  }
  if (unique.some((d) => d.getTime() <= Date.now())) {
    throw new BookingError(400, "INVALID", "Alternative times must be in the future.");
  }
  // Live availability, with this request's own held slot counted as free
  // (it is about to be released).
  const open = await getSlotsForLink(
    link,
    {
      from: unique[0],
      to: new Date(unique[unique.length - 1].getTime() + 1),
    },
    { fresh: true, excludeRequestId: String(req._id) },
  );
  const openAt = new Set(open.map((o) => o.start.getTime()));
  if (!unique.every((d) => openAt.has(d.getTime()))) {
    throw new BookingError(
      409,
      "SLOT_TAKEN",
      "One of those times is no longer free. Please pick again.",
    );
  }
  return { link, times: unique };
}

/**
 * Owner declines: the slot is freed and the client is told, with an
 * optional note and optionally up to a few alternative times they can
 * confirm with one click.
 */
export async function declineBookingRequest(
  requestId: string,
  ownerId: string,
  opts: { reason?: string; alternatives?: Date[] } = {},
): Promise<void> {
  const existing = await loadOwnRequest(requestId, ownerId);
  if (existing.status !== "pending") {
    throw new BookingError(409, "ALREADY_DECIDED", `This request was already ${existing.status}.`);
  }

  // Validate BEFORE changing anything, so a bad choice leaves it pending.
  const offer = opts.alternatives?.length
    ? await validateAlternatives(existing, opts.alternatives)
    : null;

  const now = new Date();
  const declined = await BookingRequestModel.findOneAndUpdate(
    { _id: existing._id, ownerId, status: "pending" },
    {
      status: "declined",
      decidedAt: now,
      declineReason: opts.reason || undefined,
      ...(offer
        ? {
            alternatives: offer.times,
            offerExpiresAt: new Date(
              now.getTime() + BOOKING_LIMITS.offerValidDays * 24 * 60 * 60 * 1000,
            ),
          }
        : {}),
    },
    { new: true },
  );
  if (!declined) {
    throw new BookingError(409, "ALREADY_DECIDED", "This request was already handled.");
  }
  slotCache.clear();

  const owner = await User.findById(ownerId).select("name").lean();
  const link =
    offer?.link ?? (await BookingLinkModel.findOne({ _id: declined.linkId, isActive: true }));
  const pageUrl = link ? bookingUrl(link.slug) : undefined;
  const token = offer ? createOfferToken(String(declined._id)) : undefined;

  await sendBookingRequestDeclinedEmail({
    toEmail: declined.email,
    toName: declined.name,
    hostName: owner?.name ?? "Your host",
    title: declined.linkTitle,
    startTime: declined.startTime,
    endTime: declined.endTime,
    reason: opts.reason,
    rebookUrl: pageUrl,
    alternatives:
      offer && pageUrl && token
        ? offer.times.map((t) => ({
            label: `${formatEatDateTime(t)} (East Africa Time)`,
            url: `${pageUrl}?t=${encodeURIComponent(t.toISOString())}&o=${encodeURIComponent(token)}`,
          }))
        : undefined,
  }).catch((err) => console.error("Booking request declined email failed:", err));
}

// ─────────────────────────────────────────────────────────────────
// Taking a time the host offered
// ─────────────────────────────────────────────────────────────────

/**
 * The declined request behind an offer token, if the offer is still good:
 * genuine token, for THIS link, host really offered times, not used yet,
 * not past its deadline. (Which time, and whose email, the caller checks.)
 */
async function findUsableOffer(
  link: IBookingLink,
  token: unknown,
): Promise<IBookingRequest | null> {
  const requestId = verifyOfferToken(token);
  if (!requestId) return null;
  const req = await BookingRequestModel.findById(requestId);
  if (
    !req ||
    req.status !== "declined" ||
    String(req.linkId) !== String(link._id) ||
    req.offerAcceptedAt ||
    !req.offerExpiresAt ||
    req.offerExpiresAt.getTime() <= Date.now() ||
    req.alternatives.length === 0
  ) {
    return null;
  }
  return req;
}

export interface OfferInfo {
  valid: boolean;
  /** The kind of call the original request was for; an accepted offer keeps it. */
  callType?: CallType;
  name?: string;
  email?: string;
  topic?: string;
  /** The offered times still in the future, ISO strings. */
  times?: string[];
}

/** For the booking page, so it can pre-fill the form and show the offered times. */
export async function getOfferInfo(link: IBookingLink, token: unknown): Promise<OfferInfo> {
  const req = await findUsableOffer(link, token);
  const times = req?.alternatives.filter((a) => a.getTime() > Date.now()) ?? [];
  if (!req || times.length === 0) return { valid: false };
  return {
    valid: true,
    name: req.name,
    email: req.email,
    topic: req.topic ?? "",
    callType: req.callType ?? "video",
    times: times.map((t) => t.toISOString()),
  };
}

/**
 * The client takes one of the offered times: confirmed immediately, no
 * second approval (the host already chose it). The offer is single use.
 *
 * Only a real clash can refuse it — the notice period and booking window
 * are not re-applied, because they were satisfied when the host picked the
 * time and the client may be answering later.
 */
async function bookViaOffer(
  link: IBookingLink,
  input: BookingInput,
  offer: IBookingRequest,
  hostName: string,
): Promise<BookingResult> {
  const ownerId = String(link.ownerId);
  const start = input.start;
  const end = new Date(start.getTime() + link.durationMinutes * 60_000);
  const email = input.email.toLowerCase();
  // An accepted offer keeps the kind of call the client originally asked for.
  const callType: CallType = offer.callType ?? "video";
  const title = `${offer.linkTitle} – ${input.name}${callTypeSuffix(callType)}`;
  const knownClient = await ClientModel.findOne({ $or: [{ email }, { "additionalEmails.email": email }] }).select("_id").lean();

  let meeting: IMeeting;
  try {
    meeting = await withBookingLock(lockKey(ownerId), async () => {
      const claimed = await BookingRequestModel.findOneAndUpdate(
        { _id: offer._id, status: "declined", offerAcceptedAt: null },
        { offerAcceptedAt: new Date() },
        { new: true },
      );
      if (!claimed) {
        throw new BookingError(409, "OFFER_USED", "This offer has already been used.");
      }
      try {
        if (await hasConflict(ownerId, start, end)) {
          throw new BookingError(
            409,
            "SLOT_TAKEN",
            "Sorry, that time was just taken. Please pick another of the offered times.",
          );
        }
        const m = await MeetingModel.create({
          title,
          description: `Booked through the booking link "${offer.linkTitle}" by ${input.name} (${email}), at a time ${hostName} offered after declining the original request.`,
          agenda: input.topic || offer.topic || undefined,
          organizer: link.ownerId,
          attendees: [],
          externalAttendees: [{ email, name: input.name, status: "pending" }],
          startTime: start,
          endTime: end,
          location: link.location || undefined,
          meetingLink: fixedLinkFor(link, callType),
          conferenceProvider: fixedLinkFor(link, callType) ? "custom" : undefined,
          callType,
          status: "scheduled",
          reminderMinutesBefore: 15,
          clientId: knownClient?._id,
          bookingLinkId: link._id,
        });
        await BookingRequestModel.updateOne({ _id: offer._id }, { meetingId: m._id });
        return m;
      } catch (err) {
        // Free the offer so they can try another of the offered times.
        await BookingRequestModel.updateOne(
          { _id: offer._id },
          { $unset: { offerAcceptedAt: 1, meetingId: 1 } },
        );
        throw err;
      }
    });
  } catch (err) {
    if (err instanceof BookingLockTimeout) throw busyError();
    throw err;
  }
  slotCache.clear();

  await finishConfirmedMeeting({
    meeting,
    ownerId,
    ownerName: hostName,
    linkTitle: offer.linkTitle,
    autoZohoMeeting: link.autoZohoMeeting,
    callType,
    clientName: input.name,
    clientEmail: email,
    clientId: knownClient?._id,
    notifyOwner: true,
    activityMessage: `${input.name} took the time ${hostName} offered instead (${formatEatDateTime(start)})`,
    linkId: String(link._id),
  });

  return toResult("confirmed", hostName, {
    callType,
    title,
    startTime: start,
    endTime: end,
    meetingId: String(meeting._id),
    location: meeting.location,
    meetingLink: meeting.meetingLink,
    meetingPassword: meeting.meetingPassword,
  });
}

// ─────────────────────────────────────────────────────────────────
// Scheduled sweep: reminders and expiry
// ─────────────────────────────────────────────────────────────────

/**
 * Run every few minutes (POST /api/cron/booking-requests) and also on
 * demand when an owner opens their queue.
 *
 *  - Expiry: a request past its expiresAt is closed; the client is told the
 *    time was released and can ask again. (The slot itself was already free
 *    the moment expiresAt passed — see liveRequestFilter.)
 *  - Reminder: halfway to that deadline the host gets one nudge.
 *
 * Every action first CLAIMS the request with an atomic update, so two
 * overlapping runs (scheduler + a page load) never double-send.
 */
export async function sweepBookingRequests(
  opts: { ownerId?: string } = {},
): Promise<{ expired: number; reminded: number }> {
  const now = new Date();
  const scope = opts.ownerId ? { ownerId: opts.ownerId } : {};
  let expired = 0;
  let reminded = 0;

  // 1. Lapsed requests
  const lapsed = await BookingRequestModel.find({
    ...scope,
    status: "pending",
    $or: [{ expiresAt: { $lte: now } }, { expiresAt: null, endTime: { $lte: now } }],
  }).limit(200);

  for (const r of lapsed) {
    const claimed = await BookingRequestModel.findOneAndUpdate(
      { _id: r._id, status: "pending" },
      { status: "expired", decidedAt: now },
      { new: true },
    );
    if (!claimed) continue; // answered, or swept by another run, meanwhile
    expired++;
    slotCache.clear();
    try {
      const [owner, link] = await Promise.all([
        User.findById(claimed.ownerId).select("name").lean(),
        BookingLinkModel.findOne({ _id: claimed.linkId, isActive: true }).select("slug"),
      ]);
      await sendBookingRequestExpiredEmail({
        toEmail: claimed.email,
        toName: claimed.name,
        hostName: owner?.name ?? "Your host",
        title: claimed.linkTitle,
        startTime: claimed.startTime,
        endTime: claimed.endTime,
        rebookUrl: link ? bookingUrl(link.slug) : undefined,
      });
      await createNotification(
        String(claimed.ownerId),
        `${claimed.name}'s request for "${claimed.linkTitle}" (${formatEatDateTime(claimed.startTime)}) expired because it wasn't answered. They've been told to pick another time.`,
        "meeting_booking_request",
        { title: claimed.linkTitle, clientName: claimed.name, clientEmail: claimed.email },
      );
    } catch (err) {
      console.error("Booking request expiry notifications failed:", err);
    }
  }

  // 2. Reminders for requests that are still alive
  const due = await BookingRequestModel.find({
    ...scope,
    ...liveRequestFilter(now),
    reminderSent: false,
    reminderAt: { $lte: now },
  }).limit(200);

  for (const r of due) {
    const claimed = await BookingRequestModel.findOneAndUpdate(
      { _id: r._id, status: "pending", reminderSent: false },
      { reminderSent: true },
      { new: true },
    );
    if (!claimed) continue;
    reminded++;
    try {
      const owner = await User.findById(claimed.ownerId).select("name email").lean();
      const lapsesAt = claimed.expiresAt ?? claimed.endTime;
      await createNotification(
        String(claimed.ownerId),
        `${claimed.name} is still waiting for an answer to their request for "${claimed.linkTitle}" (${formatEatDateTime(claimed.startTime)}). It lapses at ${formatEatDateTime(lapsesAt)}.`,
        "meeting_booking_request",
        { title: claimed.linkTitle, clientName: claimed.name, clientEmail: claimed.email },
      );
      if (owner?.email) {
        await sendBookingRequestReminderEmail({
          toEmail: owner.email,
          ownerName: owner.name ?? "there",
          clientName: claimed.name,
          clientEmail: claimed.email,
          title: claimed.linkTitle,
          startTime: claimed.startTime,
          endTime: claimed.endTime,
          expiresAt: lapsesAt,
        });
      }
    } catch (err) {
      console.error("Booking request reminder failed:", err);
    }
  }

  return { expired, reminded };
}