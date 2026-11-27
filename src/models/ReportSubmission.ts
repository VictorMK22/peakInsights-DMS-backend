import mongoose, { Document, Schema, Types } from "mongoose";

/**
 * A client report moving through the supervised workflow:
 *   draft → pending_review → (returned → pending_review)* → approved
 *         → sending → sent | delivery_failed (→ sending …)
 *
 * Approval and delivery are separate on purpose: `approved` never sends.
 */
export const REPORT_STATUSES = [
  "draft",
  "pending_review",
  "returned",
  "approved",
  "sending",
  "sent",
  "delivery_failed",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TYPES = ["management_accounts", "other"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface IStoredFile {
  _id: Types.ObjectId;
  fileKey: string;
  filename: string;
  mimeType?: string;
  size?: number;
  uploadedBy: Types.ObjectId;
  uploadedAt: Date;
  removedAt?: Date;
  removedBy?: Types.ObjectId;
  /** Set when a re-opened report made this attachment stale. */
  supersededAt?: Date;
}

export interface IReportVersion {
  _id: Types.ObjectId;
  revision: number;
  submittedBy: Types.ObjectId;
  submittedAt: Date;
  summary: string;
  supportingFiles: IStoredFile[];
  decision: "pending" | "approved" | "returned";
  reviewedBy?: Types.ObjectId;
  reviewedAt?: Date;
  comments?: string;
}

export interface IDeliveryAttempt {
  n: number;
  startedAt: Date;
  finishedAt?: Date;
  initiatedBy: Types.ObjectId;
  status: "sending" | "sent" | "failed";
  idempotencyKey: string;
  error?: string;
  messageId?: string;
  providerId?: string;
}

export interface IReportSubmission extends Document {
  clientId: Types.ObjectId;
  reportType: ReportType;
  /** Display name for non-MA reports, e.g. "Presentation Pack". */
  reportTypeLabel?: string;
  /** "YYYY-MM" for Management Accounts; free-form key otherwise. */
  periodKey: string;
  periodLabel: string;
  maPeriodId?: Types.ObjectId;

  // Responsibility snapshot (kept even if the client is reassigned later).
  primaryAccountantId: Types.ObjectId;
  secondaryAccountantIds: Types.ObjectId[];
  supervisorIds: Types.ObjectId[];

  status: ReportStatus;
  revision: number;
  summary: string;
  supportingFiles: IStoredFile[];
  versions: IReportVersion[];

  submittedAt?: Date; // latest submission
  firstSubmittedAt?: Date;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;

  finalAttachments: IStoredFile[];

  delivery?: {
    senderUserId?: Types.ObjectId;
    senderEmail?: string;
    senderName?: string;
    initiatedBy?: Types.ObjectId;
    to?: string;
    cc?: string[];
    subject?: string;
    attachmentNames?: string[];
    messageId?: string;
    providerId?: string;
    sentAt?: Date;
    lockedAt?: Date;
    attempts: IDeliveryAttempt[];
    lastError?: string;
  };
  sentAt?: Date;

  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const StoredFileSchema = new Schema<IStoredFile>({
  fileKey: { type: String, required: true },
  filename: { type: String, required: true },
  mimeType: String,
  size: Number,
  uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  uploadedAt: { type: Date, default: Date.now },
  removedAt: Date,
  removedBy: { type: Schema.Types.ObjectId, ref: "User" },
  supersededAt: Date,
});

const VersionSchema = new Schema<IReportVersion>({
  revision: { type: Number, required: true },
  submittedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  submittedAt: { type: Date, required: true },
  summary: { type: String, default: "" },
  supportingFiles: { type: [StoredFileSchema], default: [] },
  decision: {
    type: String,
    enum: ["pending", "approved", "returned"],
    default: "pending",
  },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
  reviewedAt: Date,
  comments: String,
});

const AttemptSchema = new Schema<IDeliveryAttempt>(
  {
    n: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    initiatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["sending", "sent", "failed"], required: true },
    idempotencyKey: { type: String, required: true },
    error: String,
    messageId: String,
    providerId: String,
  },
  { _id: false },
);

const ReportSubmissionSchema = new Schema<IReportSubmission>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    reportType: { type: String, enum: REPORT_TYPES, required: true },
    reportTypeLabel: { type: String, trim: true, maxlength: 120 },
    periodKey: { type: String, required: true, trim: true },
    periodLabel: { type: String, required: true, trim: true },
    maPeriodId: { type: Schema.Types.ObjectId, ref: "MaPeriod" },

    primaryAccountantId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    secondaryAccountantIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    supervisorIds: [{ type: Schema.Types.ObjectId, ref: "User" }],

    status: {
      type: String,
      enum: REPORT_STATUSES,
      default: "draft",
      index: true,
    },
    revision: { type: Number, default: 0 },
    summary: { type: String, default: "", maxlength: 10000 },
    supportingFiles: { type: [StoredFileSchema], default: [] },
    versions: { type: [VersionSchema], default: [] },

    submittedAt: Date,
    firstSubmittedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: Date,

    finalAttachments: { type: [StoredFileSchema], default: [] },

    delivery: {
      senderUserId: { type: Schema.Types.ObjectId, ref: "User" },
      senderEmail: String,
      senderName: String,
      initiatedBy: { type: Schema.Types.ObjectId, ref: "User" },
      to: String,
      cc: [String],
      subject: String,
      attachmentNames: [String],
      messageId: String,
      providerId: String,
      sentAt: Date,
      lockedAt: Date,
      attempts: { type: [AttemptSchema], default: [] },
      lastError: String,
    },
    sentAt: Date,

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// One Management Accounts report per client per reporting month.
ReportSubmissionSchema.index(
  { clientId: 1, periodKey: 1 },
  {
    unique: true,
    partialFilterExpression: { reportType: "management_accounts" },
  },
);
ReportSubmissionSchema.index({ status: 1, supervisorIds: 1 });
ReportSubmissionSchema.index({ secondaryAccountantIds: 1 });

export const ReportSubmission = mongoose.model<IReportSubmission>(
  "ReportSubmission",
  ReportSubmissionSchema,
);
