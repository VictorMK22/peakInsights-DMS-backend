import mongoose from "mongoose";
import { waitUntil } from "@vercel/functions";
import { User } from "../models/User";
import {
  ErrorReport,
  IErrorContext,
  IErrorReport,
  ErrorSeverity,
  ERROR_SEVERITIES,
  nextReportNumber,
} from "../models/ErrorReport";
import { isTechDepartmentName } from "../middleware/auth";
import { createNotification } from "./notificationService";
import { sendErrorAlertEmail, ErrorAlertEmailData } from "./emailService";
import {
  fingerprintOf,
  normalizeMessage,
  parseEmailList,
  scrub,
  topAppFrame,
} from "../utils/errorScrub";

// ═════════════════════════════════════════════════════════════════
// Central error reporting.
//
//   reportError(...)  → store (de-duplicated) + email the tech supervisor
//
// Design rules:
//  1. NEVER throw. Reporting an error must not create another one.
//  2. De-duplicate. One failing endpoint hit 500 times is one report.
//     The first occurrence emails immediately; repeats are counted and
//     only re-alert (at most hourly) while nobody has acknowledged it.
//  3. Bounded. A global per-hour alert budget stops a flood of
//     *different* errors from burying the inbox / exhausting Resend.
//  4. Works when the DB is down. Then there is nobody to look up, so it
//     falls back to ERROR_ALERT_EMAILS (set this to the tech
//     supervisor's address) with an in-memory throttle.
// ═════════════════════════════════════════════════════════════════

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const settings = () => ({
  minAlertSeverity: ((): ErrorSeverity => {
    const v = (process.env.ERROR_ALERT_MIN_SEVERITY ?? "").toLowerCase();
    return ERROR_SEVERITIES.includes(v as ErrorSeverity)
      ? (v as ErrorSeverity)
      : "medium";
  })(),
  cooldownMs: num(process.env.ERROR_ALERT_COOLDOWN_MINUTES, 60) * 60_000,
  maxAlertsPerHour: num(process.env.ERROR_ALERT_MAX_PER_HOUR, 30),
  extraEmails: parseEmailList(process.env.ERROR_ALERT_EMAILS),
});

/**
 * Email is OFF by default: errors are delivered inside the app (the Error
 * Reports workspace + the notification bell). Set ERROR_EMAILS_ENABLED=true
 * to also send emails (alerts, report/reply emails, ERROR_ALERT_EMAILS).
 */
export const emailsEnabled = (): boolean =>
  (process.env.ERROR_EMAILS_ENABLED ?? "").toLowerCase() === "true";

/**
 * Warnings are not emailed. Anything below ERROR_ALERT_MIN_SEVERITY (default
 * "medium", so "low" = warning) is still stored, shown in Error Reports and
 * sent to the in-app bell — it just never lands in an inbox.
 */
export const meetsEmailThreshold = (severity: ErrorSeverity): boolean =>
  ERROR_SEVERITIES.indexOf(severity) >=
  ERROR_SEVERITIES.indexOf(settings().minAlertSeverity);

/** On by default; off under Jest unless ERROR_REPORTING_ENABLED=true. */
export const isReportingEnabled = (): boolean => {
  const flag = process.env.ERROR_REPORTING_ENABLED;
  if (flag !== undefined && flag !== "") return flag.toLowerCase() !== "false";
  return process.env.NODE_ENV !== "test";
};

export interface ReportErrorInput {
  source: "server" | "client";
  /** The thrown value, if there is one. */
  error?: unknown;
  /** Used when there is no Error object (e.g. a swallowed 500). */
  message?: string;
  title?: string;
  severity?: ErrorSeverity;
  context?: IErrorContext;
  requestId?: string;
  user?: { id?: string; role?: string; email?: string };
}

interface Normalized {
  source: "server" | "client";
  name: string;
  message: string;
  stack?: string;
  title: string;
  severity: ErrorSeverity;
  context: IErrorContext;
  requestId?: string;
  user?: ReportErrorInput["user"];
  fingerprint: string;
}

const CRITICAL_KINDS = new Set([
  "uncaughtException",
  "unhandledRejection",
  "db-connect",
  "startup",
]);

const normalize = (input: ReportErrorInput): Normalized => {
  const err = input.error;
  const isErr = err instanceof Error;
  const name = isErr
    ? err.name
    : typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "Error";
  const rawMessage =
    input.message ??
    (isErr
      ? err.message
      : typeof err === "string"
        ? err
        : err !== undefined
          ? safeStringify(err)
          : "Unknown error");
  const message = scrub(rawMessage, 1500) || "Unknown error";
  const stack = isErr && err.stack ? scrub(err.stack, 8000) : undefined;

  const context: IErrorContext = { ...(input.context ?? {}) };
  const where =
    input.source === "client"
      ? (context.pageUrl ?? "")
      : [context.method, context.route].filter(Boolean).join(" ");

  const title =
    scrub(input.title, 200) ||
    scrub(where ? `[${where}] ${name}: ${message}` : `${name}: ${message}`, 200);

  const severity: ErrorSeverity =
    input.severity ??
    (context.kind && CRITICAL_KINDS.has(context.kind)
      ? "critical"
      : context.kind === "react-boundary"
        ? "high"
        : input.source === "server"
          ? "high"
          : "medium");

  // Client stacks are minified bundles (meaningless frames), so a browser
  // error is identified by message + page; a server error also by code location.
  const fingerprint = fingerprintOf([
    input.source,
    context.method,
    context.route ?? (input.source === "client" ? context.pageUrl : ""),
    name,
    normalizeMessage(message),
    input.source === "server" ? topAppFrame(stack) : "",
  ]);

  return {
    source: input.source,
    name,
    message,
    stack,
    title,
    severity,
    context,
    requestId: input.requestId,
    user: input.user,
    fingerprint,
  };
};

const safeStringify = (v: unknown): string => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

// ── Recipients ───────────────────────────────────────────────────

export interface IctRecipient {
  userId?: string;
  name?: string;
  email: string;
}

/**
 * The tech supervisor(s): active supervisors whose department counts as
 * Tech (same rule as middleware/auth.ts), plus anything in
 * ERROR_ALERT_EMAILS. De-duplicated by address.
 */
export const getIctRecipients = async (): Promise<IctRecipient[]> => {
  const supervisors = await User.find({ role: "supervisor", isActive: true })
    .select("name email department")
    .lean();
  const out = new Map<string, IctRecipient>();
  for (const s of supervisors) {
    if (!s.email || !isTechDepartmentName(s.department)) continue;
    out.set(s.email.toLowerCase(), {
      userId: String(s._id),
      name: s.name,
      email: s.email,
    });
  }
  for (const email of settings().extraEmails) {
    if (!out.has(email)) out.set(email, { email });
  }
  return [...out.values()];
};

// ── Storage + de-duplication ─────────────────────────────────────

interface RecordResult {
  report: IErrorReport;
  isNew: boolean;
  shouldAlert: boolean;
  sinceLastAlert?: number;
}

const alertBudgetExhausted = async (): Promise<boolean> => {
  const since = new Date(Date.now() - 3_600_000);
  const n = await ErrorReport.countDocuments({
    lastAlertedAt: { $gte: since },
  });
  return n >= settings().maxAlertsPerHour;
};

// The serverless connection runs with autoIndex:false, so Mongoose will not
// build indexes by itself. The UNIQUE openKey index is what makes concurrent
// duplicate errors collapse into one report, so make sure it exists
// (idempotent; once per process).
let indexesReady: Promise<unknown> | null = null;
const ensureIndexes = (): Promise<unknown> => {
  indexesReady ??= ErrorReport.createIndexes().catch((err) => {
    indexesReady = null; // retry on the next error
    throw err;
  });
  return indexesReady;
};

const recordInDb = async (n: Normalized): Promise<RecordResult> => {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("database not connected");
  }
  await ensureIndexes();
  const now = new Date();

  const bump = () => ({
    $inc: { occurrences: 1 },
    $set: { lastSeenAt: now },
    ...(n.requestId
      ? { $push: { requestIds: { $each: [n.requestId], $slice: -20 } } }
      : {}),
  });

  let doc = await ErrorReport.findOneAndUpdate(
    { openKey: n.fingerprint },
    bump(),
    { new: true },
  );

  if (!doc) {
    const emailable = meetsEmailThreshold(n.severity);
    const capped = !emailable || (await alertBudgetExhausted());
    try {
      doc = await ErrorReport.create({
        reportNumber: await nextReportNumber(),
        source: n.source,
        severity: n.severity,
        status: "new",
        title: n.title,
        message: n.message,
        stack: n.stack,
        context: n.context,
        fingerprint: n.fingerprint,
        openKey: n.fingerprint,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        // Creating the report is what "claims" the first alert.
        ...(capped ? {} : { lastAlertedAt: now, occurrencesAtLastAlert: 1 }),
        requestIds: n.requestId ? [n.requestId] : [],
        reportedBy: n.user?.id,
        reportedByRole: n.user?.role,
      });
      return { report: doc, isNew: true, shouldAlert: !capped };
    } catch (err) {
      // Two requests failed at the same instant; the other one created the
      // report first (unique openKey). Count ours against it instead.
      if ((err as { code?: number }).code !== 11000) throw err;
      doc = await ErrorReport.findOneAndUpdate(
        { openKey: n.fingerprint },
        bump(),
        { new: true },
      );
      if (!doc) throw err;
    }
  }

  // Existing open report. Only an UNACKNOWLEDGED one re-alerts, and only
  // after the cooldown. Acknowledged / investigating / ignored are quiet.
  let shouldAlert = false;
  let sinceLastAlert: number | undefined;
  if (
    doc.status === "new" &&
    meetsEmailThreshold(doc.severity) &&
    !(await alertBudgetExhausted())
  ) {
    const cutoff = new Date(now.getTime() - settings().cooldownMs);
    // Atomic claim: of N concurrent occurrences, exactly one gets the
    // pre-image back and therefore sends the email.
    const claimed = await ErrorReport.findOneAndUpdate(
      {
        _id: doc._id,
        status: "new",
        $or: [
          { lastAlertedAt: { $lte: cutoff } },
          { lastAlertedAt: { $exists: false } },
        ],
      },
      { $set: { lastAlertedAt: now, occurrencesAtLastAlert: doc.occurrences } },
      { new: false },
    );
    if (claimed) {
      shouldAlert = true;
      sinceLastAlert = doc.occurrences - (claimed.occurrencesAtLastAlert ?? 0);
    }
  }
  return { report: doc, isNew: false, shouldAlert, sinceLastAlert };
};

// ── Alerting ─────────────────────────────────────────────────────

const userLabel = async (
  report: IErrorReport,
  fallback?: Normalized["user"],
): Promise<string | undefined> => {
  const id = report.reportedBy ?? fallback?.id;
  if (!id) return undefined;
  const u = await User.findById(id).select("name role department").lean();
  if (!u) return fallback?.role ? `user (${fallback.role})` : undefined;
  return `${u.name} (${u.role}${u.department ? ", " + u.department : ""})`;
};

const dispatchAlert = async (
  rec: RecordResult,
  n: Normalized,
): Promise<void> => {
  const r = rec.report;
  const recipients = await getIctRecipients();
  if (recipients.length === 0) {
    console.warn(
      `[ErrorReport] ${r.reportNumber} captured but nobody to notify: no active supervisor in a Tech department.`,
    );
    return;
  }

  const data: ErrorAlertEmailData = {
    reportId: String(r._id),
    reportNumber: r.reportNumber,
    severity: r.severity,
    source: r.source === "client" ? "client" : "server",
    title: r.title,
    message: r.message,
    stack: r.stack,
    method: r.context?.method,
    route: r.context?.route,
    pageUrl: r.context?.pageUrl,
    statusCode: r.context?.statusCode,
    kind: r.context?.kind,
    userAgent: r.context?.userAgent,
    requestId: n.requestId,
    userLabel: await userLabel(r, n.user),
    occurredAt: new Date(),
    occurrences: r.occurrences,
    sinceLastAlert: rec.sinceLastAlert,
    isRepeat: !rec.isNew,
  };

  if (emailsEnabled()) {
    const results = await Promise.allSettled(
      recipients.map((rc) => sendErrorAlertEmail(rc.email, rc.name, data)),
    );
    const sent = results.filter(
      (x) => x.status === "fulfilled" && x.value === true,
    ).length;
    console.log(
      `[ErrorReport] ${r.reportNumber} alert emailed to ${sent}/${recipients.length} recipient(s)`,
    );
  }

  // In-app notification for the tech supervisors: the main channel.
  await Promise.allSettled(
    recipients
      .filter((rc) => rc.userId)
      .map((rc) =>
        createNotification(
          rc.userId!,
          `${r.severity.toUpperCase()} error ${r.reportNumber}: ${r.title.slice(0, 100)}`,
          "error_report_new",
          { reportId: String(r._id), reportNumber: r.reportNumber },
        ),
      ),
  );
};

// DB is unreachable: we cannot look supervisors up or store anything.
const fallbackSent = new Map<string, number>();
const sendFallbackAlert = async (n: Normalized): Promise<void> => {
  const { extraEmails, cooldownMs } = settings();
  // No database means no workspace to show it in; email is the only channel,
  // and only if it has been switched on.
  if (!emailsEnabled()) {
    console.error("[ErrorReport] Database unavailable — error not stored:", n.title);
    return;
  }
  if (!meetsEmailThreshold(n.severity)) return; // warnings are never emailed
  if (extraEmails.length === 0) {
    console.error(
      "[ErrorReport] Database unavailable and ERROR_ALERT_EMAILS is not set — this error could not be reported:",
      n.title,
    );
    return;
  }
  const last = fallbackSent.get(n.fingerprint) ?? 0;
  if (Date.now() - last < cooldownMs) return;
  fallbackSent.set(n.fingerprint, Date.now());
  if (fallbackSent.size > 200) fallbackSent.clear(); // bounded memory

  const data: ErrorAlertEmailData = {
    reportId: "unsaved",
    reportNumber: "UNSAVED",
    severity: n.severity,
    source: n.source === "client" ? "client" : "server",
    title: n.title,
    message: n.message,
    stack: n.stack,
    method: n.context.method,
    route: n.context.route,
    pageUrl: n.context.pageUrl,
    statusCode: n.context.statusCode,
    kind: n.context.kind,
    userAgent: n.context.userAgent,
    requestId: n.requestId,
    occurredAt: new Date(),
    occurrences: 1,
  };
  await Promise.allSettled(
    extraEmails.map((e) => sendErrorAlertEmail(e, undefined, data)),
  );
};

/**
 * Store an error and, if it is new (or a due re-alert), email the tech
 * supervisor. Resolves when done; never rejects. On Vercel call it via
 * scheduleErrorReport() so the work survives the response being sent.
 */
export const reportError = async (input: ReportErrorInput): Promise<void> => {
  try {
    if (!isReportingEnabled()) return;
    const n = normalize(input);
    let rec: RecordResult | null = null;
    try {
      rec = await withTimeout(recordInDb(n), 5000);
    } catch (dbErr) {
      console.error("[ErrorReport] could not store report:", dbErr);
    }
    if (!rec) {
      await sendFallbackAlert(n);
      return;
    }
    if (rec.shouldAlert) await dispatchAlert(rec, n);
  } catch (err) {
    console.error("[ErrorReport] reportError failed:", err);
  }
};

/**
 * Fire-and-forget that is safe on Vercel: waitUntil keeps the function
 * alive after the response is sent (a plain un-awaited promise would be
 * frozen mid-flight and the alert silently lost).
 */
export const scheduleErrorReport = (input: ReportErrorInput): void => {
  const job = reportError(input);
  try {
    waitUntil(job);
  } catch {
    /* not on Vercel — the promise just runs */
  }
};

// ── Process-level safety net ─────────────────────────────────────

const INSTALLED = Symbol.for("peakinsights.processErrorHandlers");

/**
 * Catches what no try/catch caught: unhandled promise rejections and
 * uncaught exceptions. Off Vercel the process still exits afterwards (as
 * Node would have by default) — but only once the alert has gone out.
 */
export const installProcessErrorHandlers = (): void => {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[INSTALLED] || !isReportingEnabled()) return;
  g[INSTALLED] = true;

  const handle = (kind: string) => (reason: unknown) => {
    console.error(`[${kind}]`, reason);
    const job = reportError({
      source: "server",
      error: reason instanceof Error ? reason : new Error(String(reason)),
      context: { kind },
    });
    if (process.env.VERCEL) {
      try {
        waitUntil(job);
      } catch {
        /* ignore */
      }
      return;
    }
    withTimeout(job, 8000)
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };
  process.on("unhandledRejection", handle("unhandledRejection"));
  process.on("uncaughtException", handle("uncaughtException"));
};

/** Test hook. */
export const _resetFallbackThrottle = (): void => fallbackSent.clear();