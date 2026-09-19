import mongoose, { Document, Schema } from "mongoose";

/**
 * Meeting & Calendar module.
 *
 * Design notes:
 *  - Recurring meetings are *materialized*: creating a meeting with a
 *    recurrence rule generates one Meeting document per occurrence
 *    (bounded — see meetingController.MAX_RECURRING_OCCURRENCES), all
 *    sharing a `seriesId`. This keeps every other piece of the system
 *    (conflict detection, RSVPs, reminders, cancellation of a single
 *    occurrence) working against plain Meeting documents instead of
 *    needing a separate "expand this RRULE for the visible date range"
 *    step everywhere. The tradeoff (a bounded window instead of an
 *    infinite series) is the right one for a business-meetings tool.
 *  - Availability/conflict checking (see services/calendarService.ts)
 *    treats a user as "busy" during a meeting if they are the
 *    organizer, or an invited attendee who has not declined, and the
 *    meeting itself has not been cancelled.
 */

export type MeetingStatus = "scheduled" | "cancelled" | "completed";
export type RsvpStatus = "pending" | "accepted" | "declined" | "tentative";
export type RecurrenceFrequency =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

export interface IMeetingAttendee {
  userId: mongoose.Types.ObjectId;
  status: RsvpStatus;
  respondedAt?: Date;
  // Snapshot of who invited them — always the organizer today, but
  // kept as its own field in case delegated invites are added later.
  invitedAt: Date;
}

// External attendees are invited by email and aren't system users —
// no availability checking or RSVP tracking is possible for them, but
// they still receive the invitation/update/cancellation emails.
export interface IExternalAttendee {
  email: string;
  name?: string;
}

export interface IRecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number; // every N days/weeks/months
  // For weekly/custom: 0=Sunday..6=Saturday. Empty = same weekday as the
  // first occurrence.
  daysOfWeek: number[];
  // Stop generating occurrences after this date (inclusive).
  endDate?: Date;
  // Or stop after N occurrences — endDate and count are mutually
  // exclusive; endDate wins if both are set.
  count?: number;
}

export interface IMeeting extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  agenda?: string;

  organizer: mongoose.Types.ObjectId;
  attendees: IMeetingAttendee[];
  externalAttendees: IExternalAttendee[];

  startTime: Date;
  endTime: Date;

  location?: string;
  meetingLink?: string;

  // Set when meetingLink was auto-generated via the organizer's
  // connected Google account (see services/googleCalendarService.ts)
  // rather than pasted in by hand. "google_meet" links get an extra
  // "Join Google Meet" affordance in the UI and their underlying
  // Calendar event is kept in sync / cleaned up automatically —
  // see meetingController's use of googleEventId below.
  conferenceProvider?: "custom" | "google_meet";
  // The Google Calendar event backing a google_meet meetingLink, on
  // the organizer's own calendar — needed to patch its time on
  // reschedule and delete it on cancellation.
  googleEventId?: string;

  status: MeetingStatus;
  cancellationReason?: string;

  // Recurrence — only present on the series "master" definition, but
  // copied onto every generated occurrence so each instance knows the
  // rule it came from and can be displayed/edited consistently.
  recurrence: IRecurrenceRule;
  seriesId?: mongoose.Types.ObjectId; // groups occurrences of the same series
  isRecurringInstance: boolean;
  occurrenceIndex?: number; // 0-based position within the series

  // CEO/tech broadcast scheduling — when a meeting was created by
  // targeting whole departments rather than (or in addition to) named
  // attendees, we keep a record of the scope for display purposes.
  targetDepartments: string[];
  organizationWide: boolean;

  // Reminders
  reminderMinutesBefore: number;
  reminderSent: boolean;

  clientId?: mongoose.Types.ObjectId; // optional link to a CRM client

  createdAt: Date;
  updatedAt: Date;
}

const MeetingAttendeeSchema = new Schema<IMeetingAttendee>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "tentative"],
      default: "pending",
    },
    respondedAt: { type: Date },
    invitedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ExternalAttendeeSchema = new Schema<IExternalAttendee>(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
  },
  { _id: false },
);

const RecurrenceRuleSchema = new Schema<IRecurrenceRule>(
  {
    frequency: {
      type: String,
      enum: ["none", "daily", "weekly", "monthly", "custom"],
      default: "none",
    },
    interval: { type: Number, default: 1, min: 1 },
    daysOfWeek: { type: [Number], default: [] },
    endDate: { type: Date },
    count: { type: Number },
  },
  { _id: false },
);

const MeetingSchema = new Schema<IMeeting>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    agenda: { type: String, trim: true },

    organizer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    attendees: { type: [MeetingAttendeeSchema], default: [] },
    externalAttendees: { type: [ExternalAttendeeSchema], default: [] },

    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },

    location: { type: String, trim: true },
    meetingLink: { type: String, trim: true },
    conferenceProvider: { type: String, enum: ["custom", "google_meet"] },
    googleEventId: { type: String },

    status: {
      type: String,
      enum: ["scheduled", "cancelled", "completed"],
      default: "scheduled",
    },
    cancellationReason: { type: String, trim: true },

    recurrence: {
      type: RecurrenceRuleSchema,
      default: () => ({ frequency: "none", interval: 1, daysOfWeek: [] }),
    },
    seriesId: { type: Schema.Types.ObjectId },
    isRecurringInstance: { type: Boolean, default: false },
    occurrenceIndex: { type: Number },

    targetDepartments: { type: [String], default: [] },
    organizationWide: { type: Boolean, default: false },

    reminderMinutesBefore: { type: Number, default: 15, min: 0 },
    reminderSent: { type: Boolean, default: false },

    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
  },
  { timestamps: true },
);

MeetingSchema.index({ organizer: 1, startTime: -1 });
MeetingSchema.index({ "attendees.userId": 1, startTime: -1 });
MeetingSchema.index({ startTime: 1, endTime: 1, status: 1 });
MeetingSchema.index({ seriesId: 1 });
MeetingSchema.index({ status: 1, reminderSent: 1, startTime: 1 });

export const MeetingModel = mongoose.model<IMeeting>("Meeting", MeetingSchema);
