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

  // 'system' = composed through the app's own Emails page (real SMTP send).
  // 'external_sync' = automatically pulled in from a staff member's real
  // mailbox (Zoho) because the two of them emailed each other outside the
  // app entirely. This is what gives visibility into off-platform internal
  // communication (user↔user, user↔supervisor, user↔CEO, CEO↔supervisor).
  source: "system" | "external_sync";
  // Content fingerprint (hash of participants + subject + send-minute),
  // NOT the provider's own message ID — needed because when two staff
  // members email each other and BOTH have Zoho connected, the same
  // message is visible in both mailboxes with two different provider
  // IDs. This fingerprint is what lets the second sync run recognize
  // "I've already logged this" and skip it instead of creating a duplicate.
  dedupeKey?: string;

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

    source: {
      type: String,
      enum: ["system", "external_sync"],
      default: "system",
    },

    dedupeKey: {
      type: String,
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
// Prevents the same staff-to-staff email being logged twice when both
// participants have their mailbox connected and synced independently.
EmailLogSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export const EmailLog = mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);
