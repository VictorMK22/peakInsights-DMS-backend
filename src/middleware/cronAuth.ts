import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Protects endpoints meant to be triggered by an external scheduler
 * (cron-job.org, a GitHub Actions workflow, etc.) rather than a
 * logged-in user — used instead of the normal `authenticate` JWT
 * middleware, since a scheduler has no user session.
 *
 * Requires the caller to send:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Set CRON_SECRET to a long random string (e.g. `openssl rand -hex 32`)
 * and configure your scheduler to send that exact header — see the
 * setup guide for cron-job.org / GitHub Actions specifics.
 */
export function requireCronSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).json({
      success: false,
      message: "CRON_SECRET is not configured on the server",
    });
    return;
  }

  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    res.status(401).json({ success: false, message: "Invalid cron secret" });
    return;
  }

  next();
}
