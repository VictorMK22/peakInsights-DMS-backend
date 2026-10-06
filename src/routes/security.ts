import { Router } from "express";
import { authenticate, requireIctAccess } from "../middleware/auth";
import {
  listSecurityEvents,
  logSecurityEvent,
  getSecuritySummary,
} from "../controllers/securityController";

const router = Router();
router.use(authenticate, requireIctAccess);

router.get("/events", listSecurityEvents);
router.post("/events", logSecurityEvent);
router.get("/summary", getSecuritySummary);

export default router;
