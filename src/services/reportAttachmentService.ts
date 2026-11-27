import crypto from "crypto";
import path from "path";
import { v4 as uuid } from "uuid";
import {
  createDirectUploadPost,
  headObject,
  readObjectRange,
  deleteFromS3,
} from "./s3Storage";

// ═════════════════════════════════════════════════════════════════
// File uploads for the report workflow (direct browser → S3, so files can
// exceed Vercel's 4.5 MB request cap).
//
//   • "final"      — the approved documents that go to the client.
//                    PDF ONLY, checked three ways: extension, MIME type and
//                    the file's real structure (%PDF- header + %%EOF trailer).
//   • "supporting" — internal working files an accountant attaches when
//                    submitting for review. Never emailed to the client.
//
// Every key we hand out is bound to the user and an expiry with an HMAC
// token, and attaching refuses anything without a valid token.
// ═════════════════════════════════════════════════════════════════

export type UploadPurpose = "final" | "supporting";

export const MAX_FINAL_PDFS = 10;
export const MAX_SUPPORTING_FILES = 10;
export const MAX_REPORT_FILE_BYTES =
  (Number(process.env.EMAIL_MAX_ATTACHMENT_MB) || 15) * 1024 * 1024;

const SUPPORTING_EXTENSIONS = new Set([
  ".pdf",
  ".xlsx",
  ".xls",
  ".xlsm",
  ".csv",
  ".docx",
  ".doc",
  ".pptx",
  ".txt",
  ".png",
  ".jpg",
  ".jpeg",
]);

const SECRET = `${process.env.JWT_SECRET ?? "dev-secret"}:report-upload`;
const TOKEN_TTL_S = 60 * 60;

export class ReportFileError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const extOf = (name: string) => path.extname(name).toLowerCase();

const sign = (
  userId: string,
  purpose: UploadPurpose,
  fileKey: string,
  exp: number,
) =>
  crypto
    .createHmac("sha256", SECRET)
    .update(`${userId}.${purpose}.${fileKey}.${exp}`)
    .digest("hex");

export const validToken = (
  userId: string,
  purpose: UploadPurpose,
  fileKey: string,
  token: string,
  exp: number,
): boolean => {
  if (!token || !exp || Number.isNaN(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(sign(userId, purpose, fileKey, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export interface UploadRequestFile {
  filename: string;
  mimeType?: string;
  size: number;
}

/** Pure check of one requested file's name / type — exported for tests. */
export function assertAllowedFile(
  purpose: UploadPurpose,
  f: { filename: string; mimeType?: string },
): void {
  const ext = extOf(f.filename);
  if (purpose === "final") {
    if (ext !== ".pdf")
      throw new ReportFileError(
        400,
        `"${f.filename}" is not a PDF. Only PDF files can be attached for client delivery.`,
      );
    if ((f.mimeType ?? "").toLowerCase() !== "application/pdf")
      throw new ReportFileError(
        400,
        `"${f.filename}" does not have the PDF content type. Only PDF files can be attached.`,
      );
    return;
  }
  if (!SUPPORTING_EXTENSIONS.has(ext))
    throw new ReportFileError(400, `File type ${ext || "(none)"} is not allowed`);
}

/** Pure structural PDF check on the first/last bytes — exported for tests. */
export function looksLikePdf(head: Buffer, tail: Buffer): boolean {
  return (
    head.length >= 5 &&
    head.subarray(0, 5).toString("latin1") === "%PDF-" &&
    tail.toString("latin1").includes("%%EOF")
  );
}

export async function createReportUploads(
  userId: string,
  purpose: UploadPurpose,
  files: UploadRequestFile[],
) {
  const max = purpose === "final" ? MAX_FINAL_PDFS : MAX_SUPPORTING_FILES;
  if (!Array.isArray(files) || files.length === 0)
    throw new ReportFileError(400, "No files provided");
  if (files.length > max)
    throw new ReportFileError(400, `You can attach at most ${max} files`);

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
      throw new ReportFileError(400, "Invalid file description");
    assertAllowedFile(purpose, f);
    total += f.size;
  }
  if (total > MAX_REPORT_FILE_BYTES)
    throw new ReportFileError(
      400,
      `Files can total at most ${Math.round(MAX_REPORT_FILE_BYTES / 1024 / 1024)} MB`,
    );

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  return Promise.all(
    files.map(async (f) => {
      const ext = extOf(f.filename);
      const fileKey = `${uuid()}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ""}`;
      const contentType =
        purpose === "final"
          ? "application/pdf"
          : f.mimeType || "application/octet-stream";
      const post = await createDirectUploadPost(
        fileKey,
        contentType,
        MAX_REPORT_FILE_BYTES,
      );
      return {
        filename: f.filename,
        fileKey,
        url: post.url,
        fields: post.fields,
        token: sign(userId, purpose, fileKey, exp),
        exp,
      };
    }),
  );
}

export interface UploadRef {
  fileKey: string;
  filename: string;
  token: string;
  exp: number;
}

export function parseRefs(raw: unknown, limit: number): UploadRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r) =>
        r &&
        typeof r.fileKey === "string" &&
        typeof r.filename === "string" &&
        typeof r.token === "string",
    )
    .slice(0, limit)
    .map((r) => ({
      fileKey: r.fileKey,
      filename: r.filename,
      token: r.token,
      exp: Number(r.exp),
    }));
}

export async function discardUploads(refs: UploadRef[]): Promise<void> {
  await Promise.all(refs.map((r) => deleteFromS3(r.fileKey)));
}

export interface VerifiedFile {
  fileKey: string;
  filename: string;
  mimeType?: string;
  size: number;
}

/**
 * Trusts nothing the browser said: re-checks the token, asks S3 what is
 * really stored, and for "final" reads the file's own bytes to confirm it is
 * a PDF. Any failure deletes every uploaded object of this batch.
 */
export async function verifyUploads(
  userId: string,
  purpose: UploadPurpose,
  refs: UploadRef[],
): Promise<VerifiedFile[]> {
  if (refs.length === 0) return [];
  try {
    const out: VerifiedFile[] = [];
    let total = 0;
    for (const r of refs) {
      if (!validToken(userId, purpose, r.fileKey, r.token, r.exp))
        throw new ReportFileError(400, "File upload is invalid or has expired");
      assertAllowedFile(purpose, {
        filename: r.filename,
        mimeType: purpose === "final" ? "application/pdf" : undefined,
      });
      if (purpose === "final" && extOf(r.fileKey) !== ".pdf")
        throw new ReportFileError(400, "Only PDF files can be attached");

      const head = await headObject(r.fileKey);
      if (!head)
        throw new ReportFileError(400, `"${r.filename}" did not finish uploading`);
      if (purpose === "final") {
        if ((head.contentType ?? "").toLowerCase() !== "application/pdf")
          throw new ReportFileError(
            400,
            `"${r.filename}" is not stored as a PDF and was rejected`,
          );
        if (head.size < 64)
          throw new ReportFileError(400, `"${r.filename}" is not a valid PDF`);
        const first = await readObjectRange(r.fileKey, 0, 7);
        const last = await readObjectRange(r.fileKey, -1024);
        if (!looksLikePdf(first, last))
          throw new ReportFileError(
            400,
            `"${r.filename}" is not a valid PDF document (its contents do not match the PDF format)`,
          );
      }
      total += head.size;
      out.push({
        fileKey: r.fileKey,
        filename: r.filename.slice(0, 255),
        mimeType: head.contentType,
        size: head.size,
      });
    }
    if (total > MAX_REPORT_FILE_BYTES)
      throw new ReportFileError(
        400,
        `Files can total at most ${Math.round(MAX_REPORT_FILE_BYTES / 1024 / 1024)} MB`,
      );
    return out;
  } catch (err) {
    await discardUploads(refs);
    throw err;
  }
}
