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
  transferPresenter,
  startBreakoutRooms,
  endBreakoutRooms,
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
 *   POST   /:id/presenter        Host-only — transfer screen-share rights to one
 *                                participant (or back to the host)
 *   POST   /:id/breakout-rooms          Host-only — auto-split the call into N breakout rooms
 *   POST   /:id/breakout-rooms/close    Host-only — end breakout rooms, move everyone back
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
router.post("/:id/presenter", transferPresenter);
router.post("/:id/breakout-rooms", startBreakoutRooms);
router.post("/:id/breakout-rooms/close", endBreakoutRooms);

export default router;
