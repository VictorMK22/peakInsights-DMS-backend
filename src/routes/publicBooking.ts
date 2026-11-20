import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  getPublicBookingLink,
  getPublicSlots,
  getPublicOffer,
  submitBooking,
} from "../controllers/bookingController";

/**
 * PUBLIC — what a client sees when they open a booking link. No login, by
 * design (clients have no account), so these carry their own limits on top
 * of the app-wide one. Mounted at /api/public/booking.
 *
 *   GET  /:slug         The page's title, host name, length, location
 *   GET  /:slug/slots   Open time slots only (never what is busy, or why)
 *   GET  /:slug/offer   Details of a "pick another time" offer (token required)
 *   POST /:slug/book    Book a slot
 */
const router = Router();

const limited = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message },
  });

// Browsing slots is cheap for people, expensive for us (calendar reads).
const browseLimiter = limited(
  15 * 60 * 1000,
  120,
  "Too many requests. Please try again in a few minutes.",
);
// Booking sends emails and writes to a calendar: much tighter.
const bookLimiter = limited(
  60 * 60 * 1000,
  10,
  "Too many booking attempts. Please try again later.",
);

router.get("/:slug", browseLimiter, getPublicBookingLink);
router.get("/:slug/slots", browseLimiter, getPublicSlots);
router.get("/:slug/offer", browseLimiter, getPublicOffer);
router.post("/:slug/book", bookLimiter, submitBooking);

export default router;