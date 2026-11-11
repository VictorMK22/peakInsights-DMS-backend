import mongoose, { Document, Schema } from "mongoose";

/**
 * A reminder on one item of a personal to-do list: "nudge me at this time".
 *
 * Kept in its own collection rather than on the item because the list editor
 * re-sends the whole items array on every save (see todoController.cleanItems),
 * which would silently wipe any extra field stored on an item.
 *
 * One reminder per (list, item). Re-setting replaces the time and clears
 * `sentAt` so it can fire again.
 */
export interface ITodoReminder extends Document {
  _id: mongoose.Types.ObjectId;
  listId: mongoose.Types.ObjectId;
  itemId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  remindAt: Date;
  // Set once the notification was sent (or deliberately skipped because the
  // item is done / gone).
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TodoReminderSchema = new Schema<ITodoReminder>(
  {
    listId: { type: Schema.Types.ObjectId, ref: "TodoList", required: true },
    itemId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    remindAt: { type: Date, required: true },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

TodoReminderSchema.index({ listId: 1, itemId: 1 }, { unique: true });
TodoReminderSchema.index({ userId: 1, remindAt: 1 });
// The cron sweep: unsent reminders that are due.
TodoReminderSchema.index({ sentAt: 1, remindAt: 1 });

export const TodoReminderModel = mongoose.model<ITodoReminder>(
  "TodoReminder",
  TodoReminderSchema,
);