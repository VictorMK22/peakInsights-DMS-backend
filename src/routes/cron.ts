import { Router } from "express";
import { requireCronSecret } from "../middleware/cronAuth";
import {
  runEmailSync,
  runDocumentRetrySweep,
  runMeetingReminders,
  runTaskReminders,
} from "../controllers/cronController";

const router = Router();
router.use(requireCronSecret);

router.post("/sync-emails", runEmailSync);
router.post("/process-documents", runDocumentRetrySweep);
router.post("/meeting-reminders", runMeetingReminders);
router.post("/task-reminders", runTaskReminders);

export default router;