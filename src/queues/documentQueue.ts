import { documentQueue } from "../config/queue";
import { DocumentProcessingJob } from "../types/jobs";
import { processDocumentDirectly } from "../services/documentProcessor";

export const enqueueDocumentProcessing = async (
  job: DocumentProcessingJob
): Promise<"queued" | "processed-inline"> => {
  // ✅ If Redis/queue is unavailable → fallback instead of crash
  if (!documentQueue) {
    console.warn("⚠️ Queue not initialized — processing inline");

    await processDocumentDirectly(job);
    return "processed-inline";
  }

  try {
    await documentQueue.add("extract-text", job, {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
    });

    return "queued";
  } catch (error) {
    // ✅ If queue fails at runtime → fallback
    console.error("❌ Queue failed, falling back to inline processing:", error);

    await processDocumentDirectly(job);
    return "processed-inline";
  }
};