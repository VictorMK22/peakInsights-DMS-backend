import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "../types/auth";
import {
  isReportingEnabled,
  scheduleErrorReport,
} from "../services/errorReportService";
import { normalizePath, scrub } from "../utils/errorScrub";

// ═════════════════════════════════════════════════════════════════
// Why this exists
//
// ~77 handlers in this codebase catch an error, console.error() it and
// answer `res.status(500).json(...)` themselves — they never call
// next(err), so Express's errorHandler never sees them. Hooking only the
// error handler would miss most server errors.
//
// So every request gets:
//   • a short request id (header X-Request-Id), so a person who hits an
//     error can quote it and support can find the matching report;
//   • a hook on res.send: whatever the code path, if a 5xx response is
//     about to go out it is reported;
//   • best-effort capture of the Error that was console.error()'d during
//     the request, so those swallowed errors still carry a stack trace.
// ═════════════════════════════════════════════════════════════════

interface Store {
  requestId: string;
  errors: Error[];
}
const als = new AsyncLocalStorage<Store>();

/** res.locals flag: this response has already been reported. */
export const REPORTED = "__errorReported";

let consolePatched = false;
/** Remembers Error objects passed to console.error during a request. */
export const installConsoleErrorCapture = (): void => {
  if (consolePatched) return;
  consolePatched = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const store = als.getStore();
    if (store && store.errors.length < 5) {
      for (const a of args) if (a instanceof Error) store.errors.push(a);
    }
    original(...args);
  };
};

const lastCapturedError = (): Error | undefined => {
  const errs = als.getStore()?.errors;
  return errs && errs.length ? errs[errs.length - 1] : undefined;
};

/** Everything we record about a failing request. Never includes the body. */
export const describeRequest = (req: Request, statusCode: number) => {
  const u = (req as AuthRequest).user;
  return {
    context: {
      method: req.method,
      route: normalizePath(req.originalUrl),
      // Query strings can carry ?token=…, so they are dropped entirely.
      path: scrub((req.originalUrl ?? "").split("?")[0], 300),
      statusCode,
      userAgent: scrub(req.get("user-agent"), 300),
    },
    user: u ? { id: u.userId, role: u.role, email: u.email } : undefined,
  };
};

const messageFromBody = (body: unknown): string | undefined => {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    const m = (parsed as { message?: unknown } | null)?.message;
    return typeof m === "string" ? m : undefined;
  } catch {
    return undefined;
  }
};

export const requestContext = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = crypto.randomBytes(4).toString("hex");
  res.locals["requestId"] = requestId;
  res.setHeader("X-Request-Id", requestId);

  if (isReportingEnabled()) {
    const originalSend = res.send;
    res.send = function patchedSend(this: Response, body?: unknown) {
      if (this.statusCode >= 500 && !this.locals[REPORTED]) {
        this.locals[REPORTED] = true;
        try {
          const captured = lastCapturedError();
          const bodyMessage = messageFromBody(body);
          const { context, user } = describeRequest(req, this.statusCode);
          scheduleErrorReport({
            source: "server",
            error: captured,
            title: `${req.method} ${context.route} responded ${this.statusCode}${
              captured?.message || bodyMessage
                ? ": " + (captured?.message ?? bodyMessage)
                : ""
            }`,
            message: captured
              ? undefined
              : `Handler returned HTTP ${this.statusCode}${bodyMessage ? ` — "${bodyMessage}"` : ""} without throwing to the error handler.`,
            context,
            requestId,
            user,
          });
        } catch {
          /* reporting must never break the response */
        }
      }
      return originalSend.call(this, body as never);
    } as Response["send"];
  }

  als.run({ requestId, errors: [] }, next);
};