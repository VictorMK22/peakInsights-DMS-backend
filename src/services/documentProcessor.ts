import { DocumentProcessingJob } from "../types/jobs";
import { DocumentModel } from "../models/Document";
import { extractDocumentText } from "../utils/extractDocumentText";
import { downloadFromS3 } from "./s3Storage";

/**
 * Runs document text extraction inline, in the same request that
 * triggered it, instead of via a BullMQ-queued background worker.
 *
 * This is the path that ALWAYS runs on Vercel: there's no Redis/worker
 * process there (see queues/documentQueue.ts — it already falls back
 * to this function whenever the queue isn't configured), so this now
 * does the real extraction work the BullMQ worker used to do
 * (workers/documentWorker.ts), just synchronously and reading the
 * file from S3 instead of local disk.
 *
 * Trade-off worth knowing: Vercel functions have a hard execution
 * time limit (10s on Hobby by default). For most documents this is
 * plenty, but a very large or scan-heavy file could exceed it — if
 * that happens, the upload itself still succeeds (the document row is
 * already created before this runs), only text extraction/search
 * indexing for that one file is skipped, and its status is left as
 * "failed" for a human to notice and retry via re-upload.
 */
export const processDocumentDirectly = async (
  job: DocumentProcessingJob,
): Promise<boolean> => {
  const { documentId, fileKey, fileType } = job;
  console.log("📄 Processing document inline:", documentId);

  try {
    const buffer = await downloadFromS3(fileKey);
    const contentText = await extractDocumentText(buffer, fileType);

    await DocumentModel.findByIdAndUpdate(documentId, {
      contentText,
      indexedAt: new Date(),
      status: "processed",
    });

    console.log(`✅ Processed document ${documentId} (inline)`);
    return true;
  } catch (err) {
    console.error(`❌ Inline processing failed for ${documentId}:`, err);
    await DocumentModel.findByIdAndUpdate(documentId, {
      status: "failed",
    }).catch(() => undefined);
    return false;
  }
};
