import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUpcomingEvents,
} from "../controllers/notificationController";

const router = Router();
router.use(authenticate);

router.get("/", listNotifications);
router.get("/upcoming-events", getUpcomingEvents);
router.post("/read-all", markAllNotificationsRead);
router.patch("/:id/read", markNotificationRead);

export default router;