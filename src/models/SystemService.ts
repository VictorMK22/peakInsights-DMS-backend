import mongoose, { Document, Schema } from "mongoose";

export type SystemType = "application" | "api" | "job" | "service" | "worker";
export type SystemStatus = "running" | "failed" | "restart_required" | "offline";

/**
 * Same "last known state" caveat as InfraResource — see that file's
 * comment. lastRunAt is set whenever a job/worker checks in; nothing
 * calls PUT /api/systems/:id/heartbeat automatically yet.
 */
export interface ISystemService extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  type: SystemType;
  status: SystemStatus;
  owner?: mongoose.Types.ObjectId;
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SystemServiceSchema = new Schema<ISystemService>(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["application", "api", "job", "service", "worker"],
      required: true,
    },
    status: {
      type: String,
      enum: ["running", "failed", "restart_required", "offline"],
      default: "running",
    },
    owner: { type: Schema.Types.ObjectId, ref: "User" },
    lastRunAt: { type: Date },
    nextRunAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

export const SystemService = mongoose.model<ISystemService>("SystemService", SystemServiceSchema);
