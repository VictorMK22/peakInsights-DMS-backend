import mongoose, { Document, Schema } from "mongoose";

/**
 * One row per join/leave pair for a participant in a meeting's
 * LiveKit room. Written automatically by
 * services/livekitService.handleLivekitWebhookEvent — nobody ever
 * marks attendance by hand.
 *
 * A participant can have multiple rows for one meeting (reconnects);
 * summing durationSeconds across their rows for a meetingId gives
 * total attendance time, and count(rows) with no leftAt tells you
 * who's currently in the call.
 */

export interface IMeetingAttendance extends Document {
  _id: mongoose.Types.ObjectId;
  meetingId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId; // set when identity was a valid internal user id
  identity: string; // raw LiveKit participant identity (userId, or an external label)
  name: string;
  joinedAt: Date;
  leftAt?: Date;
  durationSeconds?: number;
}

const MeetingAttendanceSchema = new Schema<IMeetingAttendance>({
  meetingId: { type: Schema.Types.ObjectId, ref: "Meeting", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  identity: { type: String, required: true },
  name: { type: String, required: true },
  joinedAt: { type: Date, required: true },
  leftAt: { type: Date },
  durationSeconds: { type: Number },
});

MeetingAttendanceSchema.index({ meetingId: 1, joinedAt: 1 });
MeetingAttendanceSchema.index({ meetingId: 1, identity: 1, leftAt: 1 });

export const MeetingAttendanceModel = mongoose.model<IMeetingAttendance>(
  "MeetingAttendance",
  MeetingAttendanceSchema,
);
