import mongoose, { Schema, Document } from "mongoose";

export interface IClientWhatsappMessage extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId?: mongoose.Types.ObjectId; // staff member who sent it (outbound only)
  direction: "outbound" | "inbound";
  messageType: string; // "text" | "image" | "document" | "audio" | "video" | "location" | "contacts" | "interactive" | "button" | "unknown"
  body: string;
  mediaUrl?: string; // signed URL to a downloaded media attachment, if any
  mediaMimeType?: string;
  // Structured payload for message types that aren't a simple caption,
  // e.g. { latitude, longitude, name, address } for location or the
  // selected button/list id for interactive replies. Kept separate from
  // `body` (which always holds a human-readable summary) so the UI can
  // render richer content without re-parsing the raw webhook payload.
  metadata?: Record<string, unknown>;
  // Meta's own identifiers — used to de-duplicate webhook deliveries and
  // to correlate delivery/read receipts back to a stored message.
  waMessageId?: string;
  waStatus: "queued" | "sent" | "delivered" | "read" | "failed";
  waError?: string;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ClientWhatsappMessageSchema = new Schema<IClientWhatsappMessage>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User" },
    direction: { type: String, enum: ["outbound", "inbound"], required: true },
    messageType: { type: String, default: "text" },
    body: { type: String, required: true },
    mediaUrl: { type: String },
    mediaMimeType: { type: String },
    metadata: { type: Schema.Types.Mixed },
    waMessageId: { type: String, index: true, unique: true, sparse: true },
    waStatus: {
      type: String,
      enum: ["queued", "sent", "delivered", "read", "failed"],
      default: "queued",
    },
    waError: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

ClientWhatsappMessageSchema.index({ clientId: 1, timestamp: -1 });

export const ClientWhatsappMessageModel =
  mongoose.model<IClientWhatsappMessage>(
    "ClientWhatsappMessage",
    ClientWhatsappMessageSchema,
  );
