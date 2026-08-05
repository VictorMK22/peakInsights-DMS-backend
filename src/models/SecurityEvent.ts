import mongoose, { Document, Schema } from "mongoose";

export type SecurityEventType = "login" | "failed_login" | "incident" | "vulnerability" | "permission_change";
export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ISecurityEvent extends Document {
  _id: mongoose.Types.ObjectId;
  type: SecurityEventType;
  actor?: mongoose.Types.ObjectId; // set for login/failed_login/permission_change
  actorLabel?: string; // free-text fallback (e.g. email that doesn't match a user, or "System")
  detail: string;
  severity: SecuritySeverity;
  ipAddress?: string;
  timestamp: Date;
}

const SecurityEventSchema = new Schema<ISecurityEvent>(
  {
    type: {
      type: String,
      enum: ["login", "failed_login", "incident", "vulnerability", "permission_change"],
      required: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
    actorLabel: { type: String, trim: true },
    detail: { type: String, required: true },
    severity: {
      type: String,
      enum: ["info", "low", "medium", "high", "critical"],
      default: "info",
    },
    ipAddress: { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

SecurityEventSchema.index({ timestamp: -1 });
SecurityEventSchema.index({ type: 1, timestamp: -1 });
SecurityEventSchema.index({ severity: 1, timestamp: -1 });

export const SecurityEvent = mongoose.model<ISecurityEvent>("SecurityEvent", SecurityEventSchema);
