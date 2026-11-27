import mongoose, { Document, Schema, Types } from "mongoose";

/**
 * One row per client per reporting month that owes Management Accounts.
 * It is the durable deadline / overdue record: it exists before anyone
 * starts the report (so "not submitted" can be flagged), carries the
 * 15th-day deadline, and keeps the full overdue-alert history even after
 * the report has been sent.
 */
export interface IAlertEpisode {
  activatedAt: Date;
  clearedAt?: Date;
  clearReason?: "approved" | "sent" | "exempted";
}

export interface IMaNotification {
  kind: "overdue_initial" | "overdue_reminder";
  /** EAT calendar day the notice was issued, e.g. "2026-11-16". */
  dateKey: string;
  userIds: Types.ObjectId[];
  at: Date;
}

export interface IMaPeriod extends Document {
  clientId: Types.ObjectId;
  periodKey: string;
  periodLabel: string;
  deadline: Date;

  primaryAccountantId?: Types.ObjectId;
  secondaryAccountantIds: Types.ObjectId[];

  submissionId?: Types.ObjectId;
  firstSubmittedAt?: Date;
  lastSubmittedAt?: Date;
  approvedAt?: Date;
  sentAt?: Date;

  /** Mirrors the current review-alert state (see utils/maDeadlines). */
  alertActive: boolean;
  overdueSince?: Date;
  alertHistory: IAlertEpisode[];
  notifications: IMaNotification[];

  /** Set when the client was exempted after the period was created. */
  exempt?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MaPeriodSchema = new Schema<IMaPeriod>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    periodKey: { type: String, required: true },
    periodLabel: { type: String, required: true },
    deadline: { type: Date, required: true },

    primaryAccountantId: { type: Schema.Types.ObjectId, ref: "User" },
    secondaryAccountantIds: [{ type: Schema.Types.ObjectId, ref: "User" }],

    submissionId: { type: Schema.Types.ObjectId, ref: "ReportSubmission" },
    firstSubmittedAt: Date,
    lastSubmittedAt: Date,
    approvedAt: Date,
    sentAt: Date,

    alertActive: { type: Boolean, default: false },
    overdueSince: Date,
    alertHistory: {
      type: [
        new Schema<IAlertEpisode>(
          {
            activatedAt: { type: Date, required: true },
            clearedAt: Date,
            clearReason: { type: String, enum: ["approved", "sent", "exempted"] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    notifications: {
      type: [
        new Schema<IMaNotification>(
          {
            kind: {
              type: String,
              enum: ["overdue_initial", "overdue_reminder"],
              required: true,
            },
            dateKey: { type: String, required: true },
            userIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
            at: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    exempt: Boolean,
  },
  { timestamps: true },
);

MaPeriodSchema.index({ clientId: 1, periodKey: 1 }, { unique: true });
MaPeriodSchema.index({ periodKey: 1 });
MaPeriodSchema.index({ alertActive: 1, primaryAccountantId: 1 });
MaPeriodSchema.index({ sentAt: 1, deadline: 1 });

export const MaPeriod = mongoose.model<IMaPeriod>("MaPeriod", MaPeriodSchema);
