import { Router } from "express";
import { receiveLivekitWebhook } from "../controllers/livekitWebhookController";

// LiveKit calls this directly (server-to-server) — must not sit
// behind our app's JWT authenticate middleware. Trust comes from the
// webhook signature (verifyWebhookEvent), not a session token.
// The raw-body parser for this exact path is mounted in app.ts,
// ahead of the global express.json() middleware.
const router = Router();
router.post("/", receiveLivekitWebhook);

export default router;
