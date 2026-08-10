import mongoose, { Document, Schema } from "mongoose";

export type SprintStatus = "planned" | "active" | "completed";

export interface ISprint extends Document {
  _id: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  name: string;
  goal?: string;
  startDate: Date;
  endDate: Date;
  status: SprintStatus;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SprintSchema = new Schema<ISprint>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    name: { type: String, required: true, trim: true },
    goal: { type: String, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["planned", "active", "completed"],
      default: "planned",
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

SprintSchema.index({ projectId: 1, startDate: -1 });

export const Sprint = mongoose.model<ISprint>("Sprint", SprintSchema);
