import http from "http";
import mongoose from "mongoose";
import app from "./app";
import { initSocket } from "./socket/socketServer";
import { initYjsServer } from "./yjs/yjsServer";
import { connectDatabase } from "./config/database";
import { startEmailSyncScheduler } from "./config/emailSyncQueue";

// ═════════════════════════════════════════════════════════════════
// TRADITIONAL / LOCAL DEV ENTRY POINT — run via `npm run dev` / `npm
// start`. This is what actually opens a persistent HTTP server,
// connects to the database once and keeps the connection open, and
// sets up Socket.io + Yjs (both of which need a real long-lived
// server, and are not available in the Vercel serverless deployment —
// see api/index.ts for that entry point instead, and app.ts for the
// framework-agnostic Express app both of these share).
// ═════════════════════════════════════════════════════════════════

const PORT = process.env.PORT ?? 5000;

const startServer = async () => {
  try {
    await connectDatabase();

    const server = http.createServer(app);

    initSocket(server);
    initYjsServer(server);

    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      startEmailSyncScheduler();
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("MongoDB connection closed.");
  process.exit(0);
});
