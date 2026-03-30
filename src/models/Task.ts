import mongoose, { Document, Schema } from 'mongoose';

export type TaskStatus   = 'pending' | 'in_progress' | 'submitted' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

// ─── System design ────────────────────────────────────────────────
//
// ALL measurement and collaboration lives on Tasks, not Documents.
//
// Documents are purely for file storage and reference — they have
// no status workflow, no TAT, no efficiency, no completion approval,
// and no collaborators.
//
// Tasks drive everything performance-related:
//
//   TAT lifecycle:
//     1. CEO/Supervisor assigns task            → status = pending
//     2. Assignee sets targetMinutes + starts   → status = in_progress
//                                                  startedAt recorded
//     3. Assignee marks complete                → status = completed
//                                                  completedAt, tatMinutes,
//                                                  efficiencyRatio calculated
//
//   efficiencyRatio = targetMinutes / tatMinutes
//     > 1.0  finished faster than committed  (excellent)
//     = 1.0  exactly on target
//     < 1.0  overran target                  (needs attention)
//
//   Task collaboration:
//     - Assignee can invite other users to help with the task
//     - Invited users appear in collaborators[] and gain read access
//       to any linked document
//     - When the task moves to completed or cancelled, ALL collaborator
//       access is immediately and automatically revoked
//
// ─────────────────────────────────────────────────────────────────

export interface ITaskCollaborator {
  userId:    mongoose.Types.ObjectId;
  invitedAt: Date;
  revokedAt?: Date;
  status:    'active' | 'revoked';
}

export interface IApprovalHistory {
  action: 'approved' | 'rejected';
  by: mongoose.Types.ObjectId;
  at: Date;
  reason?: string;
}

export interface ITask extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  assignedBy: mongoose.Types.ObjectId;
  assignedTo: mongoose.Types.ObjectId;
  documentId?: mongoose.Types.ObjectId;

  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date;

  targetMinutes?: number;
  startedAt?: Date;
  completedAt?: Date;
  tatMinutes?: number;
  efficiencyRatio?: number;

  // ✅ APPROVAL FLOW FIELDS
  submittedAt?: Date;

  approvedBy?: mongoose.Types.ObjectId;
  approvedAt?: Date;
  approvalHistory?: IApprovalHistory[];

  // SLA tracking
  approvalDurationMinutes?: number;

  // Proof of work
  proofFiles?: string[];

  submissionComment?: string;

  rejectedBy?: mongoose.Types.ObjectId;
  rejectedAt?: Date;
  rejectionReason?: string;

  collaborators: ITaskCollaborator[];

  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TaskCollaboratorSchema = new Schema<ITaskCollaborator>({
  userId:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  invitedAt: { type: Date, default: Date.now },
  revokedAt: { type: Date },
  status:    { type: String, enum: ['active', 'revoked'], default: 'active' },
}, { _id: false });

const TaskSchema = new Schema<ITask>({
  title: { type: String, required: true, trim: true },
  description: { type: String },

  assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document' },

  status: {
    type: String,
    enum: ['pending', 'in_progress', 'submitted', 'completed', 'cancelled'],
    default: 'pending'
  },

  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },

  dueDate: { type: Date },

  // TAT
  targetMinutes: { type: Number, min: 1 },
  startedAt: { type: Date },
  completedAt: { type: Date },
  tatMinutes: { type: Number },
  efficiencyRatio: { type: Number },

  // ✅ Approval workflow
  submittedAt: { type: Date },

  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },

  rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },
  rejectionReason: { type: String },

  approvalHistory: [
    {
      action: {
        type: String,
        enum: ['approved', 'rejected'],
        required: true,
      },
      by: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      at: {
        type: Date,
        default: Date.now,
      },
      reason: {
        type: String,
      },
    }
  ],

  approvalDurationMinutes: { type: Number },

  proofFiles: [
    {
      url: String,
      uploadedAt: Date,
    }
  ],
  submissionComment: { type: String },

  // Collaboration
  collaborators: { type: [TaskCollaboratorSchema], default: [] },

  notes: { type: String },
}, { timestamps: true });

TaskSchema.index({ assignedTo: 1, status: 1 });
TaskSchema.index({ assignedBy: 1, createdAt: -1 });
TaskSchema.index({ documentId: 1 });
TaskSchema.index({ assignedTo: 1, efficiencyRatio: -1 });
TaskSchema.index({ 'collaborators.userId': 1 });

export const TaskModel = mongoose.model<ITask>('Task', TaskSchema);