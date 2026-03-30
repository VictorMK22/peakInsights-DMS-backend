import mongoose from "mongoose";

const NotificationSchema = new mongoose.Schema({

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },

  message: String,

  type: String,

  read: {
    type: Boolean,
    default: false
  }

}, { timestamps: true });

export default mongoose.model(
  "Notification",
  NotificationSchema
);