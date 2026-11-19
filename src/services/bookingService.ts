import crypto from "crypto";
import { BookingLinkModel, IBookingLink, BOOKING_LIMITS } from "../models/BookingLink";
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
} from "./zohoCalendarService";
import {
  sendMeetingInviteEmail,
  sendBookingRequestReceivedEmail,
  sendBookingRequestDeclinedEmail,
  sendBookingRequestOwnerEmail,
} from "./emailService";
import { withBookingLock, BookingLockTimeout } from "./bookingLock";
import { createNotification } from "./notificationService";
import { logMeetingActivity } from "./meetingActivityService";
import { createRsvpToken } from "../utils/meetingRsvpToken";
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
async function pendingRequestIntervals(
  ownerId: string,
  from: Date,
  to: Date,
  excludeRequestId?: string,
): Promise<TimeInterval[]> {
  const rows = await BookingRequestModel.find({
    ownerId,
    status: "pending",
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
  opts: { fresh?: boolean } = {},
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
    ...(await pendingRequestIntervals(String(link.ownerId), busyFrom, busyTo)),
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
}

export interface BookingResult {
  /** "confirmed": it is a meeting now. "pending": waiting for the host to approve. */
  status: "confirmed" | "pending";
  title: string;
  startTime: Date;
  endTime: Date;
  hostName: string;
  meetingId?: string;
  requestId?: string;
  location?: string;
  meetingLink?: string;
}

const lockKey = (ownerId: string) => `owner:${ownerId}`;

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
        }
      }
    } catch (err: any) {
      console.error(
        "Booking: Zoho Meeting creation failed (booking kept):",
        err?.response?.data || err?.message || err,
      );
    }
  }
  if (!meeting.location && meeting.meetingLink) meeting.location = "Online";
  await meeting.save();

  // Full details onto the owner's Zoho Calendar (updates the event made
  // above, or creates one). Best-effort and never throws.
  await pushNewMeetingsToZoho([meeting], ownerId);
  slotCache.clear();

  if (c.notifyOwner) {
    const missingLink = !meeting.meetingLink && c.autoZohoMeeting;
    await createNotification(
      ownerId,
      `${c.clientName} booked "${c.linkTitle}" for ${formatEatDateTime(start)}${
        missingLink ? ". No meeting link could be generated — add one before the call." : ""
      }`,
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
    title: string;
    startTime: Date;
    endTime: Date;
    meetingId?: string;
    requestId?: string;
    location?: string;
    meetingLink?: string;
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
      status: "pending",
      endTime: { $gt: now },
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
      status: "pending",
      endTime: { $gt: now },
    });
    if (waiting >= BOOKING_LIMITS.maxPendingPerLink) {
      throw new BookingError(
        429,
        "TOO_MANY_PENDING",
        "This booking page has several requests waiting for a reply. Please try again later.",
      );
    }
  }

  const title = `${link.title} – ${input.name}`;
  // Tie a confirmed meeting to a CRM client when this email is already one.
  const knownClient = link.requireApproval
    ? null
    : await ClientModel.findOne({ email }).select("_id").lean();

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
        const request = await BookingRequestModel.create({
          linkId: link._id,
          ownerId: link.ownerId,
          linkTitle: link.title,
          startTime: start,
          endTime: end,
          name: input.name,
          email,
          topic: input.topic || undefined,
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
        meetingLink: link.meetingLink || undefined,
        conferenceProvider: link.meetingLink ? "custom" : undefined,
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
      `${input.name} requested "${link.title}" for ${formatEatDateTime(start)}. Approve or decline it in Meetings → Booking links.`,
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
      }).catch((err) => console.error("Booking request owner email failed:", err));
    }
    await sendBookingRequestReceivedEmail({
      toEmail: email,
      toName: input.name,
      hostName,
      title: link.title,
      startTime: start,
      endTime: end,
    }).catch((err) => console.error("Booking request received email failed:", err));

    return toResult("pending", hostName, {
      title: link.title,
      startTime: start,
      endTime: end,
      requestId: String(req._id),
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
    clientName: input.name,
    clientEmail: email,
    clientId: knownClient?._id,
    notifyOwner: true,
    activityMessage: `${input.name} booked "${link.title}" through the booking link for ${formatEatDateTime(start)}`,
    linkId: String(link._id),
  });

  return toResult("confirmed", hostName, {
    title,
    startTime: start,
    endTime: end,
    meetingId: String(meeting._id),
    location: meeting.location,
    meetingLink: meeting.meetingLink,
  });
}

// ─────────────────────────────────────────────────────────────────
// Approving and declining requests
// ─────────────────────────────────────────────────────────────────

/** A request that has been waiting past its own start time can no longer be approved. */
const isExpired = (r: { endTime: Date }) => r.endTime.getTime() <= Date.now();

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
  startTime: Date;
  endTime: Date;
  createdAt: Date;
  /** True once the requested time has passed without a decision: it can only be declined now. */
  expired: boolean;
}

/** The owner's requests that still need a decision (recently-expired ones included so they can be closed out). */
export async function listPendingRequests(ownerId: string): Promise<PendingRequestView[]> {
  const rows = await BookingRequestModel.find({
    ownerId,
    status: "pending",
    endTime: { $gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
  }).sort({ startTime: 1 });
  return rows.map((r) => ({
    _id: String(r._id),
    linkId: String(r.linkId),
    linkTitle: r.linkTitle,
    name: r.name,
    email: r.email,
    topic: r.topic ?? "",
    startTime: r.startTime,
    endTime: r.endTime,
    createdAt: r.createdAt,
    expired: isExpired(r),
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
  if (isExpired(req)) {
    throw new BookingError(
      409,
      "EXPIRED",
      "The requested time has already passed. Decline it to let the client know.",
    );
  }

  const owner = await User.findById(ownerId).select("name isActive").lean();
  const hostName = owner?.name ?? "Your host";
  // The link may have been edited or deleted since the request was made.
  const link = await BookingLinkModel.findById(req.linkId);
  const knownClient = await ClientModel.findOne({ email: req.email }).select("_id").lean();
  const title = `${req.linkTitle} – ${req.name}`;

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
          meetingLink: link?.meetingLink || undefined,
          conferenceProvider: link?.meetingLink ? "custom" : undefined,
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
    clientName: req.name,
    clientEmail: req.email,
    clientId: knownClient?._id,
    notifyOwner: false,
    activityMessage: `${hostName} approved ${req.name}'s booking request for ${formatEatDateTime(req.startTime)}`,
    linkId: String(req.linkId),
  });

  return toResult("confirmed", hostName, {
    title,
    startTime: req.startTime,
    endTime: req.endTime,
    meetingId: String(meeting._id),
    requestId: String(req._id),
    location: meeting.location,
    meetingLink: meeting.meetingLink,
  });
}

/** Owner declines: the slot is freed and the client is told, with an optional note. */
export async function declineBookingRequest(
  requestId: string,
  ownerId: string,
  reason?: string,
): Promise<void> {
  const existing = await loadOwnRequest(requestId, ownerId);
  const declined = await BookingRequestModel.findOneAndUpdate(
    { _id: existing._id, ownerId, status: "pending" },
    { status: "declined", decidedAt: new Date(), declineReason: reason || undefined },
    { new: true },
  );
  if (!declined) {
    throw new BookingError(409, "ALREADY_DECIDED", `This request was already ${existing.status}.`);
  }
  slotCache.clear();

  const owner = await User.findById(ownerId).select("name").lean();
  const link = await BookingLinkModel.findOne({ _id: declined.linkId, isActive: true }).select("slug");
  await sendBookingRequestDeclinedEmail({
    toEmail: declined.email,
    toName: declined.name,
    hostName: owner?.name ?? "Your host",
    title: declined.linkTitle,
    startTime: declined.startTime,
    endTime: declined.endTime,
    reason,
    rebookUrl: link ? bookingUrl(link.slug) : undefined,
  }).catch((err) => console.error("Booking request declined email failed:", err));
}
