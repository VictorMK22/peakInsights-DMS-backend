import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { validateWhatsappEnv } from "./config/validateWhatsappEnv";

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
import meetingRoutes from "./routes/meetings";
import calendarBlockRoutes from "./routes/calendarBlocks";
import livekitWebhookRoutes from "./routes/livekitWebhook";

// ── ICT workspace routes ────────────────────────────────────────
import projectRoutes from "./routes/projects";
import ticketRoutes from "./routes/tickets";
import assetRoutes from "./routes/assets";
import deploymentRoutes from "./routes/deployments";
import kbRoutes from "./routes/knowledgeBase";
import securityRoutes from "./routes/security";
import infrastructureRoutes from "./routes/infrastructure";
import systemRoutes from "./routes/systems";
import ictSeedRoutes from "./routes/ictSeed";
import sprintRoutes from "./routes/sprints";
import teamMemberRoutes from "./routes/teamMembers";

dotenv.config();

// Runs once per process (cold start on Vercel, once at boot locally) —
// app.ts is the shared module both entry points import.
validateWhatsappEnv();

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

// Trust the first hop in front of this app. On Vercel that's Vercel's
// own edge network, which sets X-Forwarded-For to the real visitor
// IP — without this, Express ignores that header by default (a
// sensible default on an untrusted network, but wrong here), which
// breaks express-rate-limit's ability to tell requests apart by IP
// (see the ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning in the logs).
// `1` means "trust exactly one hop," not "trust every proxy" — the
// right level of trust for a single edge network in front of the app,
// rather than blindly trusting an arbitrary chain of proxies.
app.set("trust proxy", 1);

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

// Must be mounted before express.json() below: LiveKit signs the
// exact raw bytes of the request body, and express.json() would
// otherwise consume the stream and hand this route a parsed object
// instead of the raw buffer verifyWebhookEvent() needs. LiveKit sends
// Content-Type: application/webhook+json specifically so it's never
// accidentally caught by a generic `application/json` parser either.
app.use(
  "/webhooks/livekit",
  express.raw({ type: "application/webhook+json", limit: "1mb" }),
  livekitWebhookRoutes,
);

// The `verify` callback stashes the exact raw bytes of every JSON body
// on the request before Express parses them. Needed specifically for
// the WhatsApp webhook, whose X-Hub-Signature-256 header is an HMAC
// over those exact bytes — re-serializing the parsed body would very
// likely produce a different signature (key order, whitespace) even
// with byte-identical semantic content. Cheap to do unconditionally
// for every route since it's just a buffer reference, not a copy.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500, // increased — folder uploads generate many requests
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please try again later.",
    // Meta's webhook has its own signature-based auth (see
    // controllers/clientWhatsappController.ts) and can legitimately
    // burst well above normal user traffic when many clients message
    // at once — it authenticates the request, not this limiter.
    skip: (req) => req.path.startsWith("/webhooks/"),
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
app.use("/api/meetings", meetingRoutes);
app.use("/api/calendar-blocks", calendarBlockRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/assets", assetRoutes);
app.use("/api/deployments", deploymentRoutes);
app.use("/api/knowledge-base", kbRoutes);
app.use("/api/security", securityRoutes);
app.use("/api/infrastructure", infrastructureRoutes);
app.use("/api/systems", systemRoutes);
app.use("/api/ict-seed", ictSeedRoutes);
app.use("/api/sprints", sprintRoutes);
app.use("/api/team-members", teamMemberRoutes);

// ── Root ──────────────────────────────────────────────────────────
// This API has no UI of its own — every real route lives under /api
// or /webhooks. This just gives anyone who hits the bare domain
// directly (browser, uptime monitor) something reassuring instead of
// a bare 404, without acting as a real endpoint the frontend depends on.
app.get("/", (_req, res) => {
  res.json({
    service: "PeakInsights DMS API",
    status: "ok",
    docs: "/api/health",
  });
});

// ── Health check ──────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "PeakInsights DMS API", version: "1.0.0" });
});

// ── Error handling ────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
