import mongoose, { Document, Types } from "mongoose";

export interface INotification extends Document {
  userId: Types.ObjectId;
  message: string;
  type: string;
  read: boolean;
  meta?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new mongoose.Schema<INotification>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    message: {
      type: String,
      required: true,
    },

    type: {
      type: String,
      required: true,
    },

    read: {
      type: Boolean,
      default: false,
      index: true,
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true }
);

// Index for fast user notifications
NotificationSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<INotification>(
  "Notification",
  NotificationSchema
);