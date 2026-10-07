import mongoose, { Schema, Document } from "mongoose";

export interface IClientMeeting extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId; // who logged the meeting
  title: string;
  scheduledAt: Date;
  attendees: string[]; // free-text names (client-side people, not necessarily system users)
  location?: string; // e.g. "Zoom", "Client office"
  outcome?: string;
  notes?: string;
  // ── Sales-lead tracking ─────────────────────────────────────────
  // Sales people can't delete a meeting once it's set; they can only
  // move the date (with a comment) and mark it done. The idle clock for
  // the lead runs from the moment the meeting was first set
  // (createdAt) until it's marked done, and rescheduling does NOT
  // reset it — that is the whole point of tracking it.
  originalScheduledAt?: Date;
  status: "scheduled" | "done";
  completedAt?: Date;
  rescheduleHistory: {
    from: Date;
    to: Date;
    comment: string;
    changedBy: mongoose.Types.ObjectId;
    changedAt: Date;
  }[];
  comments: {
    body: string;
    authorId: mongoose.Types.ObjectId;
    createdAt: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const ClientMeetingSchema = new Schema<IClientMeeting>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    scheduledAt: { type: Date, required: true },
    attendees: { type: [String], default: [] },
    location: { type: String, trim: true },
    outcome: { type: String, trim: true },
    notes: { type: String },
    originalScheduledAt: { type: Date },
    status: { type: String, enum: ["scheduled", "done"], default: "scheduled" },
    completedAt: { type: Date },
    rescheduleHistory: {
      type: [
        {
          _id: false,
          from: { type: Date, required: true },
          to: { type: Date, required: true },
          comment: { type: String, required: true, trim: true },
          changedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    comments: {
      type: [
        {
          body: { type: String, required: true, trim: true },
          authorId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

ClientMeetingSchema.index({ clientId: 1, scheduledAt: -1 });

export const ClientMeetingModel = mongoose.model<IClientMeeting>(
  "ClientMeeting",
  ClientMeetingSchema,
);
