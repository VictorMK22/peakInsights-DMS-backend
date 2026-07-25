import { Queue } from "bullmq";
import { redisConnection } from "./redisOptions";
import { syncAllConnectedMailboxes } from "../services/emailSyncService";

export let emailSyncQueue: Queue | null = null;

const SYNC_INTERVAL_MS =
  Number(process.env.EMAIL_SYNC_INTERVAL_MS) || 5 * 60 * 1000; // 5 min default

if (redisConnection) {
  emailSyncQueue = new Queue("email-sync", { connection: redisConnection });
  console.log("✅ Email sync queue enabled");
} else {
  console.warn(
    "⚠️ Email sync queue disabled — Redis not configured, falling back to setInterval",
  );
}

/**
 * Call once at server startup. If Redis/BullMQ is available, schedules a
 * repeatable job (picked up by workers/emailSyncWorker.ts) so sync survives
 * restarts and can run on a separate worker process. Otherwise falls back
 * to an in-process setInterval — same "degrade, don't crash" approach used
 * for document processing.
 */
export async function startEmailSyncScheduler(): Promise<void> {
  if (emailSyncQueue) {
    await emailSyncQueue.add(
      "sync",
      {},
      {
        repeat: { every: SYNC_INTERVAL_MS },
        jobId: "email-sync-repeat", // prevents duplicate repeatables on restart
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    console.log(
      `📧 Email sync scheduled every ${SYNC_INTERVAL_MS / 1000}s (queue-backed)`,
    );
  } else {
    setInterval(() => {
      syncAllConnectedMailboxes().catch((err) =>
        console.error("Email sync (inline) failed:", err),
      );
    }, SYNC_INTERVAL_MS);
    console.log(
      `📧 Email sync scheduled every ${SYNC_INTERVAL_MS / 1000}s (inline fallback)`,
    );
  }
}
