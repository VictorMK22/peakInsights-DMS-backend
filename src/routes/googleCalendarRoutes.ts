import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  connectGoogleCalendar,
  googleCalendarCallback,
  getGoogleCalendarStatus,
  disconnectGoogleCalendar,
} from "../controllers/googleCalendarController";

const router = Router();

// PUBLIC — Google's browser redirect lands here with no auth header
// available. Identity is carried in the signed `state` param instead.
router.get("/google-calendar/callback", googleCalendarCallback);

// Everything else requires the user to be logged into our app.
router.get("/google-calendar/connect", authenticate, connectGoogleCalendar);
router.get("/google-calendar/status", authenticate, getGoogleCalendarStatus);
router.post(
  "/google-calendar/disconnect",
  authenticate,
  disconnectGoogleCalendar,
);

export default router;
