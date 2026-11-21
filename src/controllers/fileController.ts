import { Request, Response } from "express";
import { verifyFileToken } from "../utils/fileAccessToken";
import { getSignedFileUrl, headObject } from "../services/s3Storage";

const MISSING_MESSAGE =
  "This file could not be found. It may have been removed or never finished uploading — please ask the person who uploaded it to upload it again.";

/** A small standalone page for the viewer's <iframe> / a new tab, so a missing
 *  file never shows storage-provider XML (which names our AWS account/user).
 *  Static text only — nothing from the request is echoed back. */
const MISSING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>File not available</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background:#0b1220; color:#cbd5e1; }
  main { max-width:420px; padding:24px; text-align:center; }
  h1 { font-size:18px; margin:0 0 8px; color:#f1f5f9; }
  p { font-size:14px; line-height:1.5; margin:0; color:#94a3b8; }
</style></head>
<body><main><h1>This file isn’t available</h1><p>${MISSING_MESSAGE}</p></main></body></html>`;

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

    // Make sure the object is really there before redirecting. A redirect to
    // a missing key makes S3 answer with raw XML. This only runs AFTER the
    // token check, so it can't be used to probe which keys exist.
    // If S3 can't tell us (e.g. the IAM user lacks s3:ListBucket, so a missing
    // key comes back as 403 instead of 404), carry on exactly as before.
    try {
      if ((await headObject(fileKey)) === null) {
        console.warn(`serveFile: object missing in storage for key ${fileKey}`);
        res.setHeader("Cache-Control", "no-store");
        if (req.accepts(["html", "json"]) === "json") {
          res
            .status(404)
            .json({ success: false, code: "FILE_MISSING", message: MISSING_MESSAGE });
        } else {
          res.status(404).type("html").send(MISSING_PAGE);
        }
        return;
      }
    } catch (err) {
      console.warn("serveFile: existence check inconclusive, continuing:", err);
    }

    // Short expiry is fine and intentional — the browser follows the
    // redirect within milliseconds of receiving it, this is never
    // meant to be a link a person holds onto.
    // Optional display name + forced download. These are NOT covered by the
    // HMAC token, which is fine: they only change the Content-Disposition
    // header on a file the token already authorises. The name is stripped
    // of anything that could break out of the header.
    const { name, download } = req.query as {
      name?: string;
      download?: string;
    };
    const safeName = name
      ? name.replace(/[\u0000-\u001f"\\/]/g, "").slice(0, 150) || undefined
      : undefined;

    const s3Url = await getSignedFileUrl(fileKey, {
      expiresInSeconds: 60,
      filename: safeName,
      forceAttachment: download === "1",
    });
    res.redirect(302, s3Url);
  } catch (err) {
    console.error("serveFile error:", err);
    res.status(500).json({ success: false });
  }
};