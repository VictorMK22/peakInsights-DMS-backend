import mongoose from "mongoose";
import { seedCEO } from "../utils/seeder";

// ═════════════════════════════════════════════════════════════════
// Serverless functions can be invoked many times per minute, each
// potentially a fresh "cold start." Without caching, every single
// invocation would open a brand-new MongoDB connection — quickly
// exhausting MongoDB's max-connections limit, and adding real latency
// to every request for the connection handshake itself.
//
// The fix (Vercel's own documented pattern for Mongoose): cache the
// connection promise on the Node.js `global` object, which persists
// across invocations on the same warm function instance. A cold start
// still connects once; every subsequent invocation on that same warm
// instance reuses the existing connection instantly.
//
// This intentionally does NOT retry-loop or process.exit() on
// failure like the traditional connectDatabase() (config/database.ts)
// does — that's correct behavior for a long-running server, but fatal
// in a serverless function: killing the process would take down
// unrelated concurrent requests too. Here, a connection failure just
// throws, and Express's normal error handling returns a 500 for that
// one request.
// ═════════════════════════════════════════════════════════════════

interface CachedConnection {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __mongooseCache: CachedConnection | undefined;
}

const cached: CachedConnection = global.__mongooseCache ?? {
  conn: null,
  promise: null,
};
global.__mongooseCache = cached;

export async function connectDatabaseServerless(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGODB_URI environment variable is missing");
    }

    cached.promise = mongoose
      .connect(mongoUri, {
        autoIndex: false,
        maxPoolSize: 5, // lower than the traditional server's 10 — many
        // concurrent serverless instances can each hold a
        // connection, so a smaller per-instance pool avoids
        // collectively exceeding MongoDB's own connection cap
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      })
      .then(async (m) => {
        console.log("✅ MongoDB connected (serverless)");
        await seedCEO().catch((err) =>
          console.error("seedCEO failed (non-fatal):", err),
        );
        return m;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null; // let the next invocation retry from scratch
    throw err;
  }

  return cached.conn;
}
