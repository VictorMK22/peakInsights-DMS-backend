import mongoose, { Document, Schema } from "mongoose";

/**
 * A public booking page owned by one staff member (typically the CEO).
 *
 * Anyone with the link can see the owner's FREE time slots (never what
 * the busy time is) and book one without an account. A booking becomes a
 * normal Meeting with the client as an external attendee — so it shows up
 * on the owner's calendar, in conflict checks, on Zoho Calendar, and in
 * the client's activity timeline like any other meeting.
 *
 * One owner can have several links (e.g. "15-min intro", "60-min deep
 * dive"), each with its own length, hours and rules.
 *
 * All hours below are East Africa Time (UTC+03:00), matching the rest of
 * the meetings module (see utils/eatTime.ts).
 */

export const BOOKING_LIMITS = {
  minDurationMinutes: 10,
  maxDurationMinutes: 240,
  maxBufferMinutes: 120,
  maxMinNoticeHours: 24 * 14,
  maxDaysAhead: 60,
  slotStepOptions: [5, 10, 15, 20, 30, 60] as const,
  /** Upcoming bookings (confirmed or awaiting approval) one email may hold on a single link. */
  maxUpcomingPerEmail: 3,
  /**
   * Requests that may wait for approval on one link at once. Each one holds
   * a slot, so this stops someone filling the calendar with fake requests.
   */
  maxPendingPerLink: 20,
  /** Longest an approval request may wait before it lapses on its own (a week). */
  maxApprovalWindowHours: 168,
  /** Alternative times a host may offer when declining a request. */
  maxAlternatives: 3,
  /** How long the "pick another time" links in a decline email stay valid. */
  offerValidDays: 7,
} as const;

export interface IBookingLink extends Document {
  _id: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  /** URL segment: <frontend>/book/<slug>. Unique across all links. */
  slug: string;
  title: string;
  description?: string;
  durationMinutes: number;
  /** Free gap kept before and after every existing commitment. */
  bufferMinutes: number;
  /** Earliest bookable time, counted from now (stops "in 10 minutes"). */
  minNoticeHours: number;
  /** How far into the future clients can book. */
  maxDaysAhead: number;
  workStartHour: number; // 0-23, EAT
  workEndHour: number; // 1-24, EAT, exclusive
  workDays: number[]; // 0 = Sunday … 6 = Saturday
  /** Gap between the start times offered, e.g. 30 → 9:00, 9:30, 10:00. */
  slotStepMinutes: number;
  /** Shown to the client (e.g. "Online", "Office – Westlands"). */
  location?: string;
  /** A fixed join link used for every booking. Wins over autoZohoMeeting. */
  meetingLink?: string;
  /** Create a fresh Zoho Meeting for each booking (needs Zoho Calendar). */
  autoZohoMeeting: boolean;
  /**
   * false → a booking is confirmed the moment the client submits it.
   * true  → it becomes a request that holds the slot until the owner
   *         approves (then it is confirmed) or declines (slot freed).
   */
  requireApproval: boolean;
  /**
   * Only with requireApproval: how long a request may wait for an answer
   * before it lapses — the slot is released and the client is told. 0 means
   * "until the requested time itself". Never longer than that anyway.
   */
  approvalWindowHours: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BookingLinkSchema = new Schema<IBookingLink>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000 },
    durationMinutes: {
      type: Number,
      default: 30,
      min: BOOKING_LIMITS.minDurationMinutes,
      max: BOOKING_LIMITS.maxDurationMinutes,
    },
    bufferMinutes: { type: Number, default: 10, min: 0, max: BOOKING_LIMITS.maxBufferMinutes },
    minNoticeHours: { type: Number, default: 24, min: 0, max: BOOKING_LIMITS.maxMinNoticeHours },
    maxDaysAhead: { type: Number, default: 30, min: 1, max: BOOKING_LIMITS.maxDaysAhead },
    workStartHour: { type: Number, default: 9, min: 0, max: 23 },
    workEndHour: { type: Number, default: 17, min: 1, max: 24 },
    workDays: { type: [Number], default: [1, 2, 3, 4, 5] },
    slotStepMinutes: { type: Number, default: 30 },
    location: { type: String, trim: true, maxlength: 255 },
    meetingLink: { type: String, trim: true, maxlength: 500 },
    autoZohoMeeting: { type: Boolean, default: true },
    requireApproval: { type: Boolean, default: false },
    approvalWindowHours: {
      type: Number,
      default: 48,
      min: 0,
      max: BOOKING_LIMITS.maxApprovalWindowHours,
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

BookingLinkSchema.index({ ownerId: 1, createdAt: -1 });

export const BookingLinkModel = mongoose.model<IBookingLink>(
  "BookingLink",
  BookingLinkSchema,
);