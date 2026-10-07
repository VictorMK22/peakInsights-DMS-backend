import mongoose, { Document, Schema } from "mongoose";

export type EmailStatus = "pending" | "sent" | "failed";

// A file attached to an email — either uploaded by the sender in the app, or
// pulled from a synced mailbox. `fileKey` is the S3 key (never a URL; fresh
// signed URLs are built at read time, see services/emailAttachmentService.ts).
export interface IEmailAttachment {
  fileKey: string;
  filename: string;
  mimeType?: string;
  size?: number;
  // Content-ID for images embedded in an HTML body via <img src="cid:...">.
  // Synced emails use this so inline images can be resolved to a real URL.
  contentId?: string;
}

export interface IEmailLog extends Document {
  _id: mongoose.Types.ObjectId;

  senderId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;

  toEmail: string;

  // Carbon-copy recipients (staff users). CC'd users can see the email
  // in their inbox and open the thread, but replies still go to the
  // original sender/receiver pair.
  ccIds?: mongoose.Types.ObjectId[];
  ccEmails?: string[];

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

  attachments?: IEmailAttachment[];
  // Set when the attachment backfill has looked at this synced email (whether
  // or not it found anything), so one that keeps failing can't starve the rest.
  attachmentsCheckedAt?: Date;

  // Announcement ("send to everyone") support. A broadcast is stored as one
  // EmailLog per recipient (so every person has their own inbox copy, read
  // state and reply thread), all sharing a broadcastId. Only the "lead" copy
  // is shown in the sender's Sent list, so one announcement = one row.
  broadcastId?: mongoose.Types.ObjectId;
  broadcastLead?: boolean;
  broadcastRecipientCount?: number;
  // Set once someone replies — lets a broadcaster's inbox surface the
  // recipient copies that actually received a reply.
  hasReplies?: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const EmailAttachmentSchema = new Schema<IEmailAttachment>(
  {
    fileKey: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String },
    size: { type: Number },
    contentId: { type: String },
  },
  { _id: true },
);

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

    ccIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: undefined,
    },

    ccEmails: {
      type: [String],
      default: undefined,
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

    attachments: {
      type: [EmailAttachmentSchema],
      default: undefined,
    },

    attachmentsCheckedAt: { type: Date },

    broadcastId: { type: Schema.Types.ObjectId },
    broadcastLead: { type: Boolean },
    broadcastRecipientCount: { type: Number },
    hasReplies: { type: Boolean },
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
EmailLogSchema.index({ ccIds: 1, parentId: 1, lastMessageAt: -1 });
EmailLogSchema.index({ broadcastId: 1, status: 1 });
// Prevents the same staff-to-staff email being logged twice when both
// participants have their mailbox connected and synced independently.
EmailLogSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

export const EmailLog = mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);
