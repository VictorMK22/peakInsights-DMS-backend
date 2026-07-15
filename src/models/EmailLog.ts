import mongoose, { Document, Schema } from "mongoose";

export type EmailStatus = "pending" | "sent" | "failed";

export interface IEmailLog extends Document {
  _id: mongoose.Types.ObjectId;

  senderId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;

  toEmail: string;

  subject: string;
  body: string;
  bodyPreview: string;

  status: EmailStatus;
  error?: string;

  // Recipient-side read tracking, mirroring Message.isRead/readAt, so
  // the inbox view can show unread indicators the same way Messages does.
  isRead: boolean;
  readAt?: Date;

  sentAt?: Date;

  // Threading — mirrors Message.parentId/lastMessageAt so replies work
  // the same way they do for Messages. A root email has parentId
  // undefined; a reply has parentId pointing at the root.
  parentId?: mongoose.Types.ObjectId;
  lastMessageAt: Date;

  // Optional tracking (future-ready)
  messageId?: string; // SMTP / provider ID — used as In-Reply-To for the next reply
  references?: string[]; // accumulated Message-ID chain, sent as the References header

  createdAt: Date;
  updatedAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
  {
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    receiverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    toEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    subject: {
      type: String,
      required: true,
      trim: true,
      default: "(No subject)",
    },

    body: {
      type: String,
      required: true,
    },

    bodyPreview: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
      index: true,
    },

    error: {
      type: String,
    },

    isRead: {
      type: Boolean,
      default: false,
    },

    readAt: {
      type: Date,
    },

    sentAt: {
      type: Date,
    },

    parentId: {
      type: Schema.Types.ObjectId,
      ref: "EmailLog",
    },

    lastMessageAt: {
      type: Date,
      default: Date.now,
    },

    messageId: {
      type: String,
    },

    references: {
      type: [String],
      default: undefined,
    },
  },
  { timestamps: true },
);

EmailLogSchema.index({ senderId: 1, createdAt: -1 });
EmailLogSchema.index({ receiverId: 1, createdAt: -1 });
EmailLogSchema.index({ status: 1, createdAt: -1 });
EmailLogSchema.index({ receiverId: 1, isRead: 1 });
EmailLogSchema.index({ receiverId: 1, parentId: 1, lastMessageAt: -1 });
EmailLogSchema.index({ senderId: 1, parentId: 1, lastMessageAt: -1 });
EmailLogSchema.index({ parentId: 1, createdAt: 1 });

export const EmailLog = mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);
