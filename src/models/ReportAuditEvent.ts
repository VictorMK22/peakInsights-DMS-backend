import mongoose, { Document, Schema, Types } from "mongoose";

/**
 * Append-only audit trail for the report workflow. Rows are never updated
 * or removed by application code (timestamp is immutable) so management can
 * reconstruct exactly who did what, and when, for every report.
 */
export const REPORT_AUDIT_ACTIONS = [
  "report_created",
  "report_updated",
  "report_deleted",
  "submitted",
  "resubmitted",
  "returned_for_corrections",
  "approved",
  "reopened",
  "final_pdf_uploaded",
  "final_pdf_removed",
  "delivery_initiated",
  "delivery_sent",
  "delivery_failed",
  "delivery_retry",
  "overdue_triggered",
  "overdue_notified",
  "overdue_cleared",
  "period_exempted",
  "period_reinstated",
] as const;
export type ReportAuditAction = (typeof REPORT_AUDIT_ACTIONS)[number];

export interface IReportAuditEvent extends Document {
  submissionId?: Types.ObjectId;
  clientId: Types.ObjectId;
  periodKey?: string;
  action: ReportAuditAction;
  /** Absent for system actions (the scheduled monitor). */
  actorId?: Types.ObjectId;
  details?: Record<string, unknown>;
  at: Date;
}

const ReportAuditEventSchema = new Schema<IReportAuditEvent>({
  submissionId: { type: Schema.Types.ObjectId, ref: "ReportSubmission" },
  clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
  periodKey: String,
  action: { type: String, enum: REPORT_AUDIT_ACTIONS, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  details: Schema.Types.Mixed,
  at: { type: Date, default: Date.now, immutable: true },
});

ReportAuditEventSchema.index({ submissionId: 1, at: 1 });
ReportAuditEventSchema.index({ clientId: 1, periodKey: 1, at: 1 });

export const ReportAuditEvent = mongoose.model<IReportAuditEvent>(
  "ReportAuditEvent",
  ReportAuditEventSchema,
);