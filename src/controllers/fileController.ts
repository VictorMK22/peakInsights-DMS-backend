import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import mimeTypes from "mime-types";
import { verifyFileToken } from "../utils/fileAccessToken";

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, "../../uploads");

// Anything NOT in this set gets forced to download (Content-Disposition:
// attachment) rather than rendered inline. This is what stops an
// uploaded .html/.svg/.xml file from executing as a page in this
// origin — a classic stored-XSS vector for file-upload features that
// the previous implementation had no defense against at all.
const INLINE_SAFE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
]);

/**
 * GET /api/files/:fileKey?token=...&exp=...
 *
 * PUBLIC route (no `authenticate` middleware) — but every request
 * still requires a valid, signed, non-expired token. This replaces
 * the old public `express.static('/uploads', ...)` mount, which
 * served every uploaded file to anyone who knew its UUID filename,
 * forever, with zero access control.
 *
 * The token is generated fresh by the API on every authenticated,
 * access-checked read (see documentController/taskController) — it
 * is short-lived and tied to one specific file.
 */
export const serveFile = (req: Request, res: Response): void => {
  try {
    const { fileKey } = req.params;
    const { token, exp } = req.query as { token?: string; exp?: string };

    // fileKey is always a server-generated UUID + extension (see
    // middleware/upload.ts) — reject anything that could be a path
    // traversal attempt before it ever touches the filesystem.
    if (
      !fileKey ||
      fileKey.includes("/") ||
      fileKey.includes("\\") ||
      fileKey.includes("..")
    ) {
      res
        .status(400)
        .json({ success: false, message: "Invalid file reference" });
      return;
    }

    if (!verifyFileToken(fileKey, token ?? "", Number(exp))) {
      res
        .status(403)
        .json({ success: false, message: "Invalid or expired file link" });
      return;
    }

    const filePath = path.join(UPLOAD_DIR, fileKey);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: "File not found" });
      return;
    }

    const ext = path.extname(fileKey).toLowerCase();
    const mimeType = mimeTypes.lookup(ext) || "application/octet-stream";
    const disposition = INLINE_SAFE_EXTENSIONS.has(ext)
      ? "inline"
      : "attachment";

    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(fileKey)}"`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("serveFile error:", err);
    res.status(500).json({ success: false });
  }
};
