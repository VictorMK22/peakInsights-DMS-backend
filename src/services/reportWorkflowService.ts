import { Types } from "mongoose";
import { ClientModel, IClient } from "../models/Client";
import { User } from "../models/User";
import {
  ReportSubmission,
  IReportSubmission,
  IStoredFile,
} from "../models/ReportSubmission";
import { MaPeriod } from "../models/MaPeriod";
import { ReportAuditEvent } from "../models/ReportAuditEvent";
import {
  clientOwesPeriod,
  ensureMaPeriod,
  syncMaPeriod,
} from "./maTrackingService";
import {
  resolveClientTeam,
  resolveReviewers,
  supervisedAccountantIds,
  isAccountantSupervisor,
  getCeoSender,
  logReportEvent,
  notifyUsers,
  userNames,
} from "./reportTeamService";
import {
  createReportUploads,
  parseRefs,
  verifyUploads,
  discardUploads,
  ReportFileError,
  MAX_FINAL_PDFS,
  MAX_SUPPORTING_FILES,
  UploadRequestFile,
  looksLikePdf,
} from "./reportAttachmentService";
import { downloadFromS3, deleteFromS3 } from "./s3Storage";
import { sendClientReportEmail, CeoSenderNotConfiguredError } from "./emailService";
import { getLocalFileUrl } from "../middleware/upload";
import {
  currentReportingPeriod,
  isPeriodKey,
  periodLabelOf,
} from "../utils/maDeadlines";

// ═════════════════════════════════════════════════════════════════
// The supervised report workflow.
//
//   Accountants prepare & submit  →  the Accountant Supervisor reviews,
//   approves and (separately) sends  →  the client receives it from the CEO.
//
// Two rules are enforced here, on the server, for every caller:
//   1. APPROVAL IS NOT DELIVERY — approve() never sends anything.
//   2. SUBMISSION IS NOT APPROVAL — only the supervisor can approve.
// ═════════════════════════════════════════════════════════════════

export class WorkflowError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export interface Actor {
  userId: string;
  role: string;
}

type Id = Types.ObjectId | string;
const eq = (a?: Id | null, b?: Id | null) => !!a && !!b && String(a) === String(b);
const MAX_SEND_LOCK_MS = 10 * 60 * 1000;
const MAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// ─── Access helpers ───────────────────────────────────────────────

const isAssignedAccountant = (s: IReportSubmission, userId: string) =>
  eq(s.primaryAccountantId, userId) ||
  s.secondaryAccountantIds.some((i) => eq(i, userId));

/**
 * The reviewers for this report, recomputed live from roles/mappings so a
 * change of supervisor takes effect without touching old submissions.
 */
async function assertReviewer(actor: Actor, s: IReportSubmission): Promise<void> {
  if (actor.role !== "supervisor" || !(await isAccountantSupervisor(actor.userId)))
    throw new WorkflowError(
      403,
      "Only the Accountant Supervisor can perform this action",
    );
  // Nobody reviews or delivers a report they submitted themselves. A
  // supervisor who is the client's Primary can still review it once a
  // Secondary Accountant has submitted it to him.
  const submitters = submittersOf(s);
  if (submitters.includes(actor.userId))
    throw new WorkflowError(
      403,
      "You submitted this report yourself, so someone else must review it",
    );
  const reviewers = await resolveReviewers(s.primaryAccountantId, submitters);
  if (!reviewers.some((r) => eq(r._id, actor.userId)))
    throw new WorkflowError(
      403,
      "You are not the supervisor responsible for this report",
    );
}

/** Everyone who has submitted any revision of this report (ids as strings). */
const submittersOf = (s: IReportSubmission): string[] => [
  ...new Set(s.versions.map((v) => String(v.submittedBy))),
];

/**
 * Why `actor` cannot submit this report for review right now, or null. The
 * submitter can never be the reviewer, so if the only available reviewer is
 * the person submitting (e.g. the Accountant Supervisor on his own client),
 * a different team member has to submit it to him.
 */
async function submitBlockedReason(
  s: IReportSubmission,
  actor: Actor,
  secondaryNames: string[],
): Promise<string | null> {
  const reviewers = await resolveReviewers(s.primaryAccountantId, [
    actor.userId,
    ...submittersOf(s),
  ]);
  if (reviewers.length > 0) return null;
  if (await isAccountantSupervisor(actor.userId))
    return secondaryNames.length
      ? `You are the Accountant Supervisor for this report, so you can't review your own submission. Ask ${secondaryNames.join(" or ")} to submit it to you for review.`
      : "You are the Accountant Supervisor for this report, so you can't review your own submission. Add a Secondary Accountant to this client — they submit the report to you for review.";
  return "No Accountant Supervisor is available to review this report.";
}

async function loadSubmission(id: string): Promise<IReportSubmission> {
  if (!Types.ObjectId.isValid(id))
    throw new WorkflowError(400, "Invalid report id");
  const s = await ReportSubmission.findById(id);
  if (!s) throw new WorkflowError(404, "Report not found");
  return s;
}

async function loadClient(id: Id): Promise<IClient> {
  const c = await ClientModel.findById(id);
  if (!c) throw new WorkflowError(404, "Client not found");
  return c;
}

/** Accountants of this report (primary/secondary) or the CEO. */
const canSeeAsAccountant = (actor: Actor, s: IReportSubmission) =>
  actor.role === "ceo" || isAssignedAccountant(s, actor.userId);

async function assertCanSee(actor: Actor, s: IReportSubmission): Promise<void> {
  if (canSeeAsAccountant(actor, s)) return;
  if (actor.role === "supervisor" && (await isAccountantSupervisor(actor.userId))) {
    const supervised = await supervisedAccountantIds(actor.userId);
    if (
      s.supervisorIds.some((i) => eq(i, actor.userId)) ||
      supervised.includes(String(s.primaryAccountantId))
    )
      return;
  }
  throw new WorkflowError(403, "You do not have access to this report");
}

async function assertPreparer(actor: Actor, s: IReportSubmission): Promise<void> {
  if (!isAssignedAccountant(s, actor.userId))
    throw new WorkflowError(
      403,
      "Only the Primary or Secondary Accountant on this client can do this",
    );
}

const activeFinals = (s: IReportSubmission): IStoredFile[] =>
  s.finalAttachments.filter((a) => !a.removedAt && !a.supersededAt);

const reportLabel = (s: IReportSubmission) =>
  s.reportType === "management_accounts"
    ? "Management Accounts"
    : (s.reportTypeLabel ?? "Report");

const accountantIds = (s: IReportSubmission): Id[] => [
  s.primaryAccountantId,
  ...s.secondaryAccountantIds,
];

const baseMeta = (s: IReportSubmission, audience: "accountant" | "supervisor") => ({
  submissionId: String(s._id),
  clientId: String(s.clientId),
  periodKey: s.periodKey,
  audience,
});

// ─── Creating / editing drafts ────────────────────────────────────

async function snapshotTeam(client: IClient) {
  const team = await resolveClientTeam(client);
  if (!team.primary)
    throw new WorkflowError(
      409,
      "This client has no accountant assigned yet, so a report cannot be started",
    );
  const reviewers = await resolveReviewers(team.primary._id);
  return { team, reviewers };
}

/** Starts (or returns) the Management Accounts report for a client + reporting month. */
export async function openMaReport(
  actor: Actor,
  clientId: string,
  periodKey: string,
): Promise<IReportSubmission> {
  if (!isPeriodKey(periodKey))
    throw new WorkflowError(400, "Reporting period must look like 2026-10");
  if (periodKey > currentReportingPeriod())
    throw new WorkflowError(400, "That reporting month has not ended yet");
  const client = await loadClient(clientId);
  if (!clientOwesPeriod(client, periodKey))
    throw new WorkflowError(
      400,
      "This client is not required to receive Management Accounts for that month",
    );

  if (await MaPeriod.exists({ clientId: client._id, periodKey, exempt: true }))
    throw new WorkflowError(
      400,
      "These Management Accounts were marked as not required. Ask the CEO or Accountant Supervisor to reinstate them first.",
      "PERIOD_EXEMPT",
    );

  const existing = await ReportSubmission.findOne({
    clientId: client._id,
    reportType: "management_accounts",
    periodKey,
  });
  const { team, reviewers } = await snapshotTeam(client).catch((e) => {
    if (existing) return { team: null, reviewers: [] };
    throw e;
  });
  if (existing) {
    await assertPreparer(actor, existing);
    return existing;
  }
  if (
    !team ||
    !(eq(team.primary!._id, actor.userId) ||
      team.secondaries.some((s) => eq(s._id, actor.userId)))
  )
    throw new WorkflowError(
      403,
      "Only the Primary or Secondary Accountant on this client can start its reports",
    );

  const period = await ensureMaPeriod(client, periodKey);
  let sub: IReportSubmission;
  try {
    sub = await ReportSubmission.create({
      clientId: client._id,
      reportType: "management_accounts",
      periodKey,
      periodLabel: periodLabelOf(periodKey),
      maPeriodId: period._id,
      primaryAccountantId: team.primary!._id,
      secondaryAccountantIds: team.secondaries.map((s) => s._id),
      supervisorIds: reviewers.map((r) => r._id),
      status: "draft",
      createdBy: actor.userId,
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      return (await ReportSubmission.findOne({
        clientId: client._id,
        reportType: "management_accounts",
        periodKey,
      }))!;
    }
    throw err;
  }
  await MaPeriod.updateOne({ _id: period._id }, { submissionId: sub._id });
  await logReportEvent({
    submissionId: sub._id,
    clientId: client._id,
    periodKey,
    action: "report_created",
    actorId: actor.userId,
    details: { reportType: "management_accounts" },
  });
  return sub;
}

/** Starts a non-MA report (e.g. a Presentation Pack) for a client. */
export async function openOtherReport(
  actor: Actor,
  clientId: string,
  input: { reportTypeLabel?: string; periodLabel?: string },
): Promise<IReportSubmission> {
  const label = input.reportTypeLabel?.trim();
  const period = input.periodLabel?.trim();
  if (!label || !period)
    throw new WorkflowError(400, "Report type and reporting period are required");
  const client = await loadClient(clientId);
  const { team, reviewers } = await snapshotTeam(client);
  if (
    !(eq(team.primary!._id, actor.userId) ||
      team.secondaries.some((s) => eq(s._id, actor.userId)))
  )
    throw new WorkflowError(
      403,
      "Only the Primary or Secondary Accountant on this client can start its reports",
    );
  const sub = await ReportSubmission.create({
    clientId: client._id,
    reportType: "other",
    reportTypeLabel: label.slice(0, 120),
    periodKey: period.slice(0, 60),
    periodLabel: period.slice(0, 60),
    primaryAccountantId: team.primary!._id,
    secondaryAccountantIds: team.secondaries.map((s) => s._id),
    supervisorIds: reviewers.map((r) => r._id),
    status: "draft",
    createdBy: actor.userId,
  });
  await logReportEvent({
    submissionId: sub._id,
    clientId: client._id,
    periodKey: sub.periodKey,
    action: "report_created",
    actorId: actor.userId,
    details: { reportType: "other", label },
  });
  return sub;
}

export async function presignSupporting(
  actor: Actor,
  id: string,
  files: UploadRequestFile[],
) {
  const s = await loadSubmission(id);
  await assertPreparer(actor, s);
  return createReportUploads(actor.userId, "supporting", files);
}

/** Saves the working notes / supporting files while the report is editable. */
export async function saveDraft(
  actor: Actor,
  id: string,
  input: { summary?: string; uploads?: unknown },
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertPreparer(actor, s);
  if (!["draft", "returned"].includes(s.status))
    throw new WorkflowError(
      409,
      "This report can no longer be edited — it is with the supervisor or already approved",
    );
  const refs = parseRefs(input.uploads, MAX_SUPPORTING_FILES);
  const verified = await verifyUploads(actor.userId, "supporting", refs);
  if (s.supportingFiles.length + verified.length > MAX_SUPPORTING_FILES) {
    await discardUploads(refs);
    throw new WorkflowError(
      400,
      `A report can carry at most ${MAX_SUPPORTING_FILES} supporting files`,
    );
  }
  const set: Record<string, unknown> = {};
  if (typeof input.summary === "string") set.summary = input.summary.slice(0, 10000);
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: { $in: ["draft", "returned"] } },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(verified.length
        ? {
            $push: {
              supportingFiles: {
                $each: verified.map((f) => ({
                  ...f,
                  uploadedBy: actor.userId,
                  uploadedAt: new Date(),
                })),
              },
            },
          }
        : {}),
    },
    { new: true },
  );
  if (!updated) {
    await discardUploads(refs);
    throw new WorkflowError(409, "This report changed while you were editing it");
  }
  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: "report_updated",
    actorId: actor.userId,
    details: { addedFiles: verified.map((f) => f.filename) },
  });
  return updated;
}

export async function removeSupportingFile(
  actor: Actor,
  id: string,
  fileId: string,
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertPreparer(actor, s);
  const file = s.supportingFiles.find((f) => eq(f._id, fileId));
  if (!file) throw new WorkflowError(404, "File not found");
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: { $in: ["draft", "returned"] } },
    { $pull: { supportingFiles: { _id: file._id } } },
    { new: true },
  );
  if (!updated)
    throw new WorkflowError(409, "This report can no longer be edited");
  return updated;
}

/**
 * Deletes a report that was started but never submitted. Once a report has
 * been submitted its history must stay, so only a never-submitted draft can
 * go. For Management Accounts the month stays tracked: the client still owes
 * it, so the deadline and any overdue alert are unaffected.
 */
export async function deleteDraftReport(actor: Actor, id: string): Promise<void> {
  const s = await loadSubmission(id);
  await assertPreparer(actor, s);
  // Atomic: only a draft with no submission history can be removed.
  const removed = await ReportSubmission.findOneAndDelete({
    _id: s._id,
    status: "draft",
    revision: 0,
    "versions.0": { $exists: false },
  });
  if (!removed)
    throw new WorkflowError(
      409,
      "Only a report that has not been submitted for review can be deleted",
      "NOT_DELETABLE",
    );
  await Promise.all(removed.supportingFiles.map((f) => deleteFromS3(f.fileKey)));
  if (removed.maPeriodId) {
    await MaPeriod.updateOne({ _id: removed.maPeriodId }, { $unset: { submissionId: "" } });
    await syncMaPeriod(removed.maPeriodId, new Date(), actor.userId);
  }
  await logReportEvent({
    submissionId: removed._id,
    clientId: removed.clientId,
    periodKey: removed.periodKey,
    action: "report_deleted",
    actorId: actor.userId,
    details: { reportType: removed.reportType, label: reportLabel(removed) },
  });
}

// ─── Taking a month off the books ("not required") ────────────────

async function assertCanExempt(actor: Actor): Promise<void> {
  if (
    actor.role !== "ceo" &&
    !(actor.role === "supervisor" && (await isAccountantSupervisor(actor.userId)))
  )
    throw new WorkflowError(
      403,
      "Only the CEO or an Accountant Supervisor can mark Management Accounts as not required",
    );
}

/**
 * The CEO / an accountant supervisor can mark one month's MAs for a client as
 * "not required" (a test client, onboarding, an agreed exception…). The overdue
 * alert clears, the row leaves the accountants' worklist and the performance
 * figures — but the record, the reason and who decided stay, and it can be
 * reinstated. Accountants can't do this (they'd be erasing their own overdue
 * work), and a supervisor can't do it for MAs he is himself responsible for.
 */
export async function exemptMaPeriod(
  actor: Actor,
  periodId: string,
  reason: string,
): Promise<void> {
  await assertCanExempt(actor);
  if (!Types.ObjectId.isValid(periodId)) throw new WorkflowError(400, "Invalid id");
  const period = await MaPeriod.findById(periodId);
  if (!period) throw new WorkflowError(404, "Not found");
  const why = (reason ?? "").trim();
  if (why.length < 3)
    throw new WorkflowError(400, "Please give a short reason (it is kept in the audit trail)");
  if (actor.role !== "ceo") {
    const team = [period.primaryAccountantId, ...period.secondaryAccountantIds];
    if (team.some((i) => eq(i, actor.userId)))
      throw new WorkflowError(
        403,
        "You can't mark your own Management Accounts as not required — ask the CEO",
      );
  }
  if (period.sentAt)
    throw new WorkflowError(409, "These MAs have already been sent to the client");
  if (period.submissionId)
    throw new WorkflowError(
      409,
      "A report has already been started for this month. Delete the draft first, or finish the report.",
      "HAS_REPORT",
    );
  if (period.exempt) return;

  period.exempt = true;
  await syncMaPeriod(period, new Date(), actor.userId); // clears any overdue alert
  const client = await loadClient(period.clientId);
  await logReportEvent({
    clientId: period.clientId,
    periodKey: period.periodKey,
    action: "period_exempted",
    actorId: actor.userId,
    details: { reason: why },
  });
  const who = await User.findById(actor.userId).select("name").lean();
  await notifyUsers(
    [period.primaryAccountantId, ...period.secondaryAccountantIds].filter(Boolean) as Id[],
    `${who?.name ?? "A manager"} marked the ${period.periodLabel} Management Accounts for ${client.name} as not required: ${why.slice(0, 160)}`,
    "ma_period_exempted",
    { clientId: String(period.clientId), periodKey: period.periodKey, audience: "accountant" },
    actor.userId,
  );
}

/** Puts a "not required" month back on the books (it becomes overdue again if the deadline has passed). */
export async function reinstateMaPeriod(actor: Actor, periodId: string): Promise<void> {
  await assertCanExempt(actor);
  if (!Types.ObjectId.isValid(periodId)) throw new WorkflowError(400, "Invalid id");
  const period = await MaPeriod.findById(periodId);
  if (!period) throw new WorkflowError(404, "Not found");
  if (!period.exempt) return;
  const client = await loadClient(period.clientId);
  if (client.maRequired === false || (client.maStartPeriod && client.maStartPeriod > period.periodKey))
    throw new WorkflowError(
      409,
      "This client is exempt from monthly MAs (or starts later). Change that on the client first.",
    );
  period.exempt = false;
  await syncMaPeriod(period, new Date(), actor.userId); // re-lights the alert if overdue
  await logReportEvent({
    clientId: period.clientId,
    periodKey: period.periodKey,
    action: "period_reinstated",
    actorId: actor.userId,
  });
  await notifyUsers(
    [period.primaryAccountantId, ...period.secondaryAccountantIds].filter(Boolean) as Id[],
    `The ${period.periodLabel} Management Accounts for ${client.name} are required again.`,
    "ma_period_exempted",
    { clientId: String(period.clientId), periodKey: period.periodKey, audience: "accountant" },
    actor.userId,
  );
}

// ─── Submit for review ────────────────────────────────────────────

export async function submitForReview(
  actor: Actor,
  id: string,
  input: { summary?: string } = {},
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertPreparer(actor, s);
  if (!["draft", "returned"].includes(s.status))
    throw new WorkflowError(
      409,
      s.status === "pending_review"
        ? "This report has already been submitted and is waiting for review"
        : "This report can no longer be submitted",
    );

  const summary = (input.summary ?? s.summary ?? "").trim();
  if (summary.length < 10 && s.supportingFiles.length === 0)
    throw new WorkflowError(
      400,
      "Add report details (at least a short summary) or a supporting file before submitting",
    );

  const client = await loadClient(s.clientId);
  const team = await resolveClientTeam(client);
  if (!team.primary)
    throw new WorkflowError(409, "This client has no accountant assigned");
  const blocked = await submitBlockedReason(
    s,
    actor,
    team.secondaries
      .filter((p) => String(p._id) !== actor.userId)
      .map((p) => p.name),
  );
  if (blocked) throw new WorkflowError(409, blocked, "NO_REVIEWER");
  // The submitter (now or in an earlier revision) can never review it.
  const reviewers = await resolveReviewers(s.primaryAccountantId, [
    actor.userId,
    ...submittersOf(s),
  ]);

  const now = new Date();
  const revision = s.revision + 1;
  const wasReturned = s.status === "returned";
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: { $in: ["draft", "returned"] }, revision: s.revision },
    {
      $set: {
        status: "pending_review",
        summary,
        submittedAt: now,
        ...(s.firstSubmittedAt ? {} : { firstSubmittedAt: now }),
        supervisorIds: reviewers.map((r) => r._id),
      },
      $inc: { revision: 1 },
      $push: {
        versions: {
          revision,
          submittedBy: actor.userId,
          submittedAt: now,
          summary,
          supportingFiles: s.supportingFiles,
          decision: "pending",
        },
      },
    },
    { new: true },
  );
  if (!updated)
    throw new WorkflowError(409, "This report was already submitted");

  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: wasReturned ? "resubmitted" : "submitted",
    actorId: actor.userId,
    details: { revision },
  });
  if (updated.maPeriodId) await syncMaPeriod(updated.maPeriodId, now, actor.userId);

  const label = `${reportLabel(updated)} – ${client.name} – ${updated.periodLabel}`;
  await Promise.all([
    notifyUsers(
      reviewers.map((r) => r._id),
      `${wasReturned ? "Corrected report resubmitted" : "New report submitted"} for review: ${label}`,
      wasReturned ? "report_resubmitted" : "report_submitted",
      baseMeta(updated, "supervisor"),
    ),
    notifyUsers(
      accountantIds(updated),
      `Submitted for review: ${label}`,
      "report_submitted_ack",
      baseMeta(updated, "accountant"),
    ),
  ]);
  return updated;
}

// ─── Review ───────────────────────────────────────────────────────

export async function returnForCorrections(
  actor: Actor,
  id: string,
  comments: string,
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);
  const text = (comments ?? "").trim();
  if (text.length < 3)
    throw new WorkflowError(400, "Please explain what needs to be corrected");
  const now = new Date();
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: "pending_review" },
    {
      $set: {
        status: "returned",
        "versions.$[v].decision": "returned",
        "versions.$[v].reviewedBy": actor.userId,
        "versions.$[v].reviewedAt": now,
        "versions.$[v].comments": text.slice(0, 5000),
      },
    },
    { new: true, arrayFilters: [{ "v.revision": s.revision }] },
  );
  if (!updated)
    throw new WorkflowError(409, "This report is no longer waiting for review");

  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: "returned_for_corrections",
    actorId: actor.userId,
    details: { revision: s.revision, comments: text },
  });
  if (updated.maPeriodId) await syncMaPeriod(updated.maPeriodId, now, actor.userId);
  const client = await loadClient(s.clientId);
  await notifyUsers(
    accountantIds(updated),
    `Returned for corrections: ${reportLabel(updated)} – ${client.name} – ${updated.periodLabel}. ${text.slice(0, 160)}`,
    "report_returned",
    baseMeta(updated, "accountant"),
  );
  return updated;
}

/**
 * Records the supervisor's approval. THIS NEVER SENDS ANYTHING — it only
 * unlocks the attach-PDF / send step, which stays a separate, explicit action.
 */
export async function approveReport(
  actor: Actor,
  id: string,
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);
  const now = new Date();
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: "pending_review" },
    {
      $set: {
        status: "approved",
        approvedBy: actor.userId,
        approvedAt: now,
        "versions.$[v].decision": "approved",
        "versions.$[v].reviewedBy": actor.userId,
        "versions.$[v].reviewedAt": now,
      },
    },
    { new: true, arrayFilters: [{ "v.revision": s.revision }] },
  );
  if (!updated)
    throw new WorkflowError(409, "This report is no longer waiting for review");

  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: "approved",
    actorId: actor.userId,
    details: { revision: s.revision },
  });
  if (updated.maPeriodId) await syncMaPeriod(updated.maPeriodId, now, actor.userId);
  const client = await loadClient(s.clientId);
  await notifyUsers(
    accountantIds(updated),
    `Approved: ${reportLabel(updated)} – ${client.name} – ${updated.periodLabel}. It is awaiting delivery to the client.`,
    "report_approved",
    baseMeta(updated, "accountant"),
  );
  return updated;
}

/**
 * Sends an approved-but-unsent report back for correction. Needed because an
 * approved report may not be changed silently: a material change means the
 * whole review and approval happens again (and old final PDFs are retired).
 */
export async function reopenReport(
  actor: Actor,
  id: string,
  comments: string,
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);
  const text = (comments ?? "").trim();
  if (text.length < 3)
    throw new WorkflowError(400, "Please explain why the report is being re-opened");
  const now = new Date();
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: { $in: ["approved", "delivery_failed"] } },
    {
      $set: {
        status: "returned",
        "versions.$[v].decision": "returned",
        "versions.$[v].reviewedBy": actor.userId,
        "versions.$[v].reviewedAt": now,
        "versions.$[v].comments": `Re-opened after approval: ${text}`.slice(0, 5000),
        "finalAttachments.$[a].supersededAt": now,
      },
      $unset: { approvedAt: "", approvedBy: "" },
    },
    {
      new: true,
      arrayFilters: [
        { "v.revision": s.revision },
        { "a.removedAt": { $exists: false }, "a.supersededAt": { $exists: false } },
      ],
    },
  );
  if (!updated)
    throw new WorkflowError(
      409,
      "Only an approved report that has not been sent can be re-opened",
    );
  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: "reopened",
    actorId: actor.userId,
    details: { comments: text },
  });
  if (updated.maPeriodId) await syncMaPeriod(updated.maPeriodId, now, actor.userId);
  const client = await loadClient(s.clientId);
  await notifyUsers(
    accountantIds(updated),
    `Re-opened for corrections: ${reportLabel(updated)} – ${client.name} – ${updated.periodLabel}. ${text.slice(0, 160)}`,
    "report_returned",
    baseMeta(updated, "accountant"),
  );
  return updated;
}

// ─── Final PDF attachments (supervisor only) ──────────────────────

const ATTACHABLE = ["approved", "delivery_failed"];

export async function presignFinalPdfs(
  actor: Actor,
  id: string,
  files: UploadRequestFile[],
) {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);
  if (!ATTACHABLE.includes(s.status))
    throw new WorkflowError(
      409,
      "Final PDFs can only be attached once the report is approved and before it is sent",
    );
  return createReportUploads(actor.userId, "final", files);
}

export async function attachFinalPdfs(
  actor: Actor,
  id: string,
  uploads: unknown,
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);
  const refs = parseRefs(uploads, MAX_FINAL_PDFS);
  try {
    if (!ATTACHABLE.includes(s.status))
      throw new WorkflowError(
        409,
        "Final PDFs can only be attached once the report is approved and before it is sent",
      );
    if (refs.length === 0) throw new WorkflowError(400, "No PDF files provided");
    if (activeFinals(s).length + refs.length > MAX_FINAL_PDFS)
      throw new WorkflowError(
        400,
        `A report can have at most ${MAX_FINAL_PDFS} attached PDFs`,
      );
  } catch (err) {
    await discardUploads(refs);
    throw err;
  }
  const verified = await verifyUploads(actor.userId, "final", refs); // rejects non-PDFs
  const now = new Date();
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: { $in: ATTACHABLE } },
    {
      $push: {
        finalAttachments: {
          $each: verified.map((f) => ({
            ...f,
            uploadedBy: actor.userId,
            uploadedAt: now,
          })),
        },
      },
    },
    { new: true },
  );
  if (!updated) {
    await discardUploads(refs);
    throw new WorkflowError(409, "This report is no longer open for attachments");
  }
  for (const f of verified) {
    await logReportEvent({
      submissionId: s._id,
      clientId: s.clientId,
      periodKey: s.periodKey,
      action: "final_pdf_uploaded",
      actorId: actor.userId,
      details: { filename: f.filename, size: f.size, fileKey: f.fileKey },
    });
  }
  return updated;
}

export async function removeFinalPdf(
  actor: Actor,
  id: string,
  attachmentId: string,
): Promise<IReportSubmission> {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);
  const att = s.finalAttachments.find(
    (a) => eq(a._id, attachmentId) && !a.removedAt,
  );
  if (!att) throw new WorkflowError(404, "Attachment not found");
  const now = new Date();
  const updated = await ReportSubmission.findOneAndUpdate(
    { _id: s._id, status: { $in: ATTACHABLE } },
    {
      $set: {
        "finalAttachments.$[a].removedAt": now,
        "finalAttachments.$[a].removedBy": actor.userId,
      },
    },
    { new: true, arrayFilters: [{ "a._id": att._id }] },
  );
  if (!updated)
    throw new WorkflowError(409, "Attachments can no longer be changed");
  await deleteFromS3(att.fileKey); // never sent, so the object is not needed
  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: "final_pdf_removed",
    actorId: actor.userId,
    details: { filename: att.filename },
  });
  return updated;
}

// ─── Send to client ───────────────────────────────────────────────

const dedupeEmails = (to: string, cc: (string | undefined)[]): string[] => {
  const seen = new Set([to.toLowerCase()]);
  const out: string[] = [];
  for (const e of cc) {
    const k = e?.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
};

/** To / CC for a report email — one place, so the preview and the real send can never disagree. */
async function computeRecipients(
  s: IReportSubmission,
  clientEmail: string | undefined,
  supervisorUserId: string,
): Promise<{ to: string | null; cc: string[] }> {
  const to = clientEmail?.trim().toLowerCase();
  const validTo = to && MAIL_RE.test(to) ? to : null;
  const [supervisor, team] = await Promise.all([
    User.findById(supervisorUserId).select("email").lean(),
    resolveClientTeam({
      assignedTo: [s.primaryAccountantId, ...s.secondaryAccountantIds],
      allocatedAccountant: s.primaryAccountantId,
    } as any),
  ]);
  const cc = dedupeEmails(validTo ?? "", [
    team.primary?.email,
    ...team.secondaries.map((p) => p.email),
    supervisor?.email,
  ]);
  return { to: validTo, cc };
}

export interface SendResult {
  report: IReportSubmission;
  alreadySent: boolean;
}

/**
 * The only path that emails a client. Requires: supervisor, report approved,
 * ≥1 attached final PDF, the supervisor's explicit confirmation of exactly
 * those attachments, and a CEO sending identity that is authorised.
 *
 * Duplicate-proof: an atomic status flip to "sending" means a second click,
 * a retried request or a parallel tab can never start a second send; the
 * provider call also carries an idempotency key.
 */
export async function sendReportToClient(
  actor: Actor,
  id: string,
  input: { confirmedAttachmentIds?: string[] },
): Promise<SendResult> {
  const s = await loadSubmission(id);
  await assertReviewer(actor, s);

  if (s.status === "sent") return { report: s, alreadySent: true };
  if (
    s.status === "sending" &&
    s.delivery?.lockedAt &&
    Date.now() - s.delivery.lockedAt.getTime() < MAX_SEND_LOCK_MS
  )
    throw new WorkflowError(
      409,
      "This report is already being sent. Please wait a moment and refresh.",
      "ALREADY_SENDING",
    );
  if (!["approved", "delivery_failed", "sending"].includes(s.status))
    throw new WorkflowError(
      409,
      "Only an approved report can be sent to the client",
      "NOT_APPROVED",
    );

  const finals = activeFinals(s);
  if (finals.length === 0)
    throw new WorkflowError(400, "Attach the final PDF report before sending");
  const confirmed = new Set((input.confirmedAttachmentIds ?? []).map(String));
  if (
    confirmed.size !== finals.length ||
    !finals.every((f) => confirmed.has(String(f._id)))
  )
    throw new WorkflowError(
      409,
      "Please review and confirm the attached documents before sending",
      "CONFIRM_ATTACHMENTS",
    );

  const client = await loadClient(s.clientId);
  const to = client.email?.trim().toLowerCase();
  if (!to || !MAIL_RE.test(to))
    throw new WorkflowError(
      400,
      "This client has no valid designated contact email address",
      "NO_CLIENT_EMAIL",
    );

  // Throws (and nothing is sent or changed) when the CEO identity isn't usable.
  let ceo;
  try {
    ceo = await getCeoSender();
  } catch (err) {
    if (err instanceof CeoSenderNotConfiguredError)
      throw new WorkflowError(409, err.message, "CEO_SENDER_NOT_CONFIGURED");
    throw err;
  }

  const { cc } = await computeRecipients(s, client.email, actor.userId);
  const subject = `${reportLabel(s)} – ${client.name} – ${s.periodLabel}`;

  // ── Atomic claim ────────────────────────────────────────────────
  const now = new Date();
  const staleBefore = new Date(now.getTime() - MAX_SEND_LOCK_MS);
  const wasFailed = s.status === "delivery_failed" || s.status === "sending";
  const attemptNo = (s.delivery?.attempts.length ?? 0) + 1;
  const lastKey = s.delivery?.attempts[s.delivery.attempts.length - 1]?.idempotencyKey;
  // A takeover of a stale "sending" claim reuses its key so the provider
  // de-duplicates if that earlier send actually went through.
  const idempotencyKey =
    s.status === "sending" && lastKey
      ? lastKey
      : `report-${s._id}-r${s.revision}-a${attemptNo}`;

  const claimed = await ReportSubmission.findOneAndUpdate(
    {
      _id: s._id,
      $or: [
        { status: { $in: ["approved", "delivery_failed"] } },
        { status: "sending", "delivery.lockedAt": { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: "sending",
        "delivery.lockedAt": now,
        "delivery.initiatedBy": actor.userId,
        "delivery.senderUserId": ceo.userId,
        "delivery.senderEmail": ceo.email,
        "delivery.senderName": ceo.name,
        "delivery.to": to,
        "delivery.cc": cc,
        "delivery.subject": subject,
        "delivery.attachmentNames": finals.map((f) => f.filename),
      },
      $push: {
        "delivery.attempts": {
          n: attemptNo,
          startedAt: now,
          initiatedBy: actor.userId,
          status: "sending",
          idempotencyKey,
        },
      },
    },
    { new: true },
  );
  if (!claimed) {
    const fresh = await ReportSubmission.findById(s._id);
    if (fresh?.status === "sent") return { report: fresh, alreadySent: true };
    throw new WorkflowError(
      409,
      "This report is already being sent. Please wait a moment and refresh.",
      "ALREADY_SENDING",
    );
  }

  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: wasFailed ? "delivery_retry" : "delivery_initiated",
    actorId: actor.userId,
    details: { attempt: attemptNo, senderEmail: ceo.email, to, cc },
  });

  const fail = async (error: string): Promise<never> => {
    const failed = await ReportSubmission.findOneAndUpdate(
      { _id: s._id, status: "sending" },
      {
        $set: {
          status: "delivery_failed",
          "delivery.lastError": error.slice(0, 1000),
          "delivery.attempts.$[at].status": "failed",
          "delivery.attempts.$[at].finishedAt": new Date(),
          "delivery.attempts.$[at].error": error.slice(0, 1000),
        },
        $unset: { "delivery.lockedAt": "" },
      },
      { new: true, arrayFilters: [{ "at.n": attemptNo }] },
    );
    await logReportEvent({
      submissionId: s._id,
      clientId: s.clientId,
      periodKey: s.periodKey,
      action: "delivery_failed",
      actorId: actor.userId,
      details: { attempt: attemptNo, error },
    });
    if (failed?.maPeriodId) await syncMaPeriod(failed.maPeriodId, new Date(), actor.userId);
    throw new WorkflowError(
      502,
      `The email could not be sent: ${error}. The report is still approved with its PDFs attached — you can retry.`,
      "DELIVERY_FAILED",
    );
  };

  // Every attachment must load (and still be a PDF) before anything is sent.
  const buffers: { filename: string; content: Buffer; contentType: string }[] = [];
  try {
    for (const f of finals) {
      const content = await downloadFromS3(f.fileKey);
      if (!looksLikePdf(content.subarray(0, 8), content.subarray(-1024)))
        throw new Error(`"${f.filename}" is not a valid PDF`);
      buffers.push({ filename: f.filename, content, contentType: "application/pdf" });
    }
  } catch (err: any) {
    return fail(`Could not prepare attachments (${err?.message ?? "unknown error"})`);
  }

  let sent: { messageId: string; providerId?: string };
  try {
    sent = await sendClientReportEmail({
      ceo: { name: ceo.name, email: ceo.email },
      toEmail: to,
      ccEmails: cc,
      clientName: client.name,
      reportLabel: reportLabel(s),
      periodLabel: s.periodLabel,
      subject,
      attachments: buffers,
      idempotencyKey,
    });
  } catch (err: any) {
    return fail(err?.message ?? "Unknown email error");
  }

  // The email is out: recording it must not be skipped, so retry the write.
  const sentAt = new Date();
  let updated: IReportSubmission | null = null;
  for (let i = 0; i < 3 && !updated; i++) {
    try {
      updated = await ReportSubmission.findOneAndUpdate(
        { _id: s._id },
        {
          $set: {
            status: "sent",
            sentAt,
            "delivery.sentAt": sentAt,
            "delivery.messageId": sent.messageId,
            "delivery.providerId": sent.providerId,
            "delivery.attempts.$[at].status": "sent",
            "delivery.attempts.$[at].finishedAt": sentAt,
            "delivery.attempts.$[at].messageId": sent.messageId,
            "delivery.attempts.$[at].providerId": sent.providerId,
          },
          $unset: { "delivery.lockedAt": "", "delivery.lastError": "" },
        },
        { new: true, arrayFilters: [{ "at.n": attemptNo }] },
      );
    } catch (err) {
      console.error("[Report] CRITICAL: email sent but status write failed", s._id, err);
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  if (!updated)
    throw new WorkflowError(
      500,
      "The report email was sent, but recording it failed. Do not send it again — contact support.",
      "SENT_NOT_RECORDED",
    );

  await logReportEvent({
    submissionId: s._id,
    clientId: s.clientId,
    periodKey: s.periodKey,
    action: "delivery_sent",
    actorId: actor.userId,
    details: {
      attempt: attemptNo,
      messageId: sent.messageId,
      providerId: sent.providerId,
      senderEmail: ceo.email,
      to,
      cc,
      attachments: finals.map((f) => f.filename),
    },
  });
  if (updated.maPeriodId) await syncMaPeriod(updated.maPeriodId, sentAt, actor.userId);
  await notifyUsers(
    accountantIds(updated),
    `Sent to client: ${reportLabel(updated)} – ${client.name} – ${updated.periodLabel}`,
    "report_sent",
    baseMeta(updated, "accountant"),
  );
  return { report: updated, alreadySent: false };
}

// ─── Queries / presentation ───────────────────────────────────────

const fileUrl = (fileKey: string, name: string, download: boolean) => {
  const u = new URL(getLocalFileUrl(fileKey));
  u.searchParams.set("name", name);
  if (download) u.searchParams.set("download", "1");
  return u.toString();
};

const presentFile = (f: IStoredFile, names: Map<string, string>) => ({
  _id: String(f._id),
  filename: f.filename,
  size: f.size,
  uploadedAt: f.uploadedAt,
  uploadedByName: names.get(String(f.uploadedBy)),
  removed: !!f.removedAt,
  superseded: !!f.supersededAt,
  url: fileUrl(f.fileKey, f.filename, false),
  downloadUrl: fileUrl(f.fileKey, f.filename, true),
});

export async function listReports(
  actor: Actor,
  q: { status?: string; clientId?: string; scope?: string } = {},
) {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = { $in: q.status.split(",") };
  if (q.clientId && Types.ObjectId.isValid(q.clientId)) filter.clientId = q.clientId;

  if (q.scope === "mine") {
    // Reports I prepare as an accountant — whatever my role (CEO and
    // accountant supervisors serve clients too).
    filter.$or = [
      { primaryAccountantId: actor.userId },
      { secondaryAccountantIds: actor.userId },
    ];
  } else if (actor.role === "ceo") {
    // full read-only view
  } else if (actor.role === "supervisor" && (await isAccountantSupervisor(actor.userId))) {
    const supervised = await supervisedAccountantIds(actor.userId);
    filter.$or = [
      { supervisorIds: actor.userId },
      { primaryAccountantId: { $in: supervised } },
    ];
  } else if (actor.role === "accountant") {
    filter.$or = [
      { primaryAccountantId: actor.userId },
      { secondaryAccountantIds: actor.userId },
    ];
  } else {
    throw new WorkflowError(403, "You do not have access to reports");
  }

  const rows = await ReportSubmission.find(filter)
    .sort({ updatedAt: -1 })
    .limit(300)
    .lean();
  const clients = await ClientModel.find({ _id: { $in: rows.map((r) => r.clientId) } })
    .select("name")
    .lean();
  const clientName = new Map(clients.map((c) => [String(c._id), c.name]));
  const names = await userNames(
    rows.flatMap((r) => [r.primaryAccountantId, ...r.secondaryAccountantIds]),
  );
  return rows.map((r) => ({
    _id: String(r._id),
    clientId: String(r.clientId),
    clientName: clientName.get(String(r.clientId)) ?? "Unknown client",
    reportType: r.reportType,
    reportLabel:
      r.reportType === "management_accounts"
        ? "Management Accounts"
        : (r.reportTypeLabel ?? "Report"),
    periodKey: r.periodKey,
    periodLabel: r.periodLabel,
    status: r.status,
    revision: r.revision,
    submittedAt: r.submittedAt,
    approvedAt: r.approvedAt,
    sentAt: r.sentAt,
    primary: { id: String(r.primaryAccountantId), name: names.get(String(r.primaryAccountantId)) },
    secondaries: r.secondaryAccountantIds.map((i) => ({
      id: String(i),
      name: names.get(String(i)),
    })),
    attachmentCount: r.finalAttachments.filter((a) => !a.removedAt && !a.supersededAt).length,
    // A never-submitted draft can be deleted by the client's own accountants.
    canDelete:
      r.status === "draft" &&
      (r.versions ?? []).length === 0 &&
      (eq(r.primaryAccountantId, actor.userId) ||
        r.secondaryAccountantIds.some((i) => eq(i, actor.userId))),
    updatedAt: r.updatedAt,
  }));
}

export async function getReportDetail(actor: Actor, id: string) {
  const s = await loadSubmission(id);
  await assertCanSee(actor, s);
  const client = await ClientModel.findById(s.clientId)
    .select("name email company")
    .lean();
  const people = [
    s.primaryAccountantId,
    ...s.secondaryAccountantIds,
    s.approvedBy,
    s.createdBy,
    s.delivery?.initiatedBy,
    ...s.versions.flatMap((v) => [v.submittedBy, v.reviewedBy]),
    ...s.finalAttachments.map((f) => f.uploadedBy),
    ...s.supportingFiles.map((f) => f.uploadedBy),
  ];
  const names = await userNames(people as Id[]);
  const n = (i?: Id | null) => (i ? names.get(String(i)) : undefined);
  const audit = await ReportAuditEvent.find({ submissionId: s._id })
    .sort({ at: 1 })
    .limit(500)
    .lean();
  const auditNames = await userNames(audit.map((a) => a.actorId));

  // Preparing is about being on the client's team, not about the role: the CEO
  // and accountant supervisors serve clients too. Reviewing needs the
  // supervisor role AND not being on this report's team.
  const isPreparer = isAssignedAccountant(s, actor.userId);
  const iSubmitted = submittersOf(s).includes(actor.userId);
  const isReviewerView = actor.role !== "accountant" && !iSubmitted;
  const editable = ["draft", "returned"].includes(s.status);
  const blockedReason =
    isPreparer && editable
      ? await submitBlockedReason(
          s,
          actor,
          s.secondaryAccountantIds
            .filter((i) => !eq(i, actor.userId))
            .map((i) => n(i) ?? "")
            .filter(Boolean),
        )
      : null;
  const canSendNow =
    isReviewerView && actor.role === "supervisor" && ATTACHABLE.includes(s.status);
  let deliveryPreview: {
    senderEmail?: string;
    senderName?: string;
    senderError?: string;
    to: string | null;
    cc: string[];
    subject: string;
  } | null = null;
  if (canSendNow) {
    const r = await computeRecipients(s, client?.email, actor.userId);
    deliveryPreview = {
      to: r.to,
      cc: r.cc,
      subject: `${reportLabel(s)} – ${client?.name ?? ""} – ${s.periodLabel}`,
    };
    try {
      const ceo = await getCeoSender();
      deliveryPreview.senderEmail = ceo.email;
      deliveryPreview.senderName = ceo.name;
    } catch (err: any) {
      deliveryPreview.senderError = err?.message ?? "CEO sender is not configured";
    }
  }
  return {
    _id: String(s._id),
    client: client
      ? { id: String(client._id), name: client.name, email: client.email, company: client.company }
      : null,
    reportType: s.reportType,
    reportLabel: reportLabel(s),
    periodKey: s.periodKey,
    periodLabel: s.periodLabel,
    status: s.status,
    revision: s.revision,
    summary: s.summary,
    primary: { id: String(s.primaryAccountantId), name: n(s.primaryAccountantId) },
    secondaries: s.secondaryAccountantIds.map((i) => ({ id: String(i), name: n(i) })),
    createdAt: s.createdAt,
    submittedAt: s.submittedAt,
    firstSubmittedAt: s.firstSubmittedAt,
    approvedAt: s.approvedAt,
    approvedByName: n(s.approvedBy),
    sentAt: s.sentAt,
    supportingFiles: s.supportingFiles.map((f) => presentFile(f, names)),
    versions: s.versions.map((v) => ({
      revision: v.revision,
      submittedAt: v.submittedAt,
      submittedByName: n(v.submittedBy),
      summary: v.summary,
      supportingFiles: v.supportingFiles.map((f) => presentFile(f, names)),
      decision: v.decision,
      reviewedAt: v.reviewedAt,
      reviewedByName: n(v.reviewedBy),
      comments: v.comments,
    })),
    finalAttachments: s.finalAttachments
      .filter((f) => !f.removedAt && !f.supersededAt)
      .map((f) => presentFile(f, names)),
    delivery: s.delivery
      ? {
          senderEmail: s.delivery.senderEmail,
          senderName: s.delivery.senderName,
          initiatedByName: n(s.delivery.initiatedBy),
          to: s.delivery.to,
          cc: s.delivery.cc,
          subject: s.delivery.subject,
          attachmentNames: s.delivery.attachmentNames,
          messageId: s.delivery.messageId,
          sentAt: s.delivery.sentAt,
          lastError: s.delivery.lastError,
          attempts: s.delivery.attempts.map((a) => ({
            n: a.n,
            startedAt: a.startedAt,
            finishedAt: a.finishedAt,
            status: a.status,
            error: a.error,
            initiatedByName: n(a.initiatedBy),
          })),
        }
      : null,
    submitBlockedReason: blockedReason,
    deliveryPreview,
    audit: audit.map((a) => ({
      action: a.action,
      at: a.at,
      actorName: a.actorId ? auditNames.get(String(a.actorId)) : "System",
      details: a.details,
    })),
    // What the viewer may do right now (the server still re-checks every action).
    can: {
      delete: isPreparer && s.status === "draft" && s.versions.length === 0,
      edit: isPreparer && editable,
      submit: isPreparer && editable && !blockedReason,
      review: isReviewerView && actor.role === "supervisor" && s.status === "pending_review",
      attach: isReviewerView && actor.role === "supervisor" && ATTACHABLE.includes(s.status),
      send: isReviewerView && actor.role === "supervisor" && ATTACHABLE.includes(s.status),
    },
  };
}

export async function supervisorSummary(actor: Actor) {
  const rows = await listReports(actor);
  const count = (...st: string[]) => rows.filter((r) => st.includes(r.status)).length;
  return {
    pendingReviews: count("pending_review"),
    awaitingDelivery: count("approved", "sending", "delivery_failed"),
    deliveryFailed: count("delivery_failed"),
    returned: count("returned"),
  };
}

export { ReportFileError };