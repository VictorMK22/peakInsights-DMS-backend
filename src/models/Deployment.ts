import mongoose, { Document, Schema } from "mongoose";

export type DeploymentStatus = "success" | "failed" | "in_progress" | "scheduled" | "rolled_back";
export type DeploymentEnvironment = "production" | "staging" | "development";

export interface IDeployment extends Document {
  _id: mongoose.Types.ObjectId;
  project: string;
  version: string;
  environment: DeploymentEnvironment;
  status: DeploymentStatus;
  deployedBy: mongoose.Types.ObjectId;
  scheduledFor?: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DeploymentSchema = new Schema<IDeployment>(
  {
    project: { type: String, required: true, trim: true },
    version: { type: String, required: true, trim: true },
    environment: {
      type: String,
      enum: ["production", "staging", "development"],
      required: true,
    },
    status: {
      type: String,
      enum: ["success", "failed", "in_progress", "scheduled", "rolled_back"],
      default: "scheduled",
    },
    deployedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scheduledFor: { type: Date },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

DeploymentSchema.index({ status: 1, createdAt: -1 });

export const Deployment = mongoose.model<IDeployment>("Deployment", DeploymentSchema);
