import { Request, Response } from "express";
import { waitUntil } from "@vercel/functions";
import { DocumentModel } from "../models/Document";
import { processDocumentDirectly } from "../services/documentProcessor";
import { syncAllConnectedMailboxes } from "../services/emailSyncService";
import {
  runMeetingReminderSweep,
  runMeetingAutoCompleteSweep,
} from "./meetingController";
import { runTaskReminderSweep } from "./taskReminderController";
import { runTodoReminderSweep } from "./todoReminderController";
import { User } from "../models/User";
import {
  buildSalesActivityReport,
  lastCompletedWeek,
  formatPeriodLabel,
} from "../services/salesReportService";
import { sendSalesWeeklyReportEmail } from "../services/emailService";

// ═════════════════════════════════════════════════════════════════
// These two endpoints replace the BullMQ-queued background jobs used
// in the traditional (Redis + worker process) deployment. On Vercel,
// there's no persistent worker to run them continuously — instead,
// an external free scheduler (cron-job.org / a scheduled GitHub
// Actions workflow) calls these on an interval. See the deployment
// guide for exact setup.
// ═════════════════════════════════════════════════════════════════

/**
 * POST /api/cron/sync-emails — call every ~5 minutes.
 *
 * Schedulers like cron-job.org give up after 30s, but a full sync can take
 * 45s+. Add ?async=1 to the URL and the endpoint replies 202 straight away
 * while the sync keeps running in the background (Vercel's waitUntil keeps
 * the function alive until it finishes, up to the function's time limit).
 * Without ?async=1 it behaves as before and returns the full result.
 */
export const runEmailSync = async (req: Request, res: Response) => {
  if (req.query.async === "1") {
    const job = syncAllConnectedMailboxes()
      .then((summary) =>
        console.log("Cron email sync (async) completed:", JSON.stringify(summary)),
      )
      .catch((err) => console.error("Cron email sync (async) failed:", err));
    waitUntil(job);
    res.status(202).json({ success: true, message: "Email sync started" });
    return;
  }

  try {
    const summary = await syncAllConnectedMailboxes();
    res.json({
      success: true,
      message: "Email sync run completed",
      ...summary,
    });
  } catch (err) {
    console.error("Cron email sync failed:", err);
    res.status(500).json({ success: false, message: "Email sync run failed" });
  }
};

/**
 * POST /api/cron/process-documents — call every ~5 minutes.
 *
 * Safety net for documents whose inline processing (triggered directly
 * at upload time — see documentController.ts) either failed or never
 * completed, most likely because it hit Vercel's per-invocation
 * execution time limit on a large/slow file. Picks up anything left
 * in "failed" status, or anything uploaded more than 2 minutes ago
 * that never got an indexedAt timestamp (covers the mid-processing
 * timeout case, where the request was cut off before the status
 * update at the end ever ran).
 *
 * Processes a small batch per run (not everything at once) so this
 * endpoint itself doesn't hit the same time limit that got the
 * original documents stuck in the first place.
 */
export const runDocumentRetrySweep = async (_req: Request, res: Response) => {
  const BATCH_SIZE = 5;
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

  try {
    const stuck = await DocumentModel.find({
      fileKey: { $exists: true, $ne: "" },
      $or: [
        { status: "failed" },
        { indexedAt: { $exists: false }, createdAt: { $lt: twoMinutesAgo } },
      ],
    })
      .select("_id fileKey fileType")
      .limit(BATCH_SIZE)
      .lean();

    let succeeded = 0;
    for (const doc of stuck) {
      const ok = await processDocumentDirectly({
        documentId: String(doc._id),
        fileKey: doc.fileKey!,
        fileType: doc.fileType,
      });
      if (ok) succeeded++;
    }

    res.json({
      success: true,
      message: `Retry sweep processed ${stuck.length} document(s), ${succeeded} succeeded`,
    });
  } catch (err) {
    console.error("Cron document retry sweep failed:", err);
    res.status(500).json({ success: false, message: "Retry sweep failed" });
  }
};

/**
 * POST /api/cron/meeting-reminders — call every ~5 minutes.
 * Sends a reminder notification to every organizer/attendee of a
 * scheduled meeting whose reminder window has just been entered (see
 * meetingController.runMeetingReminderSweep / Meeting.reminderMinutesBefore).
 */
export const runMeetingReminders = async (_req: Request, res: Response) => {
  try {
    const { sent } = await runMeetingReminderSweep();
    const { completed } = await runMeetingAutoCompleteSweep();
    res.json({
      success: true,
      message: `Meeting sweep: sent ${sent} reminder(s), auto-completed ${completed} meeting(s)`,
    });
  } catch (err) {
    console.error("Cron meeting reminder sweep failed:", err);
    res
      .status(500)
      .json({ success: false, message: "Meeting reminder sweep failed" });
  }
};

/**
 * POST /api/cron/task-reminders — call every ~5 minutes.
 * Delivers personal task and to-do item reminders whose time has arrived
 * (see taskReminderController / todoReminderController sweeps).
 */
export const runTaskReminders = async (_req: Request, res: Response) => {
  try {
    const { sent } = await runTaskReminderSweep();
    const { sent: todoSent } = await runTodoReminderSweep();
    res.json({
      success: true,
      message: `Reminders: sent ${sent} task, ${todoSent} to-do`,
    });
  } catch (err) {
    console.error("Cron task reminder sweep failed:", err);
    res
      .status(500)
      .json({ success: false, message: "Task reminder sweep failed" });
  }
};

/**
 * POST /api/cron/sales-weekly-report — call once a week (Monday morning).
 * Emails every active CEO a summary of the sales team's activity for the last
 * completed Monday–Sunday week (Nairobi time): leads added, meetings, client
 * discussions and pipeline movement, per sales person.
 */
export const runSalesWeeklyReport = async (_req: Request, res: Response) => {
  try {
    const { from, to } = lastCompletedWeek();
    const [report, ceos] = await Promise.all([
      buildSalesActivityReport(from, to),
      User.find({ role: "ceo", isActive: true }).select("name email").lean(),
    ]);
    const periodLabel = formatPeriodLabel(from, to);

    await Promise.all(
      ceos.map((ceo) =>
        sendSalesWeeklyReportEmail(ceo.email, {
          recipientName: ceo.name,
          periodLabel,
          from: from.toISOString().slice(0, 10),
          totals: report.totals,
          reps: report.reps,
          pipeline: report.pipeline,
        }),
      ),
    );

    res.json({
      success: true,
      message: `Sales weekly report (${periodLabel}) sent to ${ceos.length} CEO(s)`,
    });
  } catch (err) {
    console.error("Cron sales weekly report failed:", err);
    res
      .status(500)
      .json({ success: false, message: "Sales weekly report failed" });
  }
};