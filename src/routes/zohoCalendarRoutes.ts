import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  connectZohoCalendar,
  zohoCalendarCallback,
  getZohoCalendarStatus,
  disconnectZohoCalendar,
  getZohoCalendarEvents,
} from "../controllers/zohoCalendarController";

const router = Router();

// PUBLIC — Zoho's browser redirect lands here with no auth header
// available. Identity is carried in the signed `state` param instead.
router.get("/zoho-calendar/callback", zohoCalendarCallback);

// Everything else requires the user to be logged into our app.
router.get("/zoho-calendar/connect", authenticate, connectZohoCalendar);
router.get("/zoho-calendar/status", authenticate, getZohoCalendarStatus);
router.get("/zoho-calendar/events", authenticate, getZohoCalendarEvents);
router.post("/zoho-calendar/disconnect", authenticate, disconnectZohoCalendar);

export default router;