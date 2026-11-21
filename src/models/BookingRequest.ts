import mongoose, { Document, Schema } from "mongoose";
import { CALL_TYPES, CallType } from "./BookingLink";

/**
 * A client's booking that is waiting for the link owner's decision (only
 * created by booking links with requireApproval on).
 *
 * It deliberately is NOT a Meeting: nothing is on the owner's calendar,
 * nobody is invited, no reminders run and no Zoho event exists until the
 * owner approves. Approving creates the real Meeting (and links it back
 * here through meetingId); declining just closes the request.
 *
 * While "pending" it HOLDS its time slot — the booking page treats it as
 * busy — so two clients can't both be promised the same time.
 *
 * A pending request also LAPSES on its own: expiresAt is when it stops
 * holding the slot. The booking page honors expiresAt immediately (so a
 * late scheduler can't leave a slot blocked), and the periodic sweep then
 * marks the request "expired" and tells the client.
 *
 * A declined request can carry alternative times the host offered. The
 * client's emailed links let them book exactly those times, once, without
 * going through approval again (the host already said yes to them).
 */

export type BookingRequestStatus = "pending" | "approved" | "declined" | "expired";

export interface IBookingRequest extends Document {
  _id: mongoose.Types.ObjectId;
  linkId: mongoose.Types.ObjectId;
  ownerId: mongoose.Types.ObjectId;
  /** Copied from the link so the request still reads properly if it is later renamed or deleted. */
  linkTitle: string;
  startTime: Date;
  endTime: Date;
  name: string;
  email: string;
  topic?: string;
  /** What the client asked for; carried onto the meeting when it is approved. */
  callType: CallType;
  status: BookingRequestStatus;
  /** When this stops holding the slot. Absent on old records: treat as endTime. */
  expiresAt?: Date;
  /** When to nudge the host about it (halfway to expiry). */
  reminderAt?: Date;
  reminderSent: boolean;
  /** The Meeting created on approval, or from an accepted offer. */
  meetingId?: mongoose.Types.ObjectId;
  decidedAt?: Date;
  declineReason?: string;
  /** Times the host offered when declining. */
  alternatives: Date[];
  offerExpiresAt?: Date;
  /** Set the moment the client takes one of the offered times (single use). */
  offerAcceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const BookingRequestSchema = new Schema<IBookingRequest>(
  {
    linkId: { type: Schema.Types.ObjectId, ref: "BookingLink", required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    linkTitle: { type: String, required: true, maxlength: 120 },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    topic: { type: String, trim: true, maxlength: 1000 },
    callType: { type: String, enum: CALL_TYPES, default: "video" },
    status: {
      type: String,
      enum: ["pending", "approved", "declined", "expired"],
      default: "pending",
    },
    expiresAt: { type: Date },
    reminderAt: { type: Date },
    reminderSent: { type: Boolean, default: false },
    meetingId: { type: Schema.Types.ObjectId, ref: "Meeting" },
    decidedAt: { type: Date },
    declineReason: { type: String, trim: true, maxlength: 500 },
    alternatives: { type: [Date], default: [] },
    offerExpiresAt: { type: Date },
    offerAcceptedAt: { type: Date },
  },
  { timestamps: true },
);

// "What is the owner holding / waiting on right now?"
BookingRequestSchema.index({ ownerId: 1, status: 1, endTime: 1 });
BookingRequestSchema.index({ linkId: 1, status: 1 });
// The periodic sweep: "what has lapsed / is due a reminder?"
BookingRequestSchema.index({ status: 1, expiresAt: 1 });

export const BookingRequestModel = mongoose.model<IBookingRequest>(
  "BookingRequest",
  BookingRequestSchema,
);