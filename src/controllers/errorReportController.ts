import { Response, NextFunction } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../types/auth";
import { JwtPayload } from "../types";
import { User } from "../models/User";
import {
  ErrorReport,
  IErrorReport,
  ERROR_SEVERITIES,
  ERROR_STATUSES,
  ErrorReportStatus,
  OPEN_STATUSES,
  nextReportNumber,
} from "../models/ErrorReport";
import { isTechDepartmentName } from "../middleware/auth";
import { ScreenshotRequest, StoredScreenshot } from "../middleware/screenshotUpload";
import { enrichAttachments } from "./attachmentController";
import { createNotification } from "../services/notificationService";
import {
  emailsEnabled,
  getIctRecipients,
  meetsEmailThreshold,
  scheduleErrorReport,
} from "../services/errorReportService";
import {
  sendUserErrorReportEmail,
  sendErrorReportCommentEmail,
  sendErrorReportStatusEmail,
} from "../services/emailService";
import { normalizePath, scrub } from "../utils/errorScrub";

// ─── helpers ──────────────────────────────────────────────────────

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const idOk = (id: unknown): id is string =>
  typeof id === "string" && mongoose.isValidObjectId(id);

/**
 * ONLY a supervisor of a Tech department. The CEO and Tech staff are
 * deliberately NOT included: the error reports queue belongs to the tech
 * supervisor alone. Everyone else reports through "Report a problem" and can
 * only ever see the reports they filed themselves.
 */
const hasIctAccess = async (req: AuthRequest): Promise<boolean> => {
  if (req.user?.role !== "supervisor") return false;
  const me = await User.findById(req.user.userId).select("department");
  return isTechDepartmentName(me?.department);
};

/** Route guard for everything that is the tech supervisor's alone. */
export const requireTechSupervisor = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (await hasIctAccess(req)) return next();
    res.status(403).json({
      success: false,
      message: "Only the tech supervisor can access error reports.",
    });
  } catch (err) {
    next(err);
  }
};

const isOwner = (report: IErrorReport, userId: string): boolean =>
  !!report.reportedBy && String(report.reportedBy) === userId;

const pathOf = (raw: unknown): string => {
  const s = clean(raw, 500);
  if (!s) return "";
  try {
    return new URL(s, "http://x").pathname;
  } catch {
    return s.split("?")[0];
  }
};

const mailAttachments = (shots: StoredScreenshot[]) =>
  shots.map((s) => ({
    filename: s.filename,
    content: s.buffer,
    contentType: s.mimeType,
  }));

const attachmentDocs = (shots: StoredScreenshot[], userId: string) =>
  shots.map((s) => ({
    fileKey: s.fileKey,
    filename: s.filename,
    mimeType: s.mimeType,
    size: s.size,
    uploadedBy: userId,
    uploadedAt: new Date(),
  }));

const POPULATE = [
  { path: "reportedBy", select: "name email role department" },
  { path: "assignee", select: "name email" },
  { path: "comments.author", select: "name role" },
];

/** Shapes a report for the person asking. The reporter never sees stacks,
 *  fingerprints or internal notes. */
const toView = (doc: IErrorReport, ict: boolean) => {
  const o = enrichAttachments(doc.toObject() as any) as any;
  o.comments = (o.comments ?? [])
    .filter((c: any) => ict || !c.internal)
    .map((c: any) => enrichAttachments(c));
  if (!ict) {
    for (const k of [
      "stack",
      "fingerprint",
      "openKey",
      "requestIds",
      "lastAlertedAt",
      "occurrencesAtLastAlert",
    ])
      delete o[k];
  }
  return o;
};

/** Tells the tech team (not the actor) about a user report or comment. */
const notifyIct = async (
  report: IErrorReport,
  actor: { id: string; name: string; role: string; email?: string },
  mode: "new" | "comment",
  shots: StoredScreenshot[],
  commentBody = "",
  relatedNumber?: string,
): Promise<{
  emailed: number;
  recipients: number;
  emailsEnabled: boolean;
  emailSkipped?: boolean;
}> => {
  const all = await getIctRecipients();
  // Warnings (low severity) are saved and shown in-app, but never emailed.
  const emailsOn = emailsEnabled();
  const sendEmail = emailsOn && meetsEmailThreshold(report.severity);
  const targets = all.filter(
    (r) => r.userId !== actor.id && r.email.toLowerCase() !== actor.email?.toLowerCase(),
  );
  const attachments = mailAttachments(shots);
  const last = report.context?.lastApiError;

  const results = await Promise.allSettled(
    (sendEmail ? targets : []).map((t) =>
      mode === "new"
        ? sendUserErrorReportEmail(
            t.email,
            t.name,
            {
              reportId: String(report._id),
              reportNumber: report.reportNumber,
              severity: report.severity,
              title: report.title,
              description: report.description,
              reporterName: actor.name,
              reporterEmail: actor.email,
              reporterRole: actor.role,
              pageUrl: report.context?.pageUrl,
              requestId: report.requestIds?.[0],
              lastApiError: last
                ? [last.method, last.url, last.status, last.message]
                    .filter(Boolean)
                    .join(" ")
                : undefined,
              screenshotCount: shots.length,
              relatedReportNumber: relatedNumber,
              occurredAt: report.createdAt ?? new Date(),
            },
            attachments,
          )
        : sendErrorReportCommentEmail(
            t.email,
            t.name,
            {
              reportId: String(report._id),
              reportNumber: report.reportNumber,
              title: report.title,
              authorName: actor.name,
              authorRole: actor.role,
              body: commentBody,
              screenshotCount: shots.length,
              audience: "ict",
            },
            attachments,
            actor.email,
          ),
    ),
  );
  const emailed = results.filter(
    (r) => r.status === "fulfilled" && r.value === true,
  ).length;

  await Promise.allSettled(
    targets
      .filter((t) => t.userId)
      .map((t) =>
        createNotification(
          t.userId!,
          mode === "new"
            ? `${actor.name} reported a problem: ${report.title.slice(0, 90)}`
            : `${actor.name} commented on ${report.reportNumber}`,
          mode === "new" ? "error_report_new" : "error_report_comment",
          { reportId: String(report._id), reportNumber: report.reportNumber },
        ),
      ),
  );
  return {
    emailed,
    recipients: targets.length,
    emailsEnabled: emailsOn,
    ...(emailsOn && !sendEmail ? { emailSkipped: true } : {}),
  };
};

// ─── POST /api/error-reports — a person reports a problem ─────────

export const createUserReport = async (
  req: ScreenshotRequest & AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const me = await User.findById(req.user!.userId).select(
      "name email role department",
    );
    if (!me) {
      res.status(401).json({ success: false, message: "User not found" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const shots = req.screenshots ?? [];
    const description = clean(b.description, 4000);
    let title = clean(b.title, 150);

    if (!description && !title && shots.length === 0) {
      res.status(400).json({
        success: false,
        message: "Add a comment or a screenshot so the tech team knows what went wrong.",
      });
      return;
    }
    if (!title) {
      title = description
        ? description.split("\n")[0].slice(0, 100)
        : `Screenshot from ${me.name}`;
    }

    const severity = ERROR_SEVERITIES.includes(b.severity as any)
      ? (b.severity as (typeof ERROR_SEVERITIES)[number])
      : "medium";

    const rid = clean(b.requestId, 16);
    const requestId = /^[a-f0-9]{8}$/i.test(rid) ? rid.toLowerCase() : undefined;

    let lastApiError: Record<string, unknown> | undefined;
    try {
      const raw = typeof b.lastApiError === "string" ? JSON.parse(b.lastApiError) : null;
      if (raw && typeof raw === "object") {
        lastApiError = {
          method: clean(raw.method, 10),
          url: scrub(pathOf(raw.url), 300),
          status: Number.isFinite(Number(raw.status)) ? Number(raw.status) : undefined,
          message: scrub(clean(raw.message, 300), 300),
          at: clean(raw.at, 40),
        };
      }
    } catch {
      /* ignore malformed hint */
    }

    // If they quoted the id of a server error, link the two reports.
    const related = requestId
      ? await ErrorReport.findOne({
          source: { $ne: "user_report" },
          requestIds: requestId,
        }).select("_id reportNumber")
      : null;

    const report = await ErrorReport.create({
      reportNumber: await nextReportNumber(),
      source: "user_report",
      severity,
      status: "new",
      title,
      description,
      context: {
        pageUrl: scrub(pathOf(b.pageUrl), 300),
        userAgent: scrub(req.get("user-agent"), 300),
        lastApiError,
      },
      requestIds: requestId ? [requestId] : [],
      relatedReportId: related?._id,
      reportedBy: me._id,
      reportedByName: me.name,
      reportedByRole: me.role,
      attachments: attachmentDocs(shots, String(me._id)),
    });

    const notified = await notifyIct(
      report,
      { id: String(me._id), name: me.name, role: me.role, email: me.email },
      "new",
      shots,
      "",
      related?.reportNumber,
    ).catch((err) => {
      console.error("[ErrorReport] could not notify tech team:", err);
      return { emailed: 0, recipients: 0, emailsEnabled: emailsEnabled() };
    });

    await report.populate(POPULATE);
    res.status(201).json({
      success: true,
      message: "Report sent to the tech team",
      data: { report: toView(report, false), notified },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/error-reports/mine ──────────────────────────────────

export const listMine = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const reports = await ErrorReport.find({
      reportedBy: req.user!.userId,
      source: "user_report",
    })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select(
        "reportNumber title severity status commentCount lastCommentAt lastCommentByRole createdAt updatedAt attachments",
      )
      .lean();
    res.json({
      success: true,
      data: {
        reports: reports.map(({ attachments, ...r }) => ({
          ...r,
          attachmentCount: attachments?.length ?? 0,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/error-reports — the tech team's queue ───────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const listAll = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const filter: Record<string, unknown> = {};

    const statuses = (q.status ?? "")
      .split(",")
      .filter((s) => ERROR_STATUSES.includes(s as ErrorReportStatus));
    if (q.status === "open") filter.status = { $in: OPEN_STATUSES };
    else if (statuses.length) filter.status = { $in: statuses };

    if (q.severity && ERROR_SEVERITIES.includes(q.severity as any))
      filter.severity = q.severity;
    if (q.source && ["server", "client", "user_report"].includes(q.source))
      filter.source = q.source;

    const search = clean(q.q, 100);
    if (search) {
      const re = new RegExp(escapeRe(search), "i");
      filter.$or = [
        { title: re },
        { message: re },
        { reportNumber: re },
        { reportedByName: re },
        { requestIds: search.toLowerCase() },
      ];
    }

    const limit = Math.min(Math.max(parseInt(q.limit ?? "25", 10) || 25, 1), 100);
    const page = Math.max(parseInt(q.page ?? "1", 10) || 1, 1);

    const [reports, total, byStatus, criticalOpen] = await Promise.all([
      ErrorReport.find(filter)
        .sort({ lastSeenAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("-stack -comments -fingerprint -openKey -requestIds")
        .populate("reportedBy", "name role")
        .populate("assignee", "name")
        .lean(),
      ErrorReport.countDocuments(filter),
      ErrorReport.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      ErrorReport.countDocuments({
        status: { $in: OPEN_STATUSES },
        severity: "critical",
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const row of byStatus) counts[row._id] = row.n;

    res.json({
      success: true,
      data: {
        reports: reports.map(({ attachments, ...r }) => ({
          ...r,
          attachmentCount: attachments?.length ?? 0,
        })),
        total,
        page,
        pages: Math.max(Math.ceil(total / limit), 1),
        counts,
        criticalOpen,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/error-reports/:id ───────────────────────────────────

const loadForViewer = async (
  req: AuthRequest,
  res: Response,
): Promise<{ report: IErrorReport; ict: boolean } | null> => {
  if (!idOk(req.params.id)) {
    res.status(404).json({ success: false, message: "Report not found" });
    return null;
  }
  const report = await ErrorReport.findById(req.params.id);
  const ict = await hasIctAccess(req);
  // Same answer for "missing" and "not yours" so ids can't be probed.
  if (!report || (!ict && !isOwner(report, req.user!.userId))) {
    res.status(404).json({ success: false, message: "Report not found" });
    return null;
  }
  return { report, ict };
};

export const getReport = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const loaded = await loadForViewer(req, res);
    if (!loaded) return;
    await loaded.report.populate(POPULATE);
    let related: unknown = null;
    if (loaded.ict && loaded.report.relatedReportId) {
      related = await ErrorReport.findById(loaded.report.relatedReportId).select(
        "reportNumber title status",
      );
    }
    res.json({
      success: true,
      data: { report: toView(loaded.report, loaded.ict), related },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/error-reports/:id/comments ─────────────────────────

export const addComment = async (
  req: ScreenshotRequest & AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const loaded = await loadForViewer(req, res);
    if (!loaded) return;
    const { report, ict } = loaded;
    const me = await User.findById(req.user!.userId).select("name email role");
    if (!me) {
      res.status(401).json({ success: false, message: "User not found" });
      return;
    }

    const b = req.body as Record<string, unknown>;
    const body = clean(b.body, 4000);
    const shots = req.screenshots ?? [];
    if (!body && shots.length === 0) {
      res.status(400).json({
        success: false,
        message: "Write a comment or attach a screenshot.",
      });
      return;
    }

    const owner = isOwner(report, String(me._id));
    // Only the ICT team can write notes the reporter will not see.
    const internal = ict && !owner && (b.internal === true || b.internal === "true");

    const set: Record<string, unknown> = {
      lastCommentAt: new Date(),
      lastCommentByRole: me.role,
    };
    // The reporter writing again on a closed report means it isn't fixed.
    const reopen = owner && (report.status === "resolved" || report.status === "ignored");
    if (reopen) set.status = "new";

    const updated = await ErrorReport.findByIdAndUpdate(
      report._id,
      {
        $push: {
          comments: {
            author: me._id,
            authorName: me.name,
            authorRole: me.role,
            body,
            internal,
            attachments: attachmentDocs(shots, String(me._id)),
            createdAt: new Date(),
          },
        },
        $inc: { commentCount: 1 },
        $set: set,
        ...(reopen ? { $unset: { resolvedAt: 1 } } : {}),
      },
      { new: true },
    );
    if (!updated) {
      res.status(404).json({ success: false, message: "Report not found" });
      return;
    }

    if (!internal) {
      const actor = { id: String(me._id), name: me.name, role: me.role, email: me.email };
      try {
        if (owner) {
          await notifyIct(updated, actor, "comment", shots, body);
        } else if (updated.reportedBy) {
          const reporter = await User.findById(updated.reportedBy).select("name email");
          if (reporter) {
            await Promise.allSettled([
              createNotification(
                String(reporter._id),
                `${me.name} replied to your report ${updated.reportNumber}`,
                "error_report_comment",
                { reportId: String(updated._id), reportNumber: updated.reportNumber },
              ),
              reporter.email && emailsEnabled()
                ? sendErrorReportCommentEmail(
                    reporter.email,
                    reporter.name,
                    {
                      reportId: String(updated._id),
                      reportNumber: updated.reportNumber,
                      title: updated.title,
                      authorName: me.name,
                      authorRole: me.role,
                      body,
                      screenshotCount: shots.length,
                      audience: "reporter",
                    },
                    mailAttachments(shots),
                    me.email,
                  )
                : Promise.resolve(false),
            ]);
          }
        }
      } catch (err) {
        console.error("[ErrorReport] comment notification failed:", err);
      }
    }

    await updated.populate(POPULATE);
    res.status(201).json({
      success: true,
      message: "Comment added",
      data: { report: toView(updated, ict) },
    });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/error-reports/:id — triage (ICT only) ─────────────

export const updateReport = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!idOk(req.params.id)) {
      res.status(404).json({ success: false, message: "Report not found" });
      return;
    }
    const report = await ErrorReport.findById(req.params.id);
    if (!report) {
      res.status(404).json({ success: false, message: "Report not found" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};

    if (b.severity !== undefined) {
      if (!ERROR_SEVERITIES.includes(b.severity as any)) {
        res.status(400).json({ success: false, message: "Invalid severity" });
        return;
      }
      $set.severity = b.severity;
    }

    if (b.assignee !== undefined) {
      if (b.assignee === null || b.assignee === "") {
        $unset.assignee = 1;
      } else if (idOk(b.assignee) && (await User.exists({ _id: b.assignee, isActive: true }))) {
        $set.assignee = b.assignee;
      } else {
        res.status(400).json({ success: false, message: "Invalid assignee" });
        return;
      }
    }

    let statusChangedTo: ErrorReportStatus | null = null;
    if (b.status !== undefined) {
      if (!ERROR_STATUSES.includes(b.status as ErrorReportStatus)) {
        res.status(400).json({ success: false, message: "Invalid status" });
        return;
      }
      const status = b.status as ErrorReportStatus;
      if (status !== report.status) statusChangedTo = status;
      $set.status = status;
      if (status === "resolved") {
        $set.resolvedAt = new Date();
        // Frees the fingerprint: if it breaks again it's a NEW report + alert.
        if (report.fingerprint) $unset.openKey = 1;
      } else {
        $unset.resolvedAt = 1;
        if (report.fingerprint) $set.openKey = report.fingerprint;
      }
    }

    if (!Object.keys($set).length && !Object.keys($unset).length) {
      res.status(400).json({ success: false, message: "Nothing to update" });
      return;
    }

    let updated: IErrorReport | null;
    try {
      updated = await ErrorReport.findByIdAndUpdate(
        report._id,
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) },
        { new: true },
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({
          success: false,
          message: "A newer report for this same error is already open — update that one instead.",
        });
        return;
      }
      throw err;
    }
    if (!updated) {
      res.status(404).json({ success: false, message: "Report not found" });
      return;
    }

    // Close the loop with the person who reported it.
    if (statusChangedTo === "resolved" && updated.reportedBy && String(updated.reportedBy) !== req.user!.userId) {
      try {
        const [reporter, actor] = await Promise.all([
          User.findById(updated.reportedBy).select("name email"),
          User.findById(req.user!.userId).select("name"),
        ]);
        if (reporter) {
          await Promise.allSettled([
            createNotification(
              String(reporter._id),
              `Your report ${updated.reportNumber} was marked resolved`,
              "error_report_status",
              { reportId: String(updated._id), reportNumber: updated.reportNumber },
            ),
            reporter.email && emailsEnabled()
              ? sendErrorReportStatusEmail(reporter.email, reporter.name, {
                  reportId: String(updated._id),
                  reportNumber: updated.reportNumber,
                  title: updated.title,
                  status: "resolved",
                  byName: actor?.name ?? "The tech team",
                })
              : Promise.resolve(false),
          ]);
        }
      } catch (err) {
        console.error("[ErrorReport] status notification failed:", err);
      }
    }

    await updated.populate(POPULATE);
    res.json({
      success: true,
      message: "Report updated",
      data: { report: toView(updated, true) },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/error-reports/client — browser errors ──────────────
// Intake for errors the React app caught. Public-ish (a crash can happen
// before login), so it is rate limited per IP in the route, never echoes
// anything back, and funnels into the same de-duplicating pipeline.

export const reportClientError = (req: AuthRequest, res: Response): void => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const message = clean(b.message, 1000);
    if (!message) {
      res.status(400).json({ success: false });
      return;
    }
    const err = new Error(message);
    err.name = clean(b.name, 60) || "Error";
    const stack = clean(b.stack, 6000);
    const componentStack = clean(b.componentStack, 2000);
    err.stack = [stack, componentStack && `Component stack:${componentStack}`]
      .filter(Boolean)
      .join("\n");

    const page = pathOf(b.pageUrl);
    const kind = ["react-boundary", "window.onerror", "unhandledrejection"].includes(
      b.kind as string,
    )
      ? (b.kind as string)
      : "window.onerror";
    const u = req.user;

    scheduleErrorReport({
      source: "client",
      error: err,
      context: {
        pageUrl: scrub(page, 300),
        route: normalizePath(page),
        userAgent: scrub(req.get("user-agent"), 300),
        kind,
      },
      user: u ? { id: u.userId, role: u.role, email: u.email } : undefined,
    });
    res.status(202).json({ success: true });
  } catch {
    res.status(202).json({ success: true });
  }
};

/** Attaches req.user when a valid token is present; never rejects. */
export const tryAuthenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ") && process.env.JWT_SECRET) {
      const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET) as JwtPayload;
      const u = await User.findById(decoded.userId).select("role email isActive");
      if (u?.isActive) {
        req.user = { userId: decoded.userId, role: u.role, email: u.email };
      }
    }
  } catch {
    /* anonymous */
  }
  next();
};