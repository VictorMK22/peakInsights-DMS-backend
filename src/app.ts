import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { errorHandler, notFound } from "./middleware/errorHandler";

import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import documentRoutes from "./routes/documents";
import analyticsRoutes from "./routes/analytics";
import folderRoutes from "./routes/folders";
import taskRoutes from "./routes/tasks";
import messageRoutes from "./routes/messages";
import emailRoutes from "./routes/emails";
import clientRoutes from "./routes/clientRoutes";
import whatsappWebhookRoutes from "./routes/whatsappWebhook";
import emailIntegrationRoutes from "./routes/emailIntegrationRoutes";
import cronRoutes from "./routes/cron";
import shareRoutes from "./routes/share";
import filesRoutes from "./routes/files";
import departmentRoutes from "./routes/departments";
import trashRoutes from "./routes/trash";
import learningCategoryRoutes from "./routes/learningCategories";

dotenv.config();

// ═════════════════════════════════════════════════════════════════
// This file builds and exports the configured Express app, with NO
// side effects at import time (no DB connect, no server.listen(), no
// Socket.io/Yjs setup). That split matters specifically for Vercel:
// a serverless function imports this same `app` on every cold start,
// and must NOT try to open a new persistent TCP listener each time —
// Vercel's platform handles the actual HTTP listening itself.
//
// For local/traditional development (npm run dev), see index.ts,
// which imports this app, connects to the database, calls
// server.listen(), and sets up Socket.io/Yjs — none of which apply
// in the serverless deployment (see api/index.ts instead).
//
// Files are no longer stored on local disk (see middleware/upload.ts
// and services/s3Storage.ts) — everything goes to S3, which is what
// makes this app safe to run in an environment with no persistent,
// shared filesystem in the first place.
// ═════════════════════════════════════════════════════════════════

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// ── Security ──────────────────────────────────────────────────────
app.use(
  helmet({
    // Disable frameguard so PDFs can be embedded in iframes
    frameguard: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "frame-ancestors": ["'self'", FRONTEND_URL],
        "frame-src": ["'self'", FRONTEND_URL, "http://localhost:5000"],
      },
    },
  }),
);

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500, // increased — folder uploads generate many requests
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please try again later.",
  }),
);

app.use((req, _res, next) => {
  console.log("→", req.method, req.url);
  next();
});

// ── Routes ────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/folders", folderRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/emails", emailRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/integrations", emailIntegrationRoutes);
// Public — Meta calls this directly, must not require our app auth.
app.use("/webhooks/whatsapp", whatsappWebhookRoutes);
// Secret-protected (not user auth) — called by an external scheduler,
// see routes/cron.ts and middleware/cronAuth.ts.
app.use("/api/cron", cronRoutes);
app.use("/api", shareRoutes);
app.use("/api/files", filesRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/trash", trashRoutes);
app.use("/api/learning-categories", learningCategoryRoutes);

// ── Health check ──────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "PeakInsights DMS API", version: "1.0.0" });
});

// ── Error handling ────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
