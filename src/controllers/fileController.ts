import { Request, Response } from "express";
import { verifyFileToken } from "../utils/fileAccessToken";
import { getSignedFileUrl } from "../services/s3Storage";

/**
 * GET /api/files/:fileKey?token=...&exp=...
 *
 * PUBLIC route (no `authenticate` middleware) — but every request
 * still requires a valid, signed, non-expired token. The token is
 * generated fresh by the API on every authenticated, access-checked
 * read (see documentController/taskController/clientController etc,
 * via getLocalFileUrl / buildSignedFileUrl) — it is short-lived and
 * tied to one specific file.
 *
 * Files themselves live in S3, not on this server. Once the token is
 * verified, this generates a fresh, very short-lived S3 presigned URL
 * and redirects the browser straight to it — the actual file bytes
 * are served directly by S3, never proxied through this backend. That
 * matters specifically on Vercel: proxying file bytes through a
 * serverless function would count against its bandwidth quota and its
 * per-invocation execution-time limit; a redirect response is just a
 * few bytes of headers regardless of how large the underlying file is.
 */
export const serveFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { fileKey } = req.params;
    const { token, exp } = req.query as { token?: string; exp?: string };

    // fileKey is always a server-generated UUID + extension (see
    // middleware/upload.ts) — reject anything that could be a path
    // traversal attempt before it's used to build an S3 key.
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

    // Short expiry is fine and intentional — the browser follows the
    // redirect within milliseconds of receiving it, this is never
    // meant to be a link a person holds onto.
    const s3Url = await getSignedFileUrl(fileKey, { expiresInSeconds: 60 });
    res.redirect(302, s3Url);
  } catch (err) {
    console.error("serveFile error:", err);
    res.status(500).json({ success: false });
  }
};
