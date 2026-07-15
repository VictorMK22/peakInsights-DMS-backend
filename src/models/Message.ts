import mongoose, { Document, Schema } from "mongoose";

export interface IMessage extends Document {
  _id: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;
  subject?: string;
  body: string;
  isRead: boolean;
  readAt?: Date;
  parentId?: mongoose.Types.ObjectId; // for threading/replies
  // On a root message, bumped every time a reply lands in its thread —
  // lets the inbox/sent lists sort by actual conversation activity
  // instead of when the thread happened to start.
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    subject: { type: String, trim: true },
    body: { type: String, required: true },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
    parentId: { type: Schema.Types.ObjectId, ref: "Message" },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

MessageSchema.index({ receiverId: 1, parentId: 1, lastMessageAt: -1 });
MessageSchema.index({ senderId: 1, parentId: 1, lastMessageAt: -1 });
MessageSchema.index({ parentId: 1, createdAt: 1 });
MessageSchema.index({ receiverId: 1, isRead: 1 });

export const MessageModel = mongoose.model<IMessage>("Message", MessageSchema);
