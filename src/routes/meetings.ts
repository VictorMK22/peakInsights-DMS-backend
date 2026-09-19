import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createMeeting,
  getMeetings,
  getMeeting,
  updateMeeting,
  cancelMeeting,
  respondToMeeting,
  checkAvailability,
  getMeetingActivityHistory,
  generateGoogleMeetLink,
} from "../controllers/meetingController";

/**
 * Meeting & Calendar module.
 *
 *   GET    /                     Calendar-range view (mine + invited; ?clientId= for a client's meetings)
 *   POST   /                     Create a meeting (checks conflicts first — see 409 response)
 *   POST   /check-availability   Live conflict check while filling out the create/edit form
 *   POST   /google-meet-link     Mint a real Google Meet link via the organizer's connected
 *                                Google account, for use as the meeting's meetingLink
 *                                (see services/googleCalendarService.ts)
 *   GET    /:id                  Single meeting detail
 *   PUT    /:id                  Organizer edits (re-checks conflicts if time/attendees changed)
 *   PATCH  /:id/cancel           Organizer cancels (optionally the whole recurring series)
 *   PATCH  /:id/respond          Invited attendee sets accepted/declined/tentative
 *   GET    /:id/activity         Automatic activity trail for this meeting
 *
 * See routes/calendarBlocks.ts for personal unavailability blocks, and
 * controllers/cronController.ts (runMeetingReminders) for the
 * scheduled-reminder + auto-complete sweep.
 *
 * Video calls are external — attendees join via the meeting's
 * meetingLink (e.g. a Google Meet link generated above, or any link
 * an organizer pastes in). There is no built-in call, recording,
 * attendance tracking, or breakout-room feature in this module.
 */

const router = Router();
router.use(authenticate);

router.get("/", getMeetings);
router.post("/", createMeeting);
router.post("/check-availability", checkAvailability);
router.post("/google-meet-link", generateGoogleMeetLink);

router.get("/:id", getMeeting);
router.put("/:id", updateMeeting);
router.patch("/:id/cancel", cancelMeeting);
router.patch("/:id/respond", respondToMeeting);
router.get("/:id/activity", getMeetingActivityHistory);

export default router;
