// Stores email communications between employees and clients.
// direction: 'outbound' = employee → client
//            'inbound'  = client → employee (logged manually or via webhook)
//
// All records are visible to CEO and the assigned supervisor.
// Only the author/assigned user can create outbound records.

import mongoose, { Schema, Document } from "mongoose";

export interface IClientEmailAttachment {
  filename: string; // original filename, for display
  fileKey: string; // stored UUID filename on disk (see middleware/upload.ts)
  size: number;
  mimeType: string;
}

export interface IClientEmail extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId; // employee who sent/logged
  direction: "outbound" | "inbound";
  subject: string;
  body: string;
  fromEmail?: string; // client's email (for inbound)
  toEmail?: string; // client's email (for outbound)
  attachments: IClientEmailAttachment[];
  status: "sent" | "received" | "draft" | "failed";
  sentAt?: Date;
  // 'system' = sent through the app's own compose box (SMTP).
  // 'external_sync' = automatically pulled in from a staff member's real
  // mailbox (e.g. Zoho Mail) because it was sent/received outside the app.
  // This is what gives the CEO visibility into off-platform communication.
  source: "system" | "external_sync";
  externalMessageId?: string; // provider's message ID, for de-duplication
  syncedFromUserId?: mongoose.Types.ObjectId; // whose connected mailbox this came from
  createdAt: Date;
  updatedAt: Date;
}

const ClientEmailAttachmentSchema = new Schema<IClientEmailAttachment>(
  {
    filename: { type: String, required: true },
    fileKey: { type: String, required: true },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
  },
  { _id: false },
);

const ClientEmailSchema = new Schema<IClientEmail>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    direction: { type: String, enum: ["outbound", "inbound"], required: true },
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    fromEmail: { type: String, trim: true },
    toEmail: { type: String, trim: true },
    attachments: { type: [ClientEmailAttachmentSchema], default: [] },
    // 'failed' = the record was saved but the actual SMTP delivery to the
    // client failed (e.g. SMTP not configured, bounced, network error).
    // Kept distinct from 'sent' so supervisors/CEO aren't misled into
    // thinking the client actually received it.
    status: {
      type: String,
      enum: ["sent", "received", "draft", "failed"],
      default: "sent",
    },
    sentAt: { type: Date },
    source: {
      type: String,
      enum: ["system", "external_sync"],
      default: "system",
    },
    externalMessageId: { type: String, index: true, sparse: true },
    syncedFromUserId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

ClientEmailSchema.index({ clientId: 1, createdAt: -1 });
ClientEmailSchema.index({ authorId: 1, clientId: 1 });
// Prevents the same external message from being logged twice across sync runs.
ClientEmailSchema.index(
  { externalMessageId: 1 },
  { unique: true, sparse: true },
);

export const ClientEmailModel = mongoose.model<IClientEmail>(
  "ClientEmail",
  ClientEmailSchema,
);
