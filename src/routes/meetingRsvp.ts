import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getRsvpInvitation,
  submitRsvpResponse,
} from "../controllers/meetingRsvpController";

/**
 * Public — answering a meeting invitation from the email, no login.
 * Authorised by the signed token in the URL (utils/meetingRsvpToken.ts),
 * deliberately NOT behind `authenticate`: external invitees have no
 * account. Mounted at /api/meeting-rsvp.
 *
 *   GET  /:token   Read-only view of the invitation (safe for link scanners)
 *   POST /:token   Record accept / decline (decline requires a reason)
 */

const router = Router();

// Tokens are unguessable, but this is an unauthenticated write endpoint, so
// it gets its own tighter cap on top of the app-wide limiter. Ample for a
// person changing their mind a few times.
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      code: "RATE_LIMITED",
      message: "Too many attempts. Please try again in a few minutes.",
    },
  }),
);

router.get("/:token", getRsvpInvitation);
router.post("/:token", submitRsvpResponse);

export default router;