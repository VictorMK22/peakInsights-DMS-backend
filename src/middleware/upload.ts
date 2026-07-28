import multer from "multer";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { uploadBufferToS3 } from "../services/s3Storage";

// ═════════════════════════════════════════════════════════════════
// Files are buffered in memory (never written to local disk) and
// uploaded straight to S3. This is required for Vercel — serverless
// functions don't have a persistent, shared filesystem, so anything
// written to disk in one invocation may simply not exist by the time
// the next request needs it.
//
// The exported name `uploadToLocal` is kept as-is (rather than
// renaming to `uploadToS3`) so none of the three route files that
// import it needed to change — only what happens inside changed.
// ═════════════════════════════════════════════════════════════════

const memoryStorage = multer.memoryStorage();

// ─── FILE FILTER ──────────────────────────────────────────────────
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  // Block known dangerous executables — allow everything else
  const blocked = [".exe", ".bat", ".sh", ".cmd", ".ps1", ".msi"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (blocked.includes(ext)) {
    cb(new Error(`File type ${ext} is not allowed`));
  } else {
    cb(null, true);
  }
};

const multerUpload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB per file
    files: 200, // max 200 files per request (folder uploads)
  },
});

/**
 * Runs AFTER multer has parsed the request into in-memory buffers.
 * Uploads each buffer to S3 and rewrites `file.filename` to be the
 * resulting S3 key — every controller in this codebase already reads
 * `file.filename` as "the fileKey to store in Mongo", so this keeps
 * every one of them working completely unchanged.
 */
async function uploadBuffersToS3(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const files: Express.Multer.File[] = req.files
      ? Array.isArray(req.files)
        ? req.files
        : Object.values(req.files).flat()
      : req.file
        ? [req.file]
        : [];

    await Promise.all(
      files.map(async (file) => {
        const key = await uploadBufferToS3(
          file.buffer,
          file.originalname,
          file.mimetype,
        );
        // multer's type doesn't include `filename` for memoryStorage
        // (it only exists for diskStorage) — we add it back here so
        // every existing `file.filename` read downstream keeps working.
        (file as Express.Multer.File & { filename: string }).filename = key;
      }),
    );
    next();
  } catch (err) {
    next(err);
  }
}

// ─── MAIN UPLOAD MIDDLEWARE ───────────────────────────────────────
// Same shape as before (`uploadToLocal.any()` / `.single(field)`),
// just backed by S3 now. Each returns an array of two middleware —
// Express treats an array passed as a route argument as a chain, so
// no call site (`router.post(..., uploadToLocal.any(), handler)`)
// needed to change.
export const uploadToLocal = {
  any: () => [multerUpload.any(), uploadBuffersToS3],
  single: (fieldName: string) => [
    multerUpload.single(fieldName),
    uploadBuffersToS3,
  ],
};

// ─── SIGNED FILE URL ───────────────────────────────────────────────
// UNCHANGED from the local-disk version — still builds a URL to our
// own `/api/files/:fileKey?token=...&exp=...` route, still signed with
// the same short-lived HMAC token (see utils/fileAccessToken.ts). The
// only thing that changed is what that route does once a request
// actually reaches it: instead of streaming a local file, it verifies
// this same token and then redirects to a freshly-generated S3
// presigned URL (see controllers/fileController.ts). Keeping this
// synchronous and unchanged means none of the many places across the
// app that build a file URL needed to change at all.
export { buildSignedFileUrl as getLocalFileUrl } from "../utils/fileAccessToken";
