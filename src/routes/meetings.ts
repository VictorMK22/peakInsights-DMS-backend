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
  getJoinToken,
  getMeetingAttendance,
  getMeetingRecordingUrl,
} from "../controllers/meetingController";

/**
 * Meeting & Calendar module.
 *
 *   GET    /                     Calendar-range view (mine + invited; ?clientId= for a client's meetings)
 *   POST   /                     Create a meeting (checks conflicts first — see 409 response)
 *   POST   /check-availability   Live conflict check while filling out the create/edit form
 *   GET    /:id                  Single meeting detail
 *   PUT    /:id                  Organizer edits (re-checks conflicts if time/attendees changed)
 *   PATCH  /:id/cancel           Organizer cancels (optionally the whole recurring series)
 *   PATCH  /:id/respond          Invited attendee sets accepted/declined/tentative
 *   GET    /:id/activity         Automatic activity trail for this meeting
 *   GET    /:id/join-token       LiveKit access token for the built-in video call
 *                                (only for meetings created with isVirtual: true)
 *   GET    /:id/attendance       Per-participant join/leave sessions, automatic
 *                                from LiveKit webhooks (see routes/livekitWebhook.ts)
 *   GET    /:id/recording        Short-lived S3 download URL, once recordingStatus
 *                                is "available" (recordingEnabled meetings only)
 *
 * See routes/calendarBlocks.ts for personal unavailability blocks,
 * controllers/cronController.ts (runMeetingReminders) for the
 * scheduled-reminder + auto-complete sweep, and
 * routes/livekitWebhook.ts for how join/leave/recording events flow
 * back in automatically.
 */

const router = Router();
router.use(authenticate);

router.get("/", getMeetings);
router.post("/", createMeeting);
router.post("/check-availability", checkAvailability);

router.get("/:id", getMeeting);
router.put("/:id", updateMeeting);
router.patch("/:id/cancel", cancelMeeting);
router.patch("/:id/respond", respondToMeeting);
router.get("/:id/activity", getMeetingActivityHistory);
router.get("/:id/join-token", getJoinToken);
router.get("/:id/attendance", getMeetingAttendance);
router.get("/:id/recording", getMeetingRecordingUrl);

export default router;
