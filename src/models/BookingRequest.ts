import mongoose, { Document, Schema } from "mongoose";

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
 * A pending request whose time has already passed is treated as expired
 * (it no longer holds anything and can't be approved); the status field
 * is left alone, and callers compare endTime with now.
 */

export type BookingRequestStatus = "pending" | "approved" | "declined";

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
  status: BookingRequestStatus;
  /** The Meeting created on approval. */
  meetingId?: mongoose.Types.ObjectId;
  decidedAt?: Date;
  declineReason?: string;
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
    status: {
      type: String,
      enum: ["pending", "approved", "declined"],
      default: "pending",
    },
    meetingId: { type: Schema.Types.ObjectId, ref: "Meeting" },
    decidedAt: { type: Date },
    declineReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

// "What is the owner holding / waiting on right now?"
BookingRequestSchema.index({ ownerId: 1, status: 1, endTime: 1 });
BookingRequestSchema.index({ linkId: 1, status: 1 });

export const BookingRequestModel = mongoose.model<IBookingRequest>(
  "BookingRequest",
  BookingRequestSchema,
);
