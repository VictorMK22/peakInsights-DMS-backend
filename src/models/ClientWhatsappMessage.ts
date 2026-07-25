import mongoose, { Schema, Document } from "mongoose";

export interface IClientWhatsappMessage extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId?: mongoose.Types.ObjectId; // staff member who sent it (outbound only)
  direction: "outbound" | "inbound";
  body: string;
  mediaUrl?: string; // signed URL to a downloaded media attachment, if any
  mediaMimeType?: string;
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
    body: { type: String, required: true },
    mediaUrl: { type: String },
    mediaMimeType: { type: String },
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
