import { Queue } from "bullmq";
import { redisConnection } from "./redisOptions";

export let documentQueue: Queue | null = null;

if (redisConnection) {
  documentQueue = new Queue("document-processing", {
    connection: redisConnection,
  });

  console.log("✅ Document queue enabled");
} else {
  console.warn("⚠️ Document queue disabled — Redis not configured");
}