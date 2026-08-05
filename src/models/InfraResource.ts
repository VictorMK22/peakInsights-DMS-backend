import mongoose, { Document, Schema } from "mongoose";

export type InfraType = "server" | "database" | "api" | "network" | "storage";
export type InfraStatus = "healthy" | "warning" | "critical" | "offline";

/**
 * Infrastructure monitoring is only as real as whatever reports into
 * it. This model stores the *last known* state for a resource; a
 * resource is considered "offline" once its lastHeartbeatAt is more
 * than STALE_AFTER_MINUTES old (checked at read time, see
 * infraController.getAllInfra). Nothing in this codebase pushes a
 * heartbeat yet — that requires either an agent/cron job on each
 * server calling PUT /api/infrastructure/:id/heartbeat, or a manual
 * update from the ICT team. Until one of those exists, treat every
 * row as manually-maintained status, not live telemetry.
 */
export const STALE_AFTER_MINUTES = 10;

export interface IInfraResource extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  type: InfraType;
  region?: string;
  status: InfraStatus;
  uptimePercent?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  diskPercent?: number;
  responseMs?: number;
  lastHeartbeatAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const InfraResourceSchema = new Schema<IInfraResource>(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ["server", "database", "api", "network", "storage"],
      required: true,
    },
    region: { type: String, trim: true },
    status: {
      type: String,
      enum: ["healthy", "warning", "critical", "offline"],
      default: "offline",
    },
    uptimePercent: { type: Number, min: 0, max: 100 },
    cpuPercent: { type: Number, min: 0, max: 100 },
    memoryPercent: { type: Number, min: 0, max: 100 },
    diskPercent: { type: Number, min: 0, max: 100 },
    responseMs: { type: Number, min: 0 },
    lastHeartbeatAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

InfraResourceSchema.index({ type: 1 });

export const InfraResource = mongoose.model<IInfraResource>("InfraResource", InfraResourceSchema);
