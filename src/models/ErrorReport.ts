import mongoose, { Document, Schema } from "mongoose";
import { AttachmentSchema, IAttachment } from "./shared/AttachmentSchema";

// ═════════════════════════════════════════════════════════════════
// ERROR REPORTS
//
// One collection for three kinds of reports, so the tech supervisor
// triages everything in one queue:
//
//   server       — the API failed (5xx, crash, DB outage, failed cron job)
//   client       — the browser app threw (React crash, uncaught JS error)
//   user_report  — a person pressed "Report a problem": comment +
//                  screenshots, shared with the tech supervisor
//
// Auto-captured errors (server / client) are DE-DUPLICATED: the same
// failure repeating 400 times is ONE report with occurrences = 400,
// not 400 reports and 400 emails. `openKey` is what makes that safe
// under concurrency — see errorReportService.recordInDb.
// ═════════════════════════════════════════════════════════════════

export type ErrorReportSource = "server" | "client" | "user_report";
export type ErrorSeverity = "low" | "medium" | "high" | "critical";
export type ErrorReportStatus =
  | "new"
  | "acknowledged"
  | "investigating"
  | "resolved"
  | "ignored";

export const ERROR_SEVERITIES: ErrorSeverity[] = [
  "low",
  "medium",
  "high",
  "critical",
];
export const ERROR_STATUSES: ErrorReportStatus[] = [
  "new",
  "acknowledged",
  "investigating",
  "resolved",
  "ignored",
];
/** Statuses that count as "still needs attention". */
export const OPEN_STATUSES: ErrorReportStatus[] = [
  "new",
  "acknowledged",
  "investigating",
];

export interface IErrorContext {
  method?: string;
  /** Normalised path, ids replaced by ":id" — what fingerprints are built from. */
  route?: string;
  /** Concrete path (no query string) — handy for reproducing. */
  path?: string;
  statusCode?: number;
  /** Frontend page the person was on (query string stripped). */
  pageUrl?: string;
  userAgent?: string;
  /** What raised it: "uncaughtException", "react-boundary", "db-connect", … */
  kind?: string;
  /** The last failed API call the browser saw, attached to user reports. */
  lastApiError?: {
    method?: string;
    url?: string;
    status?: number;
    message?: string;
    at?: string;
  };
}

export interface IReportComment {
  _id: mongoose.Types.ObjectId;
  author?: mongoose.Types.ObjectId;
  /** Snapshot, so the thread still reads correctly if the account is removed. */
  authorName: string;
  authorRole?: string;
  body: string;
  /** Internal notes are only visible to the ICT team, never to the reporter. */
  internal: boolean;
  attachments: IAttachment[];
  createdAt: Date;
}

export interface IErrorReport extends Document {
  _id: mongoose.Types.ObjectId;
  reportNumber: string; // ERR-1001
  source: ErrorReportSource;
  severity: ErrorSeverity;
  status: ErrorReportStatus;
  title: string;
  /** Error message (auto-captured) — scrubbed of secrets before storing. */
  message?: string;
  stack?: string;
  /** What the person wrote (user_report only). */
  description?: string;
  context: IErrorContext;

  // ── de-duplication (auto-captured errors) ──
  fingerprint?: string;
  /** Equal to `fingerprint` while the report is open; removed on resolve so a
   *  recurrence becomes a fresh report. Unique + sparse (see index below). */
  openKey?: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastAlertedAt?: Date;
  occurrencesAtLastAlert?: number;
  /** The most recent request ids (cap 20) — lets a user's report be linked
   *  to the server error they hit, and lets support search by id. */
  requestIds: string[];

  reportedBy?: mongoose.Types.ObjectId;
  /** Who it happened to (auto-captured) or who filed it (user_report). */
  reportedByName?: string;
  reportedByRole?: string;
  relatedReportId?: mongoose.Types.ObjectId;

  attachments: IAttachment[];
  comments: IReportComment[];
  commentCount: number;
  lastCommentAt?: Date;
  lastCommentByRole?: string;

  assignee?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ContextSchema = new Schema<IErrorContext>(
  {
    method: String,
    route: String,
    path: String,
    statusCode: Number,
    pageUrl: String,
    userAgent: String,
    kind: String,
    lastApiError: {
      method: String,
      url: String,
      status: Number,
      message: String,
      at: String,
    },
  },
  { _id: false },
);

const CommentSchema = new Schema<IReportComment>(
  {
    author: { type: Schema.Types.ObjectId, ref: "User" },
    authorName: { type: String, required: true, trim: true },
    authorRole: { type: String },
    body: { type: String, default: "", maxlength: 4000 },
    internal: { type: Boolean, default: false },
    attachments: { type: [AttachmentSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ErrorReportSchema = new Schema<IErrorReport>(
  {
    reportNumber: { type: String, required: true, unique: true },
    source: {
      type: String,
      enum: ["server", "client", "user_report"],
      required: true,
    },
    severity: {
      type: String,
      enum: ERROR_SEVERITIES,
      default: "medium",
    },
    status: { type: String, enum: ERROR_STATUSES, default: "new" },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    message: { type: String, maxlength: 4000 },
    stack: { type: String, maxlength: 12000 },
    description: { type: String, trim: true, maxlength: 4000 },
    context: { type: ContextSchema, default: () => ({}) },

    fingerprint: { type: String },
    // Sparse + unique: at most ONE open report per fingerprint, while
    // user reports (which never set it) are ignored by the index.
    openKey: { type: String },
    occurrences: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastAlertedAt: { type: Date },
    occurrencesAtLastAlert: { type: Number },
    requestIds: { type: [String], default: [] },

    reportedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reportedByName: { type: String },
    reportedByRole: { type: String },
    relatedReportId: { type: Schema.Types.ObjectId, ref: "ErrorReport" },

    attachments: { type: [AttachmentSchema], default: [] },
    comments: { type: [CommentSchema], default: [] },
    commentCount: { type: Number, default: 0 },
    lastCommentAt: { type: Date },
    lastCommentByRole: { type: String },

    assignee: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
  },
  { timestamps: true },
);

ErrorReportSchema.index({ openKey: 1 }, { unique: true, sparse: true });
ErrorReportSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });
ErrorReportSchema.index({ reportedBy: 1, createdAt: -1 });
ErrorReportSchema.index({ requestIds: 1 });
ErrorReportSchema.index({ lastAlertedAt: 1 }, { sparse: true });

export const ErrorReport = mongoose.model<IErrorReport>(
  "ErrorReport",
  ErrorReportSchema,
);

// ── Report numbers ──────────────────────────────────────────────
// Ticket numbers are "last + 1", which can hand the same number to two
// concurrent requests. A burst of identical failures is exactly when
// error reports get created concurrently, so this uses an atomic
// counter ($inc on one document) instead.
const CounterSchema = new Schema<{ _id: string; seq: number }>(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { versionKey: false },
);
const Counter =
  (mongoose.models["Counter"] as mongoose.Model<{ _id: string; seq: number }>) ||
  mongoose.model<{ _id: string; seq: number }>("Counter", CounterSchema);

export const nextReportNumber = async (): Promise<string> => {
  const c = await Counter.findOneAndUpdate(
    { _id: "errorReport" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return `ERR-${1000 + (c?.seq ?? 1)}`;
};