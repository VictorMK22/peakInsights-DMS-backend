import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuid } from "uuid";
import { Request } from "express";

const UPLOAD_DIR = path.resolve(__dirname, "../../uploads");

// Ensure the uploads directory exists at startup
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── DISK STORAGE ─────────────────────────────────────────────────
// Files are stored locally. The filename is a UUID to avoid collisions.
// The original filename is preserved in file.originalname for display.
// webkitRelativePath is forwarded from the request body so folder
// structure can be reconstructed in the document controller.
const storage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req: Request, file: Express.Multer.File, cb) => {
    // Keep the extension so MIME detection works; UUID prefix avoids collisions
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

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

// ─── MAIN UPLOAD MIDDLEWARE ───────────────────────────────────────
// Use .any() so multer accepts any field name and any number of files.
// This supports:
//   • Single file upload   (field name "file")
//   • Multiple files       (field name "files[]" or "files")
//   • Folder uploads       (many files from webkitdirectory, any field name)
// The document controller reads req.files (array) and uses
// file.originalname + body.webkitRelativePath[i] to rebuild structure.
export const uploadToLocal = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB per file
    files: 200, // max 200 files per request (folder uploads)
  },
});

// ─── SERVE A LOCAL FILE URL ───────────────────────────────────────
// Builds a short-lived, signed URL for a file (see utils/fileAccessToken.ts).
// Files are no longer served by a public express.static mount — every
// load requires this kind of token, generated fresh at read time by
// an endpoint that has already run a real access check. The value
// computed here, right at upload time, is really just a starting
// point; documentController re-signs a fresh one on every subsequent
// read (see attachSignedUrls), since this one will expire quickly.
export { buildSignedFileUrl as getLocalFileUrl } from "../utils/fileAccessToken";
