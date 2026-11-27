import { DocumentModel } from "../models/Document";
import { downloadFromS3 } from "./s3Storage";
import {
  extractTextContent,
  classifyForIndexing,
} from "../utils/extractTextContent";
import {
  DEEP_INDEX_MAX_BYTES,
  DEEP_INDEX_MAX_SPREADSHEET_BYTES,
} from "./documentDirectUpload";

// ═════════════════════════════════════════════════════════════════
// BACKGROUND INDEXING OF LARGE FILES
//
// Uploads over DOC_EXTRACT_INLINE_MB (25 MB) skip text extraction during the
// request — loading a big .docx/.xlsx/.pptx into memory there would risk the
// upload itself. They're stored with indexState "pending" instead, and this
// runs from a cron (POST /api/cron/index-large-documents) on its own
// serverless function with a longer time limit (api/index-large.ts), one
// document at a time.
//
// Safety: the attempt counter is bumped BEFORE the file is touched, so a file
// that crashes the function (out of memory) is retried at most MAX_ATTEMPTS
// times and then marked "failed" — it can never wedge the queue.
// ═════════════════════════════════════════════════════════════════

const MAX_ATTEMPTS = 3;

export interface LargeIndexSummary {
  processed: number;
  indexed: number;
  skipped: number;
  retryLater: number;
  failed: number;
}

export async function indexPendingLargeDocuments({
  maxDocs = 5,
  budgetMs = 200_000,
}: { maxDocs?: number; budgetMs?: number } = {}): Promise<LargeIndexSummary> {
  const started = Date.now();
  const out: LargeIndexSummary = {
    processed: 0,
    indexed: 0,
    skipped: 0,
    retryLater: 0,
    failed: 0,
  };

  // Anything that already used up its attempts (typically: it kept crashing
  // the function) is finished with.
  const exhausted = await DocumentModel.updateMany(
    { indexState: "pending", indexAttempts: { $gte: MAX_ATTEMPTS } },
    { $set: { indexState: "failed" } },
  );
  out.failed += exhausted.modifiedCount ?? 0;

  while (out.processed < maxDocs && Date.now() - started < budgetMs) {
    const doc = await DocumentModel.findOneAndUpdate(
      { indexState: "pending", indexAttempts: { $lt: MAX_ATTEMPTS } },
      { $inc: { indexAttempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    )
      .select("_id fileKey fileType fileName fileSize indexAttempts")
      .lean();
    if (!doc) break;
    out.processed++;

    const kind = classifyForIndexing(doc.fileType, doc.fileName);
    const limit =
      kind === "spreadsheet"
        ? DEEP_INDEX_MAX_SPREADSHEET_BYTES
        : DEEP_INDEX_MAX_BYTES;
    if ((kind !== "office" && kind !== "spreadsheet") || doc.fileSize > limit) {
      await DocumentModel.updateOne(
        { _id: doc._id },
        { $set: { indexState: "skipped" } },
      );
      out.skipped++;
      continue;
    }

    try {
      const buffer = await downloadFromS3(doc.fileKey);
      // extractTextContent never throws: it returns undefined when it failed.
      const text = await extractTextContent(buffer, doc.fileType, doc.fileName);
      if (text === undefined) throw new Error("text extraction failed");

      await DocumentModel.updateOne(
        { _id: doc._id, fileKey: doc.fileKey }, // not if the file was replaced meanwhile
        { $set: { contentText: text, indexedAt: new Date(), indexState: "indexed" } },
      );
      out.indexed++;
    } catch (err) {
      console.error(`Large-document indexing failed for ${doc._id}:`, err);
      if ((doc.indexAttempts ?? 1) >= MAX_ATTEMPTS) {
        await DocumentModel.updateOne(
          { _id: doc._id },
          { $set: { indexState: "failed" } },
        );
        out.failed++;
      } else {
        out.retryLater++;
      }
    }
  }
  return out;
}