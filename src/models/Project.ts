import mongoose, { Document, Schema } from "mongoose";

export type ProjectStatus = "planning" | "active" | "on_hold" | "completed";
export type ProjectPriority = "low" | "medium" | "high" | "critical";
export type ProjectRisk = "low" | "medium" | "high";

export interface IProject extends Document {
  _id: mongoose.Types.ObjectId;
  key: string; // short code e.g. "PLAT"
  name: string;
  description?: string;
  status: ProjectStatus;
  priority: ProjectPriority;
  risk: ProjectRisk;
  lead: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  dueDate?: Date;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<IProject>(
  {
    key: { type: String, required: true, uppercase: true, trim: true, maxlength: 8 },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    status: {
      type: String,
      enum: ["planning", "active", "on_hold", "completed"],
      default: "planning",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    risk: { type: String, enum: ["low", "medium", "high"], default: "low" },
    lead: { type: Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ type: Schema.Types.ObjectId, ref: "User" }],
    dueDate: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

ProjectSchema.index({ key: 1 }, { unique: true });
ProjectSchema.index({ status: 1 });

export const Project = mongoose.model<IProject>("Project", ProjectSchema);
