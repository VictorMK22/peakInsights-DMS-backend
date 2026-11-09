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
  // Group sends ("selected people" / "everyone"): stored as one message per
  // recipient (own read state + reply thread) sharing a broadcastId. Only
  // the "lead" copy appears in the sender's Sent list.
  broadcastId?: mongoose.Types.ObjectId;
  broadcastLead?: boolean;
  broadcastRecipientCount?: number;
  broadcastAudience?: "selected" | "everyone";
  // Set on a root once someone replies, so a broadcaster's inbox surfaces
  // replies that land on non-lead copies.
  hasReplies?: boolean;
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
    broadcastId: { type: Schema.Types.ObjectId },
    broadcastLead: { type: Boolean },
    broadcastRecipientCount: { type: Number },
    broadcastAudience: { type: String, enum: ["selected", "everyone"] },
    hasReplies: { type: Boolean },
  },
  { timestamps: true },
);

MessageSchema.index({ receiverId: 1, parentId: 1, lastMessageAt: -1 });
MessageSchema.index({ senderId: 1, parentId: 1, lastMessageAt: -1 });
MessageSchema.index({ parentId: 1, createdAt: 1 });
MessageSchema.index({ receiverId: 1, isRead: 1 });
MessageSchema.index({ broadcastId: 1 });

export const MessageModel = mongoose.model<IMessage>("Message", MessageSchema);