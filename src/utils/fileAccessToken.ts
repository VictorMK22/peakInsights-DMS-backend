import crypto from "crypto";

// Derived from JWT_SECRET rather than requiring a brand-new env var —
// distinct purpose (HMAC for file URLs, not JWT signing) via the suffix.
const SECRET = `${process.env.JWT_SECRET ?? "dev-secret"}:file-access`;

/**
 * Signed, short-lived tokens for serving uploaded files.
 *
 * Files live on local disk (no S3, by design) and were previously
 * served by a public `express.static` mount with NO authentication or
 * access check at all — anyone who ever saw a file's URL (it's
 * embedded directly in normal API responses) had permanent,
 * unrevocable access to it, completely bypassing every access-control
 * rule elsewhere in the app.
 *
 * Now, every time an authenticated request that has already passed a
 * real access check (canAccess/canModify/etc.) returns a file URL, it
 * generates a FRESH token here rather than reusing whatever was
 * stored at upload time. The token is never persisted — it can't
 * outlive the specific access check that produced it, and it expires
 * on its own shortly after regardless.
 */
const sign = (fileKey: string, exp: number): string =>
  crypto.createHmac("sha256", SECRET).update(`${fileKey}.${exp}`).digest("hex");

export const verifyFileToken = (
  fileKey: string,
  token: string,
  exp: number,
): boolean => {
  if (!token || !exp || Number.isNaN(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false; // expired

  const expected = sign(fileKey, exp);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** Builds a fully-qualified, short-lived URL for a single stored file. */
export const buildSignedFileUrl = (
  fileKey: string,
  expiresInSeconds = 1800,
): string => {
  const base = process.env.BACKEND_URL ?? "http://localhost:5000";
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const token = sign(fileKey, exp);
  return `${base}/api/files/${encodeURIComponent(fileKey)}?token=${token}&exp=${exp}`;
};
