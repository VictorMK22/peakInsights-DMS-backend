import crypto from "crypto";

// ═════════════════════════════════════════════════════════════════
// Pure helpers for error reporting. No I/O, so they're unit-testable.
// ═════════════════════════════════════════════════════════════════

// Error messages and stacks end up in a database AND in an email, so
// anything that looks like a credential must be stripped first. Mongoose
// and the AWS/Resend SDKs are all known to echo secrets in messages.
const REDACTIONS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  // mongodb://user:pass@host  →  mongodb://[redacted]@host
  [/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, "$1[redacted]@"],
  // ?token=…  &key=…  &signature=…
  [
    /([?&](?:token|access_token|refresh_token|key|secret|password|code|sig|signature)=)[^&\s"')]+/gi,
    "$1[redacted]",
  ],
  // password: "x"   apiKey=x   authorization: x
  [
    /((?:password|passwd|secret|api[_-]?key|authorization|token)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi,
    "$1[redacted]",
  ],
  [/\bre_[A-Za-z0-9_]{16,}\b/g, "[resend-key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[aws-key]"],
];

/** Redacts credentials and caps length. Safe to call with undefined. */
export const scrub = (text: unknown, max = 2000): string => {
  if (text === undefined || text === null) return "";
  let s = typeof text === "string" ? text : String(text);
  for (const [re, replacement] of REDACTIONS) s = s.replace(re, replacement);
  return s.length > max ? s.slice(0, max) + "…" : s;
};

/** "/api/tasks/65f…/return?token=x" → "/api/tasks/:id/return" */
export const normalizePath = (urlOrPath: string | undefined): string => {
  if (!urlOrPath) return "";
  const pathOnly = urlOrPath.split("?")[0].split("#")[0];
  return (
    pathOnly
      .split("/")
      .map((seg) =>
        /^[0-9a-f]{24}$/i.test(seg) || // Mongo ObjectId
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          seg,
        ) || // UUID
        /^\d+$/.test(seg) || // numeric id
        /^[A-Za-z0-9_-]{20,}$/.test(seg) // opaque token (share links etc.)
          ? ":id"
          : seg,
      )
      .join("/")
      .slice(0, 300) || "/"
  );
};

/** Removes the volatile parts of a message so "same bug" hashes the same. */
export const normalizeMessage = (message: string): string =>
  message
    .replace(/[0-9a-f]{24}/gi, "<id>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/**
 * First stack frame that belongs to OUR code (not node_modules / node:internal),
 * with line:col and the deploy-specific path prefix removed so the same
 * bug keeps the same fingerprint across deploys.
 */
export const topAppFrame = (stack: string | undefined): string => {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("at ")) continue;
    if (t.includes("node_modules") || t.includes("node:internal")) continue;
    const frame = t
      .replace(/^at\s+/, "")
      .replace(/:\d+:\d+\)?$/, "")
      .replace(/^.*?((?:\/|\\)(?:src|api|dist)(?:\/|\\))/, "$1");
    return frame.slice(0, 200);
  }
  return "";
};

export const fingerprintOf = (parts: (string | undefined)[]): string =>
  crypto
    .createHash("sha1")
    .update(parts.map((p) => p ?? "").join("|"))
    .digest("hex");

// ── Is this the CLIENT's fault rather than ours? ────────────────
// Several handlers in this codebase turn *any* thrown error into a 500,
// including things like "that file type isn't allowed" or "you sent a
// malformed id". Alerting the tech supervisor about those would train
// them to ignore the alerts, so they're excluded from auto-reporting.
const CLIENT_FAULT_NAMES = new Set([
  "MulterError",
  "CastError",
  "ValidationError",
  "JsonWebTokenError",
  "TokenExpiredError",
  "NotBeforeError",
]);

export const isClientFaultError = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: string;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  if (e.name && CLIENT_FAULT_NAMES.has(e.name)) return true;
  if (e.code === 11000) return true; // duplicate key — e.g. email already used
  const status = Number(e.statusCode ?? e.status);
  if (Number.isFinite(status) && status >= 400 && status < 500) return true;
  if (typeof e.type === "string" && e.type.startsWith("entity.")) return true; // body-parser
  return false;
};

// ── Image sniffing ──────────────────────────────────────────────
// Screenshots are stored in S3 and served back to other people, so the
// real bytes are checked rather than trusting the filename or the
// Content-Type the browser claimed.
export interface SniffedImage {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  ext: "png" | "jpg" | "gif" | "webp";
}

export const sniffImage = (buf: Buffer): SniffedImage | null => {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return { mime: "image/png", ext: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  const head6 = buf.subarray(0, 6).toString("ascii");
  if (head6 === "GIF87a" || head6 === "GIF89a")
    return { mime: "image/gif", ext: "gif" };
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  return null;
};

export const parseEmailList = (raw: string | undefined): string[] =>
  Array.from(
    new Set(
      (raw ?? "")
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
    ),
  );