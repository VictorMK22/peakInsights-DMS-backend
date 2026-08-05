import mongoose, { Document, Schema } from "mongoose";

/**
 * Automatic activity trail for the Meeting & Calendar module.
 *
 * Every meaningful lifecycle event on a Meeting writes one of these —
 * the whole point being that nobody ever has to manually log "had a
 * meeting" or "meeting got rescheduled" anywhere. See
 * services/meetingActivityService.ts for the writer, and
 * controllers/meetingController.ts for where each action is emitted.
 *
 * This feed serves three surfaces:
 *   - A client's activity timeline (filter by clientId)
 *   - A single meeting's history (filter by meetingId)
 *   - Org-wide reporting/dashboards (unfiltered, recent-first)
 */

export type MeetingActivityAction =
  | "meeting_created"
  | "invitation_sent"
  | "participant_accepted"
  | "participant_declined"
  | "participant_tentative"
  | "meeting_rescheduled"
  | "meeting_updated"
  | "meeting_cancelled"
  | "meeting_completed"
  | "meeting_started"
  | "recording_available";

export interface IMeetingActivity extends Document {
  meetingId: mongoose.Types.ObjectId;
  seriesId?: mongoose.Types.ObjectId;
  clientId?: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  action: MeetingActivityAction;
  message: string; // pre-rendered, human-readable — no need to re-derive display text per surface
  details?: Record<string, unknown>;
  timestamp: Date;
}

const MeetingActivitySchema = new Schema<IMeetingActivity>(
  {
    meetingId: { type: Schema.Types.ObjectId, ref: "Meeting", required: true },
    seriesId: { type: Schema.Types.ObjectId },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: {
      type: String,
      enum: [
        "meeting_created",
        "invitation_sent",
        "participant_accepted",
        "participant_declined",
        "participant_tentative",
        "meeting_rescheduled",
        "meeting_updated",
        "meeting_started",
        "recording_available",
        "meeting_cancelled",
        "meeting_completed",
      ],
      required: true,
    },
    message: { type: String, required: true },
    details: { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false },
);

// Activity entries are an immutable log, same principle as AuditLog.
MeetingActivitySchema.pre("findOneAndUpdate", function () {
  throw new Error("Meeting activity entries cannot be modified");
});

MeetingActivitySchema.index({ meetingId: 1, timestamp: -1 });
MeetingActivitySchema.index({ clientId: 1, timestamp: -1 });
MeetingActivitySchema.index({ timestamp: -1 });

export const MeetingActivityModel = mongoose.model<IMeetingActivity>(
  "MeetingActivity",
  MeetingActivitySchema,
);
