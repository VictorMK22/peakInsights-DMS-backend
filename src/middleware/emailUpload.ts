import multer from "multer";
import path from "path";
import { Request, Response, NextFunction } from "express";

// ═════════════════════════════════════════════════════════════════
// Email attachment parsing
// ═════════════════════════════════════════════════════════════════
// Parses multipart/form-data into memory ONLY — nothing is uploaded to S3
// here. The controller uploads after it has validated the request (role,
// recipients, body…) so a rejected email never leaves orphan files in the
// bucket. JSON (non-multipart) requests pass straight through untouched,
// so existing clients that send plain JSON keep working.
//
// Size cap: Vercel serverless functions reject request bodies over 4.5 MB
// before our code even runs, so the limits below are deliberately under
// that. (Larger files would need direct-to-S3 presigned uploads.)
// ═════════════════════════════════════════════════════════════════

export const MAX_EMAIL_FILES = 10;
export const MAX_EMAIL_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MB across all files

export const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".sh",
  ".cmd",
  ".ps1",
  ".msi",
  ".com",
  ".scr",
  ".vbs",
  ".jar",
  ".dll",
]);

const parser = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      cb(new Error(`File type ${ext} is not allowed`));
    } else {
      cb(null, true);
    }
  },
  limits: {
    fileSize: MAX_EMAIL_TOTAL_BYTES,
    files: MAX_EMAIL_FILES,
  },
}).array("attachments", MAX_EMAIL_FILES);

export const emailUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  parser(req, res, (err: unknown) => {
    if (err) {
      let message = err instanceof Error ? err.message : "Upload failed";
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE")
          message = "Attachments are too large (4 MB total limit)";
        else if (err.code === "LIMIT_FILE_COUNT")
          message = `You can attach at most ${MAX_EMAIL_FILES} files`;
        else if (err.code === "LIMIT_UNEXPECTED_FILE")
          message = "Unexpected file field — use 'attachments'";
      }
      res.status(400).json({ success: false, message });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const total = files.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_EMAIL_TOTAL_BYTES) {
      res.status(400).json({
        success: false,
        message: "Attachments are too large (4 MB total limit)",
      });
      return;
    }
    next();
  });
};
