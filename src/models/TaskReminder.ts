import mongoose, { Document, Schema } from "mongoose";

/**
 * A personal reminder on a task: "nudge ME at this time".
 *
 * Kept in its own collection (rather than an array on Task) so one person's
 * reminder is never serialised to the other people who can see the task, and
 * so the cron sweep can scan only unsent reminders.
 *
 * One reminder per (task, user). Re-setting it replaces the time and clears
 * `sentAt` so it can fire again.
 */
export interface ITaskReminder extends Document {
  _id: mongoose.Types.ObjectId;
  taskId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  remindAt: Date;
  // Set once the notification has been sent (or deliberately skipped because
  // the task is no longer actionable).
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TaskReminderSchema = new Schema<ITaskReminder>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    remindAt: { type: Date, required: true },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

TaskReminderSchema.index({ taskId: 1, userId: 1 }, { unique: true });
TaskReminderSchema.index({ userId: 1, remindAt: 1 });
// The cron sweep: unsent reminders that are due.
TaskReminderSchema.index({ sentAt: 1, remindAt: 1 });

export const TaskReminderModel = mongoose.model<ITaskReminder>(
  "TaskReminder",
  TaskReminderSchema,
);