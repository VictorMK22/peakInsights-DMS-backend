import type { VercelRequest, VercelResponse } from "@vercel/node";
import app from "../src/app";
import { connectDatabaseServerless } from "../src/config/databaseServerless";

// ═════════════════════════════════════════════════════════════════
// VERCEL SERVERLESS ENTRY POINT
// ═════════════════════════════════════════════════════════════════
// Every request to this deployment — regardless of path — is routed
// here by vercel.json's rewrite rule, and handed off to the same
// Express app (app.ts) used by the traditional server (index.ts).
// Express's own internal routing (app.use("/api/auth", ...) etc.)
// still does all the actual path matching exactly as before; Vercel
// just forwards the raw request/response into it.
//
// Two things a normal Express server gets "for free" from its own
// process that a serverless function must handle explicitly on every
// invocation:
//   1. The database connection — see connectDatabaseServerless, which
//      caches the connection across warm invocations rather than
//      reconnecting every time.
//   2. Nothing here starts a persistent server (`.listen()`) — Vercel
//      itself is the thing listening; this function just needs to
//      process one request and return.
//
// Real-time features (Socket.io, Yjs collaborative editing) are
// intentionally NOT initialized here — they need a long-lived server
// process that a serverless function fundamentally cannot provide.
// Every place in the app that emits a socket event already fails
// silently if no socket server is running (see getIO() call sites),
// so nothing crashes — those features simply don't fire yet. This is
// deliberate and temporary: they're being rebuilt on serverless-
// compatible providers (Pusher/Ably + Liveblocks) as a separate,
// later piece of work.
// ═════════════════════════════════════════════════════════════════

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await connectDatabaseServerless();
  // Express apps are valid (req, res) => void handlers themselves —
  // no adapter library needed.
  return (app as unknown as (req: VercelRequest, res: VercelResponse) => void)(
    req,
    res,
  );
}
