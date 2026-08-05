import mongoose, { Document, Schema } from "mongoose";

export type ProjectTaskColumn = "backlog" | "todo" | "in_progress" | "review" | "done";
export type ProjectTaskPriority = "low" | "medium" | "high" | "critical";

/**
 * A Kanban card inside a Project (see models/Project.ts).
 *
 * Deliberately separate from models/Task.ts, which drives the
 * existing TAT/efficiency assignment workflow used across the rest
 * of the app (CEO/Supervisor assigns → assignee starts/submits →
 * approval). Project boards need a different shape (a status
 * column, story points, labels, drag-and-drop ordering) without
 * disturbing that existing flow or its reporting.
 */
export interface IProjectTask extends Document {
  _id: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  column: ProjectTaskColumn;
  assignee?: mongoose.Types.ObjectId;
  priority: ProjectTaskPriority;
  labels: string[];
  dueDate?: Date;
  points?: number;
  order: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectTaskSchema = new Schema<IProjectTask>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    column: {
      type: String,
      enum: ["backlog", "todo", "in_progress", "review", "done"],
      default: "backlog",
    },
    assignee: { type: Schema.Types.ObjectId, ref: "User" },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    labels: [{ type: String, trim: true }],
    dueDate: { type: Date },
    points: { type: Number, min: 0 },
    order: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

ProjectTaskSchema.index({ projectId: 1, column: 1, order: 1 });

export const ProjectTask = mongoose.model<IProjectTask>("ProjectTask", ProjectTaskSchema);
