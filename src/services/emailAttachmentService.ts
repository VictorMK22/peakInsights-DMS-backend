import crypto from "crypto";
import path from "path";
import { v4 as uuid } from "uuid";
import { IEmailAttachment } from "../models/EmailLog";
import {
  uploadBufferToS3,
  downloadFromS3,
  deleteFromS3,
  createDirectUploadPost,
  headObject,
} from "./s3Storage";
import { getLocalFileUrl } from "../middleware/upload";
import { BLOCKED_EXTENSIONS } from "../middleware/emailUpload";

// ═════════════════════════════════════════════════════════════════
// Email attachment helpers
//   • store files uploaded with a composed email (S3)
//   • turn stored attachments back into SMTP attachments (for retry)
//   • present attachments to the frontend with fresh signed URLs
//   • resolve <img src="cid:..."> in synced HTML bodies to real URLs
// ═════════════════════════════════════════════════════════════════

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Uploads in-memory multer files to S3 and returns the metadata to store. */
export async function storeUploadedAttachments(
  files: Express.Multer.File[],
): Promise<IEmailAttachment[]> {
  return Promise.all(
    files.map(async (f) => ({
      fileKey: await uploadBufferToS3(f.buffer, f.originalname, f.mimetype),
      filename: f.originalname,
      mimeType: f.mimetype,
      size: f.size,
    })),
  );
}

/** Buffers ready to hand to nodemailer straight from the multer upload. */
export const toMailAttachments = (
  files: Express.Multer.File[],
): MailAttachment[] =>
  files.map((f) => ({
    filename: f.originalname,
    content: f.buffer,
    contentType: f.mimetype,
  }));

/** Re-downloads stored attachments from S3 (used when retrying a failed send). */
export async function loadMailAttachments(
  attachments: IEmailAttachment[] = [],
): Promise<MailAttachment[]> {
  return Promise.all(
    attachments.map(async (a) => ({
      filename: a.filename,
      content: await downloadFromS3(a.fileKey),
      contentType: a.mimeType,
    })),
  );
}

const normalizeCid = (cid: string) =>
  decodeURIComponent(cid).replace(/^<|>$/g, "").trim().toLowerCase();

const withParams = (base: string, name: string, download: boolean) => {
  const u = new URL(base);
  u.searchParams.set("name", name);
  if (download) u.searchParams.set("download", "1");
  return u.toString();
};

export interface PresentedAttachment {
  _id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  isImage: boolean;
  /** True when the body already displays this file via cid: — the UI hides it from the chip list. */
  inline: boolean;
  /** Opens in the browser when the type is safe to render inline (images, PDF). */
  url: string;
  /** Always forces a download with the real filename. */
  downloadUrl: string;
}

/**
 * Shapes stored attachments for the API. Signed URLs are generated fresh on
 * every read and never persisted (see utils/fileAccessToken.ts).
 */
export function presentAttachments(
  attachments: IEmailAttachment[] = [],
  body = "",
): PresentedAttachment[] {
  const lowerBody = body.toLowerCase();
  return attachments.map((a: any) => {
    const base = getLocalFileUrl(a.fileKey);
    const cid = a.contentId ? normalizeCid(a.contentId) : "";
    return {
      _id: String(a._id),
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      isImage: (a.mimeType ?? "").startsWith("image/"),
      inline: !!cid && lowerBody.includes(`cid:${cid}`),
      url: withParams(base, a.filename, false),
      downloadUrl: withParams(base, a.filename, true),
    };
  });
}

/**
 * Synced HTML emails reference embedded images as <img src="cid:abc123">,
 * which a browser can't load. Swap each one for a fresh signed URL of the
 * matching stored attachment. The stored body is never modified — this runs
 * on the way out only, so URLs can't expire inside saved data.
 */
export function resolveCidImages(
  body: string,
  attachments: IEmailAttachment[] = [],
): string {
  if (!body || !/cid:/i.test(body)) return body;
  const byCid = new Map<string, string>();
  for (const a of attachments as any[]) {
    if (a.contentId) {
      byCid.set(
        normalizeCid(a.contentId),
        withParams(getLocalFileUrl(a.fileKey), a.filename, false),
      );
    }
  }
  if (byCid.size === 0) return body;
  return body.replace(/cid:([^"'\s>)]+)/gi, (match, cid: string) => {
    try {
      return byCid.get(normalizeCid(cid)) ?? match;
    } catch {
      return match;
    }
  });
}

// ═════════════════════════════════════════════════════════════════
// DIRECT-TO-S3 UPLOADS
// The browser uploads straight to S3 with a presigned POST, then sends the
// email with references to what it uploaded. The server never receives the
// file bytes, so Vercel's 4.5 MB body limit doesn't apply.
//
// Security: the client could otherwise name ANY existing S3 key as an
// "attachment" and then read it back through a signed link. So every key we
// hand out is bound to the user and an expiry with an HMAC token, and the
// send step refuses anything without a valid token for that exact user.
// ═════════════════════════════════════════════════════════════════

export const MAX_DIRECT_FILES = 10;
// Zoho/most providers reject messages over ~20 MB, and base64 inflates by a
// third, so the default is 15 MB. Raise/lower with EMAIL_MAX_ATTACHMENT_MB.
export const MAX_DIRECT_TOTAL_BYTES =
  (Number(process.env.EMAIL_MAX_ATTACHMENT_MB) || 15) * 1024 * 1024;

const UPLOAD_SECRET = `${process.env.JWT_SECRET ?? "dev-secret"}:email-upload`;
const UPLOAD_TOKEN_TTL_S = 60 * 60;

const signUpload = (userId: string, fileKey: string, exp: number) =>
  crypto
    .createHmac("sha256", UPLOAD_SECRET)
    .update(`${userId}.${fileKey}.${exp}`)
    .digest("hex");

const validUploadToken = (
  userId: string,
  fileKey: string,
  token: string,
  exp: number,
) => {
  if (!token || !exp || Number.isNaN(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(signUpload(userId, fileKey, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const extOf = (name: string) => path.extname(name).toLowerCase();
const safeExt = (name: string) => {
  const e = extOf(name);
  return /^\.[a-z0-9]{1,10}$/.test(e) ? e : "";
};

export interface UploadRequestFile {
  filename: string;
  mimeType?: string;
  size: number;
}

/** Validates the files a user wants to attach and returns presigned POSTs for them. */
export async function createAttachmentUploads(
  userId: string,
  files: UploadRequestFile[],
) {
  if (!Array.isArray(files) || files.length === 0)
    throw new HttpError(400, "No files to upload");
  if (files.length > MAX_DIRECT_FILES)
    throw new HttpError(
      400,
      `You can attach at most ${MAX_DIRECT_FILES} files`,
    );

  let total = 0;
  for (const f of files) {
    if (
      !f ||
      typeof f.filename !== "string" ||
      !f.filename.trim() ||
      f.filename.length > 255 ||
      !Number.isFinite(f.size) ||
      f.size <= 0
    )
      throw new HttpError(400, "Invalid file description");
    if (BLOCKED_EXTENSIONS.has(extOf(f.filename)))
      throw new HttpError(400, `File type ${extOf(f.filename)} is not allowed`);
    total += f.size;
  }
  if (total > MAX_DIRECT_TOTAL_BYTES)
    throw new HttpError(
      400,
      `Attachments can total at most ${Math.round(MAX_DIRECT_TOTAL_BYTES / 1024 / 1024)} MB`,
    );

  const exp = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_S;
  return Promise.all(
    files.map(async (f) => {
      // Flat key (UUID + extension) — same shape as every other stored file,
      // and files.serveFile rejects keys containing "/".
      const fileKey = `${uuid()}${safeExt(f.filename)}`;
      const contentType = f.mimeType || "application/octet-stream";
      const post = await createDirectUploadPost(
        fileKey,
        contentType,
        MAX_DIRECT_TOTAL_BYTES,
      );
      return {
        filename: f.filename,
        fileKey,
        url: post.url,
        fields: post.fields,
        token: signUpload(userId, fileKey, exp),
        exp,
      };
    }),
  );
}

export interface DirectUploadRef {
  fileKey: string;
  filename: string;
  token: string;
  exp: number;
}

/** Parses the `uploads` field (array, or JSON string from multipart) — no I/O. */
export function parseUploadRefs(raw: unknown): DirectUploadRef[] {
  let v = raw;
  if (typeof v === "string" && v.trim()) {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (r) =>
        r &&
        typeof r.fileKey === "string" &&
        typeof r.filename === "string" &&
        typeof r.token === "string",
    )
    .slice(0, MAX_DIRECT_FILES)
    .map((r) => ({
      fileKey: r.fileKey,
      filename: r.filename,
      token: r.token,
      exp: Number(r.exp),
    }));
}

/** Deletes whatever the user uploaded (only keys whose token is valid for them). */
export async function discardDirectUploads(
  userId: string,
  refs: DirectUploadRef[],
): Promise<void> {
  await Promise.all(
    refs
      .filter((r) => validUploadToken(userId, r.fileKey, r.token, r.exp))
      .map((r) => deleteFromS3(r.fileKey)),
  );
}

/**
 * Turns the references the client sent into trusted attachment records:
 * verifies each token, then asks S3 what is REALLY stored (existence, size,
 * type) rather than believing the client. Any failure deletes the uploads.
 */
export async function resolveDirectUploads(
  userId: string,
  refs: DirectUploadRef[],
): Promise<IEmailAttachment[]> {
  if (refs.length === 0) return [];
  try {
    const out: IEmailAttachment[] = [];
    let total = 0;
    for (const r of refs) {
      if (!validUploadToken(userId, r.fileKey, r.token, r.exp))
        throw new HttpError(400, "Attachment upload is invalid or has expired");
      if (
        BLOCKED_EXTENSIONS.has(extOf(r.filename)) ||
        BLOCKED_EXTENSIONS.has(extOf(r.fileKey))
      )
        throw new HttpError(400, "That file type is not allowed");

      const head = await headObject(r.fileKey);
      if (!head)
        throw new HttpError(400, `"${r.filename}" did not finish uploading`);
      total += head.size;
      out.push({
        fileKey: r.fileKey,
        filename: r.filename.slice(0, 255),
        mimeType: head.contentType,
        size: head.size,
      });
    }
    if (total > MAX_DIRECT_TOTAL_BYTES)
      throw new HttpError(
        400,
        `Attachments can total at most ${Math.round(MAX_DIRECT_TOTAL_BYTES / 1024 / 1024)} MB`,
      );
    return out;
  } catch (err) {
    await discardDirectUploads(userId, refs);
    throw err;
  }
}

// Best-effort per-instance throttle on minting upload URLs.
const presignHits = new Map<string, number[]>();
export function allowPresign(userId: string, max = 20, windowMs = 10 * 60_000) {
  const now = Date.now();
  const hits = (presignHits.get(userId) ?? []).filter(
    (t) => now - t < windowMs,
  );
  if (hits.length >= max) return false;
  hits.push(now);
  presignHits.set(userId, hits);
  return true;
}
