import crypto from "crypto";
import path from "path";
import mongoose from "mongoose";
import { v4 as uuid } from "uuid";
import { waitUntil } from "@vercel/functions";
import type { Request, Response, NextFunction } from "express";
import {
  createDirectUploadPost,
  headObject,
  downloadFromS3,
  readObjectRange,
  deleteFromS3,
} from "./s3Storage";
import { PendingUpload } from "../models/PendingUpload";
import { DocumentModel } from "../models/Document";
import { TaskModel } from "../models/Task";
import { Ticket } from "../models/Ticket";
import { Asset } from "../models/Asset";
import { Deployment } from "../models/Deployment";
import { classifyForIndexing } from "../utils/extractTextContent";

// ═════════════════════════════════════════════════════════════════
// DIRECT-TO-S3 UPLOADS (no size limit)
//
// Vercel rejects any request body over 4.5 MB before our code runs, so the
// only way to accept bigger files is to keep the bytes off the API entirely:
//   1. POST /documents/uploads/presign  → we hand back presigned S3 POSTs
//   2. the browser uploads each file straight to S3
//   3. the create / replace / attach request carries `uploads` (refs) instead
//      of file bytes; resolveDirectUploads turns them into the same
//      `req.file(s)` shape multer produces, so controllers work unchanged.
//
// Security: a client could otherwise claim ANY existing S3 key as its own
// upload, so every key is bound to the user + an expiry with an HMAC token.
//
// Orphans: every presigned key is recorded in PendingUpload; sweepOrphanUploads
// (cron) deletes the ones nothing ever claimed.
// ═════════════════════════════════════════════════════════════════

const BLOCKED = new Set([".exe", ".bat", ".sh", ".cmd", ".ps1", ".msi"]);
const MB = 1024 * 1024;

// S3's hard cap for a single presigned POST is 5 GB — the only ceiling left,
// and it's S3's, not ours.
const S3_SINGLE_POST_MAX = 5 * 1024 * 1024 * 1024;

const envMb = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * MB;
};

/** Up to this size, text is extracted during the upload request itself. */
export const EXTRACT_MAX_BYTES = envMb("DOC_EXTRACT_INLINE_MB", 25);
/** Big plain-text files: only the first part is read and indexed. */
export const TEXT_RANGE_BYTES = envMb("DOC_TEXT_RANGE_MB", 5);
/** Biggest .docx/.pptx the background indexer will load into memory. */
export const DEEP_INDEX_MAX_BYTES = envMb("DOC_INDEX_MAX_MB", 100);
/** Spreadsheets inflate the most when parsed, so they get a lower ceiling. */
export const DEEP_INDEX_MAX_SPREADSHEET_BYTES = Math.min(
  DEEP_INDEX_MAX_BYTES,
  envMb("DOC_INDEX_MAX_SPREADSHEET_MB", 40),
);

const SECRET = `${process.env.JWT_SECRET ?? "dev-secret"}:document-upload`;
const TOKEN_TTL_S = 60 * 60;

const sign = (userId: string, fileKey: string, exp: number) =>
  crypto.createHmac("sha256", SECRET).update(`${userId}.${fileKey}.${exp}`).digest("hex");

const validToken = (userId: string, fileKey: string, token: string, exp: number) => {
  if (!token || !exp || Number.isNaN(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(sign(userId, fileKey, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const extOf = (name: string) => path.extname(name).toLowerCase();
const safeExt = (name: string) => {
  const e = extOf(name);
  return /^\.[a-z0-9]{1,10}$/.test(e) ? e : "";
};

export interface PresignRequestFile {
  filename: string;
  mimeType?: string;
  size: number;
}

export interface DirectUploadRef {
  fileKey: string;
  filename: string;
  mimeType: string;
  token: string;
  exp: number;
}

/** POST /documents/uploads/presign  { files: [{ filename, mimeType, size }] } */
export const presignDocumentUploads = async (
  req: Request & { user?: { userId: string } },
  res: Response,
  next: NextFunction,
) => {
  try {
    const files = req.body?.files as PresignRequestFile[] | undefined;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, message: "No files to upload" });
    }
    if (files.length > 100) {
      return res.status(400).json({ success: false, message: "Presign at most 100 files per call" });
    }
    for (const f of files) {
      if (
        !f ||
        typeof f.filename !== "string" ||
        !f.filename.trim() ||
        f.filename.length > 255 ||
        !Number.isFinite(f.size) ||
        f.size <= 0 ||
        f.size > S3_SINGLE_POST_MAX
      ) {
        return res.status(400).json({ success: false, message: "Invalid file description" });
      }
      if (BLOCKED.has(extOf(f.filename))) {
        return res
          .status(400)
          .json({ success: false, message: `File type ${extOf(f.filename)} is not allowed` });
      }
    }

    const userId = req.user!.userId;
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
    const uploads = await Promise.all(
      files.map(async (f) => {
        const fileKey = `${uuid()}${safeExt(f.filename)}`;
        const mimeType = f.mimeType || "application/octet-stream";
        const post = await createDirectUploadPost(fileKey, mimeType, S3_SINGLE_POST_MAX, TOKEN_TTL_S);
        return {
          filename: f.filename,
          mimeType,
          fileKey,
          url: post.url,
          fields: post.fields,
          token: sign(userId, fileKey, exp),
          exp,
        };
      }),
    );

    // Ledger for the orphan sweep. Best-effort: a failure here must not block
    // the upload, it only means that one key can't be auto-cleaned.
    await PendingUpload.insertMany(
      uploads.map((u) => ({
        fileKey: u.fileKey,
        userId: new mongoose.Types.ObjectId(userId),
        filename: u.filename,
      })),
      { ordered: false },
    ).catch((err) => console.error("PendingUpload insert failed (non-fatal):", err));

    return res.json({ success: true, data: { uploads } });
  } catch (err) {
    return next(err);
  }
};

function parseRefs(raw: unknown): DirectUploadRef[] {
  let v = raw;
  if (typeof v === "string" && v.trim()) {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is DirectUploadRef =>
      r &&
      typeof r.fileKey === "string" &&
      typeof r.filename === "string" &&
      typeof r.token === "string" &&
      Number.isFinite(Number(r.exp)),
  );
}

export type IndexState = "pending" | "indexed" | "skipped";

/**
 * Decides, from size and type alone, how a big file gets searchable:
 *   • small enough                      → extracted inline (returns undefined)
 *   • big text file                     → first TEXT_RANGE_BYTES read now
 *   • big .docx/.pptx/.xlsx within caps → "pending": background indexer
 *   • anything else                     → "skipped" (stored, just not searchable)
 */
const planIndexing = (
  size: number,
  mimeType: string,
  filename: string,
): { state?: IndexState; readRange?: boolean } => {
  if (size <= EXTRACT_MAX_BYTES) return {};
  const kind = classifyForIndexing(mimeType, filename);
  if (kind === "text") return { state: "indexed", readRange: true };
  if (kind === "office" && size <= DEEP_INDEX_MAX_BYTES) return { state: "pending" };
  if (kind === "spreadsheet" && size <= DEEP_INDEX_MAX_SPREADSHEET_BYTES)
    return { state: "pending" };
  return { state: "skipped" };
};

export interface ResolveOptions {
  /**
   * true  → the document flows: fetch the bytes of small files so text
   *         extraction still runs, and work out an index plan for big ones.
   * false → plain attachments (tasks, tickets, assets…): nothing reads the
   *         bytes, so none are fetched. This is the default.
   */
  withBuffer?: boolean;
}

/**
 * Runs where multer's middleware used to. If the request carries `uploads`
 * (refs from the presign step) it verifies each one and fills `req.files` and
 * `req.file` with multer-shaped entries. Requests without `uploads` (classic
 * multipart, or no files at all) pass straight through.
 */
export const resolveDirectUploads =
  ({ withBuffer = false }: ResolveOptions = {}) =>
  async (
    req: Request & { user?: { userId: string } },
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (req.body?.uploads === undefined) return next();
      const refs = parseRefs(req.body.uploads);
      if (refs.length === 0) {
        return res.status(400).json({ success: false, message: "No files uploaded" });
      }
      const userId = req.user!.userId;
      const bad = (message: string) =>
        Object.assign(new Error(message), { statusCode: 400 });

      const files = await Promise.all(
        refs.map(async (r) => {
          if (r.fileKey.includes("/") || !validToken(userId, r.fileKey, r.token, Number(r.exp))) {
            throw bad("Upload reference is invalid or has expired");
          }
          if (BLOCKED.has(extOf(r.filename))) {
            throw bad(`File type ${extOf(r.filename)} is not allowed`);
          }
          const head = await headObject(r.fileKey);
          if (!head) throw bad(`"${r.filename}" did not finish uploading`);

          const mimetype = r.mimeType || head.contentType || "application/octet-stream";
          let buffer: Buffer = Buffer.alloc(0);
          let indexState: IndexState | undefined;
          let skipProcessing = false;

          if (withBuffer) {
            const plan = planIndexing(head.size, mimetype, r.filename);
            if (!plan.state) {
              buffer = await downloadFromS3(r.fileKey);
            } else {
              indexState = plan.state;
              skipProcessing = true; // never run the whole-file inline path
              if (plan.readRange) {
                buffer = await readObjectRange(r.fileKey, 0, TEXT_RANGE_BYTES - 1);
              }
            }
          }

          return {
            fieldname: "files",
            originalname: r.filename,
            encoding: "7bit",
            mimetype,
            size: head.size,
            buffer,
            filename: r.fileKey, // controllers read this as "the stored key"
            skipProcessing,
            indexState,
          };
        }),
      );

      const keys = files.map((f) => f.filename);
      await PendingUpload.updateMany(
        { fileKey: { $in: keys } },
        { $set: { claimedAt: new Date() } },
      ).catch(() => undefined);

      // If this request ends in an error, nothing (or not everything) was
      // saved — hand the keys back to the orphan sweep, which re-checks that
      // nothing references them before deleting.
      res.on("finish", () => {
        if (res.statusCode >= 400) {
          waitUntil(
            PendingUpload.updateMany(
              { fileKey: { $in: keys } },
              { $set: { claimedAt: null } },
            ).catch(() => undefined),
          );
        }
      });

      (req as any).files = files;
      (req as any).file = files[0];
      next();
    } catch (err: any) {
      if (err?.statusCode === 400) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next(err);
    }
  };

/** For document create/replace: bytes + index planning. */
export const resolveDocumentUploads = resolveDirectUploads({ withBuffer: true });
/** For task / ticket / asset / deployment attachments: refs only. */
export const resolveAttachmentUploads = resolveDirectUploads();

// ─── ORPHAN SWEEP ─────────────────────────────────────────────────

/** Is this S3 key still referenced by any record that stores file keys? */
const isKeyReferenced = async (key: string): Promise<boolean> => {
  const checks = await Promise.all([
    DocumentModel.exists({ fileKey: key }),
    TaskModel.exists({ "taskFiles.fileKey": key }),
    Ticket.exists({ "attachments.fileKey": key }),
    Asset.exists({ "attachments.fileKey": key }),
    Deployment.exists({ "attachments.fileKey": key }),
  ]);
  return checks.some(Boolean);
};

/**
 * Deletes S3 objects that were presigned but never attached to anything.
 * A key is only deleted when ALL of these hold:
 *   • its ledger row is unclaimed (never used, or the request that used it failed)
 *   • the row is older than the presign's validity + a safety margin (2 h)
 *   • no document / task / ticket / asset / deployment references it
 * Claimed rows older than 14 days are just ledger housekeeping.
 */
export async function sweepOrphanUploads(limit = 200): Promise<{
  examined: number;
  deleted: number;
  keptReferenced: number;
}> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stale = await PendingUpload.find({
    claimedAt: null,
    createdAt: { $lt: cutoff },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  let deleted = 0;
  let keptReferenced = 0;
  for (const row of stale) {
    if (await isKeyReferenced(row.fileKey)) {
      // It was in use after all (e.g. a partially-failed batch) — keep the
      // object and mark the row claimed so it isn't examined again.
      keptReferenced++;
      await PendingUpload.updateOne({ _id: row._id }, { $set: { claimedAt: new Date() } });
      continue;
    }
    await deleteFromS3(row.fileKey); // logs instead of throwing; fine if absent
    await PendingUpload.deleteOne({ _id: row._id });
    deleted++;
  }

  await PendingUpload.deleteMany({
    claimedAt: { $lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
  });

  return { examined: stale.length, deleted, keptReferenced };
}