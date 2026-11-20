import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import {
  BookingLinkModel,
  IBookingLink,
  BOOKING_LIMITS,
} from "../models/BookingLink";
import { MeetingModel } from "../models/Meeting";
import { User } from "../models/User";
import {
  BookingError,
  bookingUrl,
  generateSlug,
  getSlotsForLink,
  groupSlotsByEatDay,
  createBookingForLink,
  listPendingRequests,
  approveBookingRequest,
  declineBookingRequest,
  getOfferInfo,
} from "../services/bookingService";
import { EAT_TIMEZONE } from "../utils/eatTime";

// ─────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────

const RESERVED_SLUGS = new Set(["admin", "api", "login", "new", "book", "share"]);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const inRange = (v: unknown, min: number, max: number): v is number =>
  isInt(v) && v >= min && v <= max;

type LinkFields = Partial<
  Pick<
    IBookingLink,
    | "title"
    | "description"
    | "durationMinutes"
    | "bufferMinutes"
    | "minNoticeHours"
    | "maxDaysAhead"
    | "workStartHour"
    | "workEndHour"
    | "workDays"
    | "slotStepMinutes"
    | "location"
    | "meetingLink"
    | "autoZohoMeeting"
    | "requireApproval"
    | "approvalWindowHours"
    | "isActive"
    | "slug"
  >
>;

/**
 * Validates the fields present in `body` (so it serves both create and
 * partial update). Returns the cleaned fields or a message for the owner.
 */
const parseLinkFields = (
  body: Record<string, unknown>,
): { data: LinkFields } | { error: string } => {
  const out: LinkFields = {};

  if (body.title !== undefined) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t || t.length > 120) return { error: "Title is required (max 120 characters)." };
    out.title = t;
  }
  if (body.description !== undefined) {
    const d = typeof body.description === "string" ? body.description.trim() : "";
    if (d.length > 1000) return { error: "Description is too long (max 1000 characters)." };
    out.description = d;
  }
  if (body.durationMinutes !== undefined) {
    if (!inRange(body.durationMinutes, BOOKING_LIMITS.minDurationMinutes, BOOKING_LIMITS.maxDurationMinutes))
      return { error: `Meeting length must be ${BOOKING_LIMITS.minDurationMinutes}–${BOOKING_LIMITS.maxDurationMinutes} minutes.` };
    out.durationMinutes = body.durationMinutes;
  }
  if (body.bufferMinutes !== undefined) {
    if (!inRange(body.bufferMinutes, 0, BOOKING_LIMITS.maxBufferMinutes))
      return { error: `Buffer must be 0–${BOOKING_LIMITS.maxBufferMinutes} minutes.` };
    out.bufferMinutes = body.bufferMinutes;
  }
  if (body.minNoticeHours !== undefined) {
    if (!inRange(body.minNoticeHours, 0, BOOKING_LIMITS.maxMinNoticeHours))
      return { error: `Minimum notice must be 0–${BOOKING_LIMITS.maxMinNoticeHours} hours.` };
    out.minNoticeHours = body.minNoticeHours;
  }
  if (body.maxDaysAhead !== undefined) {
    if (!inRange(body.maxDaysAhead, 1, BOOKING_LIMITS.maxDaysAhead))
      return { error: `Booking window must be 1–${BOOKING_LIMITS.maxDaysAhead} days.` };
    out.maxDaysAhead = body.maxDaysAhead;
  }
  if (body.workStartHour !== undefined) {
    if (!inRange(body.workStartHour, 0, 23)) return { error: "Start hour must be 0–23." };
    out.workStartHour = body.workStartHour;
  }
  if (body.workEndHour !== undefined) {
    if (!inRange(body.workEndHour, 1, 24)) return { error: "End hour must be 1–24." };
    out.workEndHour = body.workEndHour;
  }
  if (body.workDays !== undefined) {
    const days = body.workDays;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => inRange(d, 0, 6)))
      return { error: "Choose at least one available weekday." };
    out.workDays = [...new Set(days as number[])].sort();
  }
  if (body.slotStepMinutes !== undefined) {
    if (!(BOOKING_LIMITS.slotStepOptions as readonly number[]).includes(body.slotStepMinutes as number))
      return { error: `Slot spacing must be one of ${BOOKING_LIMITS.slotStepOptions.join(", ")} minutes.` };
    out.slotStepMinutes = body.slotStepMinutes as number;
  }
  if (body.location !== undefined) {
    const l = typeof body.location === "string" ? body.location.trim() : "";
    if (l.length > 255) return { error: "Location is too long (max 255 characters)." };
    out.location = l;
  }
  if (body.meetingLink !== undefined) {
    const m = typeof body.meetingLink === "string" ? body.meetingLink.trim() : "";
    if (m) {
      let ok = false;
      try {
        ok = /^https?:$/.test(new URL(m).protocol);
      } catch {
        ok = false;
      }
      if (!ok || m.length > 500) return { error: "Meeting link must be a valid http(s) URL." };
    }
    out.meetingLink = m;
  }
  if (body.autoZohoMeeting !== undefined) {
    if (typeof body.autoZohoMeeting !== "boolean") return { error: "autoZohoMeeting must be true or false." };
    out.autoZohoMeeting = body.autoZohoMeeting;
  }
  if (body.requireApproval !== undefined) {
    if (typeof body.requireApproval !== "boolean") return { error: "requireApproval must be true or false." };
    out.requireApproval = body.requireApproval;
  }
  if (body.approvalWindowHours !== undefined) {
    if (!inRange(body.approvalWindowHours, 0, BOOKING_LIMITS.maxApprovalWindowHours))
      return { error: `Reply window must be 0–${BOOKING_LIMITS.maxApprovalWindowHours} hours (0 = until the requested time).` };
    out.approvalWindowHours = body.approvalWindowHours;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") return { error: "isActive must be true or false." };
    out.isActive = body.isActive;
  }
  if (body.slug !== undefined && body.slug !== "") {
    const s = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
    if (!SLUG_PATTERN.test(s) || RESERVED_SLUGS.has(s))
      return { error: "Link name must be 3–40 characters: letters, numbers and hyphens only." };
    out.slug = s;
  }
  return { data: out };
};

const crossFieldError = (l: {
  workStartHour: number;
  workEndHour: number;
  durationMinutes: number;
}): string | null => {
  if (l.workEndHour <= l.workStartHour) return "End hour must be after the start hour.";
  if (l.durationMinutes > (l.workEndHour - l.workStartHour) * 60)
    return "Meeting length doesn't fit inside the working hours.";
  return null;
};

const present = (l: IBookingLink) => ({
  _id: String(l._id),
  slug: l.slug,
  url: bookingUrl(l.slug),
  title: l.title,
  description: l.description ?? "",
  durationMinutes: l.durationMinutes,
  bufferMinutes: l.bufferMinutes,
  minNoticeHours: l.minNoticeHours,
  maxDaysAhead: l.maxDaysAhead,
  workStartHour: l.workStartHour,
  workEndHour: l.workEndHour,
  workDays: l.workDays,
  slotStepMinutes: l.slotStepMinutes,
  location: l.location ?? "",
  meetingLink: l.meetingLink ?? "",
  autoZohoMeeting: l.autoZohoMeeting,
  requireApproval: l.requireApproval,
  approvalWindowHours: l.approvalWindowHours,
  isActive: l.isActive,
  createdAt: l.createdAt,
});

const isDuplicateKey = (err: any) => err?.code === 11000;

// ─────────────────────────────────────────────────────────────────
// Owner endpoints (authenticated) — /api/booking-links
// ─────────────────────────────────────────────────────────────────

export const listMyBookingLinks = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const links = await BookingLinkModel.find({ ownerId: req.user!.userId }).sort({
      createdAt: -1,
    });
    const upcoming = await MeetingModel.aggregate([
      {
        $match: {
          bookingLinkId: { $in: links.map((l) => l._id) },
          status: "scheduled",
          startTime: { $gte: new Date() },
        },
      },
      { $group: { _id: "$bookingLinkId", count: { $sum: 1 } } },
    ]);
    const counts = new Map(upcoming.map((u) => [String(u._id), u.count as number]));
    res.json({
      success: true,
      data: links.map((l) => ({ ...present(l), upcomingBookings: counts.get(String(l._id)) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
};

export const createBookingLink = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = parseLinkFields(req.body ?? {});
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    if (!parsed.data.title) {
      res.status(400).json({ success: false, message: "Title is required." });
      return;
    }
    const merged = {
      workStartHour: 9,
      workEndHour: 17,
      durationMinutes: 30,
      ...parsed.data,
    };
    const bad = crossFieldError(merged);
    if (bad) {
      res.status(400).json({ success: false, message: bad });
      return;
    }

    const { slug: customSlug, ...rest } = parsed.data;
    // A custom link name can collide; a random one practically never does,
    // but retry anyway rather than surface a 500 on the unlucky draw.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const link = await BookingLinkModel.create({
          ...rest,
          ownerId: req.user!.userId,
          slug: customSlug ?? generateSlug(),
        });
        res.status(201).json({ success: true, data: present(link) });
        return;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        if (customSlug) {
          res.status(409).json({ success: false, message: "That link name is already taken. Try another." });
          return;
        }
      }
    }
    res.status(500).json({ success: false, message: "Couldn't create the link. Please try again." });
  } catch (err) {
    next(err);
  }
};

export const updateBookingLink = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const link = await BookingLinkModel.findOne({
      _id: req.params.id,
      ownerId: req.user!.userId,
    });
    if (!link) {
      res.status(404).json({ success: false, message: "Booking link not found." });
      return;
    }
    const parsed = parseLinkFields(req.body ?? {});
    if ("error" in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const bad = crossFieldError({
      workStartHour: parsed.data.workStartHour ?? link.workStartHour,
      workEndHour: parsed.data.workEndHour ?? link.workEndHour,
      durationMinutes: parsed.data.durationMinutes ?? link.durationMinutes,
    });
    if (bad) {
      res.status(400).json({ success: false, message: bad });
      return;
    }
    link.set(parsed.data);
    try {
      await link.save();
    } catch (err) {
      if (isDuplicateKey(err)) {
        res.status(409).json({ success: false, message: "That link name is already taken. Try another." });
        return;
      }
      throw err;
    }
    res.json({ success: true, data: present(link) });
  } catch (err) {
    next(err);
  }
};

/**
 * Deleting a link turns its URL into "no longer available". Meetings
 * already booked through it are ordinary meetings and are left alone.
 */
export const deleteBookingLink = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const r = await BookingLinkModel.deleteOne({
      _id: req.params.id,
      ownerId: req.user!.userId,
    });
    if (r.deletedCount === 0) {
      res.status(404).json({ success: false, message: "Booking link not found." });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ── Booking requests waiting for the owner's approval ────────────

const sendOwnerError = (err: unknown, res: Response, next: NextFunction) =>
  sendError(err, res, next);

export const listBookingRequests = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    res.json({ success: true, data: await listPendingRequests(req.user!.userId) });
  } catch (err) {
    sendOwnerError(err, res, next);
  }
};

export const approveBookingRequestHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await approveBookingRequest(req.params.id, req.user!.userId);
    res.json({ success: true, data: result });
  } catch (err) {
    sendOwnerError(err, res, next);
  }
};

export const declineBookingRequestHandler = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

    // Optional: times to offer the client instead. Shape is checked here;
    // whether each is genuinely free is checked by the service.
    let alternatives: Date[] | undefined;
    if (body.alternatives !== undefined) {
      const raw = body.alternatives;
      if (!Array.isArray(raw) || raw.length > 20) {
        throw new BookingError(400, "INVALID", "Alternative times must be a short list of dates.");
      }
      alternatives = raw.map((v) => {
        const d = typeof v === "string" ? new Date(v) : new Date(NaN);
        if (Number.isNaN(d.getTime())) {
          throw new BookingError(400, "INVALID", "One of the alternative times isn't a valid date.");
        }
        return d;
      });
    }

    await declineBookingRequest(req.params.id, req.user!.userId, {
      reason: reason || undefined,
      alternatives,
    });
    res.json({ success: true });
  } catch (err) {
    sendOwnerError(err, res, next);
  }
};

// ─────────────────────────────────────────────────────────────────
// Public endpoints (no login) — /api/public/booking
// ─────────────────────────────────────────────────────────────────

const loadActiveLink = async (slug: string): Promise<IBookingLink> => {
  const link = await BookingLinkModel.findOne({
    slug: String(slug).toLowerCase(),
    isActive: true,
  });
  if (!link) {
    throw new BookingError(404, "NOT_FOUND", "This booking link isn't available.");
  }
  return link;
};

const sendError = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof BookingError) {
    res.status(err.status).json({ success: false, code: err.code, message: err.message });
    return;
  }
  next(err);
};

/** What the booking page needs to render. Deliberately small — no owner email, id or calendar detail. */
export const getPublicBookingLink = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const link = await loadActiveLink(req.params.slug);
    const owner = await User.findById(link.ownerId).select("name isActive").lean();
    if (!owner || !owner.isActive) {
      throw new BookingError(404, "NOT_FOUND", "This booking link isn't available.");
    }
    res.json({
      success: true,
      data: {
        title: link.title,
        description: link.description ?? "",
        durationMinutes: link.durationMinutes,
        hostName: owner.name,
        location: link.location ?? "",
        isOnline: !!link.meetingLink || link.autoZohoMeeting,
        requiresApproval: link.requireApproval,
        timezone: EAT_TIMEZONE,
        maxDaysAhead: link.maxDaysAhead,
      },
    });
  } catch (err) {
    sendError(err, res, next);
  }
};

const parseDateParam = (v: unknown): Date | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * For a client arriving from a "pick another time" email: whether their
 * offer is still good, plus their details to pre-fill the form and the
 * times the host offered. The token (only ever in their email) is what
 * authorises this — nobody else can read someone's name and email here.
 */
export const getPublicOffer = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const link = await loadActiveLink(req.params.slug);
    res.json({ success: true, data: await getOfferInfo(link, req.query.token) });
  } catch (err) {
    sendError(err, res, next);
  }
};

/** Open slots only. `from` / `to` are optional ISO dates narrowing the window. */
export const getPublicSlots = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const link = await loadActiveLink(req.params.slug);
    const slots = await getSlotsForLink(link, {
      from: parseDateParam(req.query.from),
      to: parseDateParam(req.query.to),
    });
    res.json({
      success: true,
      data: {
        timezone: EAT_TIMEZONE,
        durationMinutes: link.durationMinutes,
        days: groupSlotsByEatDay(slots),
      },
    });
  } catch (err) {
    sendError(err, res, next);
  }
};

export const submitBooking = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Honeypot: a hidden field real people never fill in. Bots do. Answer
    // as if it worked so they learn nothing, and book nothing.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      res.status(201).json({ success: true, data: {} });
      return;
    }

    // Collapse newlines / control characters: the name ends up in email
    // subjects, titles and calendar entries.
    const name =
      typeof body.name === "string"
        ? body.name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
        : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    const start = parseDateParam(body.startTime);

    if (!name || name.length > 100) {
      throw new BookingError(400, "INVALID", "Please enter your name.");
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      throw new BookingError(400, "INVALID", "Please enter a valid email address.");
    }
    if (topic.length > 1000) {
      throw new BookingError(400, "INVALID", "Please keep the topic under 1000 characters.");
    }
    if (!start || start.getTime() <= Date.now()) {
      throw new BookingError(400, "INVALID", "Please choose a time slot.");
    }

    const link = await loadActiveLink(req.params.slug);
    const offer = typeof body.offer === "string" ? body.offer : undefined;
    const result = await createBookingForLink(link, { start, name, email, topic }, offer);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    sendError(err, res, next);
  }
};