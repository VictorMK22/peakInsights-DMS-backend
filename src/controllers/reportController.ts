import { Response } from "express";
import { Types } from "mongoose";
import { AuthRequest } from "../types/auth";
import { ClientModel } from "../models/Client";
import {
  WorkflowError,
  Actor,
  openMaReport,
  openOtherReport,
  saveDraft,
  presignSupporting,
  removeSupportingFile,
  submitForReview,
  deleteDraftReport,
  exemptMaPeriod,
  reinstateMaPeriod,
  returnForCorrections,
  approveReport,
  reopenReport,
  presignFinalPdfs,
  attachFinalPdfs,
  removeFinalPdf,
  sendReportToClient,
  listReports,
  getReportDetail,
  supervisorSummary,
} from "../services/reportWorkflowService";
import { ReportFileError } from "../services/reportAttachmentService";
import {
  getClientMaTracking,
  listActiveAlerts,
  deliveryMonitor,
  listMyMaPeriods,
  ensureMaPeriod,
  clientOwesPeriod,
} from "../services/maTrackingService";
import { computePerformance } from "../services/maPerformanceService";
import {
  ceoSenderStatus,
  isAccountantSupervisor,
  supervisedAccountantIds,
  accountingStaffIds,
  resolveClientTeam,
} from "../services/reportTeamService";
import { currentReportingPeriod, isPeriodKey } from "../utils/maDeadlines";

const actorOf = (req: AuthRequest): Actor => ({
  userId: req.user!.userId,
  role: req.user!.role,
});

/** Runs a handler, mapping workflow/file errors to clean JSON responses. */
const handle =
  (fn: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  async (req: AuthRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof WorkflowError || err instanceof ReportFileError) {
        res.status(err.statusCode).json({
          success: false,
          message: err.message,
          code: (err as WorkflowError).code,
        });
        return;
      }
      console.error("[Reports] unexpected error", req.method, req.originalUrl, err);
      res.status(500).json({ success: false, message: "Something went wrong" });
    }
  };

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data });

const idParam = (req: AuthRequest, name = "id") => String(req.params[name]);

// ─── Workflow ─────────────────────────────────────────────────────

export const list = handle(async (req, res) => {
  ok(
    res,
    await listReports(actorOf(req), {
      status: req.query.status as string | undefined,
      clientId: req.query.clientId as string | undefined,
      scope: req.query.scope as string | undefined,
    }),
  );
});

export const summary = handle(async (req, res) => {
  ok(res, await supervisorSummary(actorOf(req)));
});

export const detail = handle(async (req, res) => {
  ok(res, await getReportDetail(actorOf(req), idParam(req)));
});

export const openMa = handle(async (req, res) => {
  const { clientId, periodKey } = req.body ?? {};
  const sub = await openMaReport(actorOf(req), String(clientId), String(periodKey));
  ok(res, await getReportDetail(actorOf(req), String(sub._id)), 201);
});

export const openOther = handle(async (req, res) => {
  const { clientId, reportTypeLabel, periodLabel } = req.body ?? {};
  const sub = await openOtherReport(actorOf(req), String(clientId), {
    reportTypeLabel,
    periodLabel,
  });
  ok(res, await getReportDetail(actorOf(req), String(sub._id)), 201);
});

export const presignSupportingFiles = handle(async (req, res) => {
  ok(res, await presignSupporting(actorOf(req), idParam(req), req.body?.files));
});

export const update = handle(async (req, res) => {
  const sub = await saveDraft(actorOf(req), idParam(req), {
    summary: req.body?.summary,
    uploads: req.body?.uploads,
  });
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const deleteSupporting = handle(async (req, res) => {
  const sub = await removeSupportingFile(
    actorOf(req),
    idParam(req),
    idParam(req, "fileId"),
  );
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const exemptPeriod = handle(async (req, res) => {
  await exemptMaPeriod(actorOf(req), idParam(req, "periodId"), req.body?.reason);
  ok(res, { exempt: true });
});

export const reinstatePeriod = handle(async (req, res) => {
  await reinstateMaPeriod(actorOf(req), idParam(req, "periodId"));
  ok(res, { exempt: false });
});

export const remove = handle(async (req, res) => {
  await deleteDraftReport(actorOf(req), idParam(req));
  ok(res, { deleted: true });
});

export const submit = handle(async (req, res) => {
  const sub = await submitForReview(actorOf(req), idParam(req), {
    summary: req.body?.summary,
  });
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const returnReport = handle(async (req, res) => {
  const sub = await returnForCorrections(actorOf(req), idParam(req), req.body?.comments);
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const approve = handle(async (req, res) => {
  const sub = await approveReport(actorOf(req), idParam(req));
  // Deliberately returns the report only — approving never sends an email.
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const reopen = handle(async (req, res) => {
  const sub = await reopenReport(actorOf(req), idParam(req), req.body?.comments);
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const presignFinal = handle(async (req, res) => {
  ok(res, await presignFinalPdfs(actorOf(req), idParam(req), req.body?.files));
});

export const attachFinal = handle(async (req, res) => {
  const sub = await attachFinalPdfs(actorOf(req), idParam(req), req.body?.uploads);
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const deleteFinal = handle(async (req, res) => {
  const sub = await removeFinalPdf(
    actorOf(req),
    idParam(req),
    idParam(req, "attachmentId"),
  );
  ok(res, await getReportDetail(actorOf(req), String(sub._id)));
});

export const send = handle(async (req, res) => {
  const result = await sendReportToClient(actorOf(req), idParam(req), {
    confirmedAttachmentIds: req.body?.confirmedAttachmentIds,
  });
  res.status(200).json({
    success: true,
    alreadySent: result.alreadySent,
    data: await getReportDetail(actorOf(req), String(result.report._id)),
  });
});

/** Whether client delivery is ready (CEO identity configured) — drives the Send button. */
export const deliveryConfig = handle(async (req, res) => {
  const a = actorOf(req);
  if (a.role !== "ceo" && !(a.role === "supervisor" && (await isAccountantSupervisor(a.userId))))
    throw new WorkflowError(403, "Not allowed");
  ok(res, await ceoSenderStatus());
});

// ─── Monthly Management Accounts tracking ─────────────────────────

async function assertCanViewClient(actor: Actor, clientId: string) {
  if (!Types.ObjectId.isValid(clientId)) throw new WorkflowError(400, "Invalid client id");
  const client = await ClientModel.findById(clientId);
  if (!client) throw new WorkflowError(404, "Client not found");
  if (actor.role === "ceo") return client;
  if (actor.role === "supervisor" && (await isAccountantSupervisor(actor.userId)))
    return client;
  if (
    actor.role === "accountant" &&
    (client.assignedTo ?? []).some((i) => String(i) === actor.userId)
  )
    return client;
  throw new WorkflowError(403, "You do not have access to this client");
}

export const clientTracking = handle(async (req, res) => {
  const client = await assertCanViewClient(actorOf(req), idParam(req, "clientId"));
  ok(res, await getClientMaTracking(client));
});

/** The reporting month an accountant is working on, opened for a client (creates the tracking row). */
export const clientCurrentPeriod = handle(async (req, res) => {
  const client = await assertCanViewClient(actorOf(req), idParam(req, "clientId"));
  const key = currentReportingPeriod();
  if (!clientOwesPeriod(client, key))
    throw new WorkflowError(400, "This client is not required to receive MAs for this month");
  const p = await ensureMaPeriod(client, key);
  ok(res, { periodKey: p.periodKey, periodLabel: p.periodLabel, deadline: p.deadline });
});

export const setClientMaConfig = handle(async (req, res) => {
  const a = actorOf(req);
  if (a.role !== "ceo" && !(a.role === "supervisor" && (await isAccountantSupervisor(a.userId))))
    throw new WorkflowError(403, "Only the CEO or Accountant Supervisor can change this");
  const client = await assertCanViewClient(a, idParam(req, "clientId"));
  const { maRequired, maStartPeriod, maExemptReason } = req.body ?? {};
  if (typeof maRequired === "boolean") client.maRequired = maRequired;
  if (maStartPeriod === null || maStartPeriod === "") client.maStartPeriod = undefined;
  else if (maStartPeriod !== undefined) {
    if (!isPeriodKey(maStartPeriod))
      throw new WorkflowError(400, "Start period must look like 2026-10");
    client.maStartPeriod = maStartPeriod;
  }
  if (typeof maExemptReason === "string") client.maExemptReason = maExemptReason.slice(0, 300);
  await client.save();
  ok(res, await getClientMaTracking(client));
});

/**
 * Whose data a caller may see, as a list of user ids (undefined = everyone,
 * which only the CEO gets).
 *
 *   self=true        → just me. Used by the accountant workspace, where the
 *                      CEO / an accountant supervisor see only their own work.
 *   accountant       → just me.
 *   accountant sup.  → the accountants they supervise, plus themselves (they
 *                      serve clients too).
 *   CEO              → everyone who serves clients: accountants, accountant
 *                      supervisors and the CEO — for performance; every
 *                      period (no filter) for alerts / delivery.
 */
async function scopeIds(
  actor: Actor,
  opts: { self?: boolean; requested?: string; forPerformance?: boolean },
): Promise<string[] | undefined> {
  const isSup = actor.role === "supervisor" && (await isAccountantSupervisor(actor.userId));
  if (actor.role !== "accountant" && actor.role !== "ceo" && !isSup)
    throw new WorkflowError(403, "You do not have access to this data");

  if (opts.self || actor.role === "accountant") {
    if (opts.requested && opts.requested !== actor.userId)
      throw new WorkflowError(403, "You can only view your own data");
    return [actor.userId];
  }
  if (actor.role === "ceo") {
    if (opts.requested) return [opts.requested];
    return opts.forPerformance ? await accountingStaffIds() : undefined;
  }
  const team = [...new Set([...(await supervisedAccountantIds(actor.userId)), actor.userId])];
  if (opts.requested) {
    if (!team.includes(opts.requested))
      throw new WorkflowError(403, "That person is not on your team");
    return [opts.requested];
  }
  return team;
}

export const alerts = handle(async (req, res) => {
  const a = actorOf(req);
  const ids = await scopeIds(a, { self: req.query.scope === "self" });
  ok(res, await listActiveAlerts({ accountantIds: ids }));
});

/**
 * Clients the signed-in user serves as an accountant (primary or secondary) —
 * feeds the "start another report" picker. Works for the CEO and accountant
 * supervisors too, since they serve clients.
 */
export const myClients = handle(async (req, res) => {
  const a = actorOf(req);
  const rows = await ClientModel.find({
    isSalesLead: { $ne: true },
    $or: [{ assignedTo: a.userId }, { allocatedAccountant: a.userId }],
  })
    .sort({ name: 1 })
    .limit(1000);
  const mine: { id: string; name: string }[] = [];
  for (const c of rows) {
    const t = await resolveClientTeam(c);
    if (
      String(t.primary?._id) === a.userId ||
      t.secondaries.some((x) => String(x._id) === a.userId)
    )
      mine.push({ id: String(c._id), name: c.name });
  }
  ok(res, mine);
});

/** The signed-in user's own worklist for the current reporting month. */
export const myPeriods = handle(async (req, res) => {
  ok(res, await listMyMaPeriods(actorOf(req).userId));
});

export const delivery = handle(async (req, res) => {
  const a = actorOf(req);
  const ids = await scopeIds(a, { self: req.query.scope === "self" });
  const periodKey = isPeriodKey(req.query.period) ? (req.query.period as string) : undefined;
  ok(res, await deliveryMonitor({ periodKey, accountantIds: ids }));
});

export const performance = handle(async (req, res) => {
  const a = actorOf(req);
  const ids = await scopeIds(a, {
    self: req.query.scope === "self",
    requested: req.query.accountantId as string | undefined,
    forPerformance: true,
  });
  const result = await computePerformance(ids ?? [], {
    fromPeriod: req.query.from as string | undefined,
    toPeriod: req.query.to as string | undefined,
  });
  // Put the viewer first so "you" is easy to find in a team list.
  result.accountants = result.accountants
    .map((x) => ({ ...x, isSelf: x.accountantId === a.userId }))
    .sort((x, y) => Number(!!y.isSelf) - Number(!!x.isSelf) || x.name.localeCompare(y.name));
  ok(res, result);
});