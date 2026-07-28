import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuid } from "uuid";
import path from "path";

// ═════════════════════════════════════════════════════════════════
// S3 FILE STORAGE
// ═════════════════════════════════════════════════════════════════
// Replaces local disk storage (middleware/upload.ts used to write to
// UPLOAD_DIR via multer.diskStorage). Required for Vercel deployment —
// serverless functions have no persistent, shared filesystem, so a
// file written to disk in one invocation may not exist by the time
// the next request needs it.
//
// Required env vars: AWS_REGION, S3_ACCESS_KEY, AWS_SECRET_KEY, S3_BUCKET
// NOTE: the key is named S3_ACCESS_KEY, not AWS_ACCESS_KEY — Vercel
// reserves any env var name starting with AWS_ACCESS_KEY (its own
// infrastructure runs on AWS), so that name is rejected outright when
// added in the Vercel dashboard. AWS_REGION and AWS_SECRET_KEY were
// not on that reserved list and can keep their names.
// ═════════════════════════════════════════════════════════════════

export const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.AWS_SECRET_KEY!,
  },
});

export const BUCKET = process.env.S3_BUCKET!;

export const isS3Configured = () =>
  Boolean(
    process.env.AWS_REGION &&
    process.env.S3_ACCESS_KEY &&
    process.env.AWS_SECRET_KEY &&
    process.env.S3_BUCKET,
  );

/**
 * Uploads a buffer to S3 under a fresh, unguessable key (UUID + the
 * original extension, matching the naming convention the app already
 * used for local disk files, so fileKey values look the same either
 * way). Returns the key to store in Mongo — never the full S3 URL,
 * since access always goes through a fresh short-lived presigned URL
 * generated at read time (see getSignedFileUrl below), not a
 * permanent public link.
 */
export async function uploadBufferToS3(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<string> {
  const ext = path.extname(originalName);
  const key = `${uuid()}${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      // No ACL set — bucket should be fully private. All reads happen
      // exclusively through short-lived presigned URLs (see below).
    }),
  );
  return key;
}

export async function deleteFromS3(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error(`S3 delete failed for key ${key}:`, err);
  }
}

/** Server-side copy within the same bucket — used when duplicating a
 *  document (see folderController.cloneDocumentRecord). Doesn't
 *  download/re-upload the bytes through our own server, S3 copies the
 *  object internally. Returns the new key, or undefined if the source
 *  didn't exist / the copy failed (non-fatal — same "DB row still gets
 *  created without a file" behavior as the old disk-copy version). */
export async function copyObjectInS3(
  sourceKey: string,
): Promise<string | undefined> {
  const ext = path.extname(sourceKey);
  const newKey = `${uuid()}${ext}`;
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${sourceKey}`,
        Key: newKey,
      }),
    );
    return newKey;
  } catch (err) {
    console.error(`S3 copy failed for key ${sourceKey}:`, err);
    return undefined;
  }
}

// Same file types the old fileController allowed to render inline
// (in-browser) rather than forcing a download — everything else
// (.html, .svg, .xml, etc.) still forces a download, which is what
// stops an uploaded file from ever executing as a page on this
// origin. S3presigned URLs support this via ResponseContentDisposition,
// so the security property carries over even without our own proxy
// route in front of the file.
const INLINE_SAFE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
]);

/**
 * Generates a short-lived presigned GET URL for a stored file. This is
 * the direct S3 replacement for the old buildSignedFileUrl() —
 * same "fresh token per access-checked read, expires shortly after"
 * shape, just backed by S3's own presigning instead of a custom HMAC
 * token + our own proxy route.
 */
export async function getSignedFileUrl(
  fileKey: string,
  opts: {
    filename?: string;
    expiresInSeconds?: number;
    forceAttachment?: boolean;
  } = {},
): Promise<string> {
  const ext = path.extname(fileKey).toLowerCase();
  const disposition = opts.forceAttachment
    ? "attachment"
    : INLINE_SAFE_EXTENSIONS.has(ext)
      ? "inline"
      : "attachment";
  const displayName = opts.filename ?? fileKey;

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: fileKey,
    ResponseContentDisposition: `${disposition}; filename="${encodeURIComponent(displayName)}"`,
  });

  return getSignedUrl(s3, command, {
    expiresIn: opts.expiresInSeconds ?? 1800,
  });
}

/** Downloads an object's full contents into memory — used sparingly,
 *  only where a library needs the raw bytes directly (e.g. mammoth's
 *  DOCX→HTML conversion), never for simply serving a file to a browser
 *  (that should always be a presigned URL / redirect instead — see
 *  getSignedFileUrl — so the bytes go straight from S3 to the browser
 *  rather than through our own server). */
export async function downloadFromS3(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const stream = res.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
