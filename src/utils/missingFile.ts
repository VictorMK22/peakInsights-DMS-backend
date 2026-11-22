import { Request, Response } from "express";
import { headObject } from "../services/s3Storage";

export const MISSING_MESSAGE =
  "This file could not be found. It may have been removed or never finished uploading. Please let the person who shared it know so they can upload it again.";

/** A small standalone page for an <iframe> / a browser tab, so a missing file
 *  never shows storage-provider XML (which names our AWS account and IAM user).
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
 * Call right before redirecting to a presigned S3 URL (and after the caller's
 * own access checks). Returns true when it is fine to carry on. Returns false
 * after answering 404 itself because the object is not in storage — an HTML
 * page for browsers, JSON for API clients (Accept: application/json).
 *
 * If S3 can't tell us either way (e.g. the IAM user lacks s3:ListBucket, so a
 * missing key comes back as 403 rather than 404) it returns true, i.e. behaves
 * exactly as before the check existed.
 */
export async function ensureStoredFile(
  req: Request,
  res: Response,
  fileKey: string,
): Promise<boolean> {
  try {
    if ((await headObject(fileKey)) !== null) return true;
  } catch (err) {
    console.warn("ensureStoredFile: existence check inconclusive, continuing:", err);
    return true;
  }
  console.warn(`Object missing in storage for key ${fileKey}`);
  res.setHeader("Cache-Control", "no-store");
  if (req.accepts(["html", "json"]) === "json") {
    res
      .status(404)
      .json({ success: false, code: "FILE_MISSING", message: MISSING_MESSAGE });
  } else {
    res.status(404).type("html").send(MISSING_PAGE);
  }
  return false;
}