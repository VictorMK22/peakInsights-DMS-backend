import mongoose, { Document, Schema } from "mongoose";

/**
 * Per-client audit trail — everything anyone does under a client.
 *
 * Written by utils/clientAudit.ts from the client controllers; read by the
 * CEO and Tech-department supervisors only (see clientAuditController.ts).
 *
 * Rules:
 *  - append-only: updates and deletes are rejected, like AuditLog;
 *  - survives the client: deleting a client does NOT remove its trail;
 *  - never stores secrets — Logins values are never put in `details`.
 */

export const CLIENT_AUDIT_CATEGORIES = [
  "client", // created / imported / edited / deleted
  "assignment", // assigned, allocated, reallocated
  "pipeline", // sales-stage changes
  "email",
  "whatsapp",
  "note",
  "meeting",
  "call",
  "task",
  "document",
  "logins", // Logins section (iTax, eTims, … + extras)
] as const;
export type ClientAuditCategory = (typeof CLIENT_AUDIT_CATEGORIES)[number];

export interface IClientAuditLog extends Document {
  clientId: mongoose.Types.ObjectId;
  clientName?: string; // snapshot, so a deleted client's trail stays readable
  actorId?: mongoose.Types.ObjectId;
  actorName?: string; // snapshot, survives user removal
  actorRole?: string;
  category: ClientAuditCategory;
  action: string; // machine-readable e.g. "note_added"
  summary: string; // human-readable, pre-rendered
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
}

const ClientAuditLogSchema = new Schema<IClientAuditLog>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    clientName: { type: String },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String },
    actorRole: { type: String },
    category: {
      type: String,
      enum: CLIENT_AUDIT_CATEGORIES,
      required: true,
    },
    action: { type: String, required: true },
    summary: { type: String, required: true, maxlength: 1000 },
    details: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
    userAgent: { type: String },
    timestamp: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false },
);

const block = () => {
  throw new Error("Client audit logs cannot be modified or deleted");
};
ClientAuditLogSchema.pre("findOneAndUpdate", block);
ClientAuditLogSchema.pre("updateOne", block);
ClientAuditLogSchema.pre("updateMany", block);
ClientAuditLogSchema.pre("findOneAndDelete", block);
ClientAuditLogSchema.pre("deleteOne", { document: false, query: true }, block);
ClientAuditLogSchema.pre("deleteMany", block);

ClientAuditLogSchema.index({ clientId: 1, timestamp: -1 });
ClientAuditLogSchema.index({ clientId: 1, category: 1, timestamp: -1 });

export const ClientAuditLog = mongoose.model<IClientAuditLog>(
  "ClientAuditLog",
  ClientAuditLogSchema,
);