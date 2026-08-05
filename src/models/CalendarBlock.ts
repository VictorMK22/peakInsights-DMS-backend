import mongoose, { Document, Schema } from "mongoose";

/**
 * A block of time a user has marked as unavailable on their personal
 * calendar — out-of-office, a personal appointment, focus time, etc.
 * Distinct from Meeting: nobody else is invited, there's no RSVP, but
 * it still counts as "busy" for conflict detection (see
 * services/calendarService.ts) so meeting organizers see it the same
 * way they'd see a genuine meeting conflict.
 */

export type CalendarBlockType = "busy" | "out_of_office" | "personal";

export interface ICalendarBlock extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  title: string;
  type: CalendarBlockType;
  startTime: Date;
  endTime: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CalendarBlockSchema = new Schema<ICalendarBlock>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true, default: "Unavailable" },
    type: {
      type: String,
      enum: ["busy", "out_of_office", "personal"],
      default: "busy",
    },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

CalendarBlockSchema.index({ userId: 1, startTime: 1, endTime: 1 });

export const CalendarBlockModel = mongoose.model<ICalendarBlock>(
  "CalendarBlock",
  CalendarBlockSchema,
);
