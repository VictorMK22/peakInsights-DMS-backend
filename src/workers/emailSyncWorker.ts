import { Worker } from "bullmq";
import { redisConnection } from "../config/redisOptions";
import { syncAllConnectedMailboxes } from "../services/emailSyncService";

let worker: Worker | null = null;

if (redisConnection) {
  worker = new Worker(
    "email-sync",
    async () => {
      await syncAllConnectedMailboxes();
    },
    { connection: redisConnection },
  );

  worker.on("failed", (job, err) => {
    console.error(`❌ Email sync job ${job?.id} failed:`, err);
  });
} else {
  console.warn("⚠️ Email sync worker not started — Redis not configured");
}

export default worker;
