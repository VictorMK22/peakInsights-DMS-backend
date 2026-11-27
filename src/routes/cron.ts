import { Router } from "express";
import { requireCronSecret } from "../middleware/cronAuth";
import {
  runEmailSync,
  runDocumentRetrySweep,
  runLargeDocumentIndex,
  runUploadSweep,
  runMeetingReminders,
  runTaskReminders,
  runBookingRequestSweep,
  runSalesWeeklyReport,
  runMaDeadlines,
} from "../controllers/cronController";

const router = Router();
router.use(requireCronSecret);

router.post("/sync-emails", runEmailSync);
router.post("/process-documents", runDocumentRetrySweep);
// Big .docx/.pptx/.xlsx uploads — every ~10 min. Rewritten to its own
// long-running function in vercel.json (api/index-large.ts).
router.post("/index-large-documents", runLargeDocumentIndex);
// Deletes never-attached direct uploads from S3 — hourly.
router.post("/sweep-uploads", runUploadSweep);
router.post("/meeting-reminders", runMeetingReminders);
router.post("/task-reminders", runTaskReminders);
router.post("/booking-requests", runBookingRequestSweep);
router.post("/sales-weekly-report", runSalesWeeklyReport);
// Management Accounts 15th-day deadline monitor — call daily (see cronController).
router.post("/ma-deadlines", runMaDeadlines);

export default router;