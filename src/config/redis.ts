import Redis from "ioredis";

let redis: Redis | null = null;

const host = process.env.REDIS_HOST;
const port = process.env.REDIS_PORT;

if (host && port) {
  try {
    redis = new Redis({
      host,
      port: Number(port),
      password: process.env.REDIS_PASSWORD || undefined,
    });

    redis.on("connect", () => {
      console.log("✅ Redis connected");
    });

    redis.on("error", (err) => {
      console.log("⚠️ Redis error:", err.message);
      redis = null;
    });
  } catch {
    redis = null;
  }
} else {
  console.log("⚠️ Redis not configured — skipping cache");
}

export { redis };