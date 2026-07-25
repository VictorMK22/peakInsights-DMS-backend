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
  },
  { timestamps: true },
);

ClientMeetingSchema.index({ clientId: 1, scheduledAt: -1 });

export const ClientMeetingModel = mongoose.model<IClientMeeting>(
  "ClientMeeting",
  ClientMeetingSchema,
);
