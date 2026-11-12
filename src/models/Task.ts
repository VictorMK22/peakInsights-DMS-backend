import mongoose, { Document, Schema } from "mongoose";
import { signTaskFiles } from "../utils/taskFileUrls";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "submitted"
  | "completed"
  | "rejected"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

/**
 * Design:
 *
 * TAT lifecycle:
 *   1. CEO/Supervisor creates task (optionally uploads supporting files)
 *   2. Assignee reviews the task (brief, files, deadline) and confirms
 *      they have → assigneeReviewedAt recorded. Only then can they set a
 *      target time, so the commitment reflects how easy or hard it is.
 *   3. Assignee sets targetMinutes + starts        → in_progress, startedAt recorded
 *   4. Assignee submits with supporting documents  → submitted
 *   5. Supervisor/CEO reviews linked documents     → completed OR rejected
 *
 * efficiencyRatio = targetMinutes / tatMinutes
 *   > 1.0  finished faster than committed (excellent)
 *   = 1.0  exactly on target
 *   < 1.0  overran target (needs attention)
 *
 * Task-to-Document linking:
 *   - documentId: primary document this task is about
 *   - submissionDocuments: documents the assignee attaches when submitting
 *   - taskFiles: files uploaded by CEO/Supervisor when creating the task
 *     (context/brief/requirements for the assignee)
 */

export interface ITaskCollaborator {
  userId: mongoose.Types.ObjectId;
  invitedAt: Date;
  respondedAt?: Date;
  revokedAt?: Date;
  // 'pending'  — invited, awaiting the invitee's response (no task access yet)
  // 'active'   — accepted; can perform task operations (start/submit)
  // 'declined' — invitee turned down the invitation
  // 'revoked'  — access withdrawn (by the assignee/CEO, or automatically
  //              on task completion/cancellation)
  status: "pending" | "active" | "revoked" | "declined";
}

export interface IApprovalHistory {
  action: "approved" | "rejected";
  by: mongoose.Types.ObjectId;
  at: Date;
  reason?: string;
}

export interface ITaskFile {
  fileName: string;
  fileKey: string;
  fileUrl: string;
  fileSize: number;
  fileType: string;
  uploadedBy: mongoose.Types.ObjectId;
  uploadedAt: Date;
}

export interface ITask extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  assignedBy: mongoose.Types.ObjectId;
  assignedTo: mongoose.Types.ObjectId;

  // Primary linked document (e.g. a working doc the task is about)
  documentId?: mongoose.Types.ObjectId;

  // Optional link back to a client — surfaces this task under that
  // client's "Tasks" tab (see clientController.getClientTasks).
  clientId?: mongoose.Types.ObjectId;

  // Files uploaded by CEO/Supervisor when creating the task
  // (context files, briefs, requirements for the assignee)
  taskFiles: ITaskFile[];

  // Documents attached by the assignee when submitting for approval
  // The reviewer can open these to approve/reject the task
  submissionDocuments: mongoose.Types.ObjectId[];

  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date;

  // Assignee's pre-start review: set when they confirm they have gone
  // through the task. Required before a target time can be set/started.
  assigneeReviewedAt?: Date;
  assigneeReviewedBy?: mongoose.Types.ObjectId;

  // TAT
  targetMinutes?: number;
  startedAt?: Date;
  submittedAt?: Date;
  completedAt?: Date;
  tatMinutes?: number;
  efficiencyRatio?: number;

  // Submission
  submissionComment?: string;
  rejectionReason?: string;

  // Approval history (full trail)
  approvalHistory: IApprovalHistory[];

  // Collaboration
  collaborators: ITaskCollaborator[];

  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  approvedAt?: Date;
  approvalDurationMinutes?: number;
}

const TaskFileSchema = new Schema<ITaskFile>(
  {
    fileName: { type: String, required: true },
    fileKey: { type: String, required: true },
    fileUrl: { type: String, required: true },
    fileSize: { type: Number, required: true },
    fileType: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const TaskCollaboratorSchema = new Schema<ITaskCollaborator>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    invitedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date },
    revokedAt: { type: Date },
    status: {
      type: String,
      enum: ["pending", "active", "revoked", "declined"],
      default: "pending",
    },
  },
  { _id: false },
);

const ApprovalHistorySchema = new Schema<IApprovalHistory>(
  {
    action: { type: String, enum: ["approved", "rejected"], required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
    reason: { type: String },
  },
  { _id: false },
);

const TaskSchema = new Schema<ITask>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: true },

    documentId: { type: Schema.Types.ObjectId, ref: "Document" },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    taskFiles: { type: [TaskFileSchema], default: [] },
    submissionDocuments: [{ type: Schema.Types.ObjectId, ref: "Document" }],

    status: {
      type: String,
      enum: [
        "pending",
        "in_progress",
        "submitted",
        "completed",
        "rejected",
        "cancelled",
      ],
      default: "pending",
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
    dueDate: { type: Date },

    // TAT
    assigneeReviewedAt: { type: Date },
    assigneeReviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    targetMinutes: { type: Number, min: 1 },
    startedAt: { type: Date },
    submittedAt: { type: Date },
    completedAt: { type: Date },
    tatMinutes: { type: Number },
    efficiencyRatio: { type: Number },
    approvedAt: { type: Date },
    approvalDurationMinutes: { type: Number },

    // Submission
    submissionComment: { type: String },
    rejectionReason: { type: String },

    // Approval trail
    approvalHistory: { type: [ApprovalHistorySchema], default: [] },

    // Collaboration
    collaborators: { type: [TaskCollaboratorSchema], default: [] },

    notes: { type: String },
  },
  { timestamps: true },
);

// Brief-file links are signed and short-lived, so never serve the copy that
// was stored at upload time: rebuild them from the file key on every
// serialisation (covers every endpoint that returns a task document).
TaskSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, any>) => {
    if (Array.isArray(ret.taskFiles)) ret.taskFiles = signTaskFiles(ret.taskFiles);
    return ret;
  },
});

TaskSchema.index({ assignedTo: 1, status: 1 });
TaskSchema.index({ assignedBy: 1, createdAt: -1 });
TaskSchema.index({ documentId: 1 });
TaskSchema.index({ clientId: 1 });
TaskSchema.index({ submissionDocuments: 1 });
TaskSchema.index({ assignedTo: 1, efficiencyRatio: -1 });
TaskSchema.index({ "collaborators.userId": 1 });

export const TaskModel = mongoose.model<ITask>("Task", TaskSchema);