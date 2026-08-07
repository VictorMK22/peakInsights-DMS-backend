import { Router } from "express";
import { authenticate, authorize } from "../middleware/auth";
import {
  getLeaderboard,
  getBottleneckAnalysis,
  getTrendAnalysis,
  getDashboardStats,
  getAuditTrail,
  getCollaborationFrequency,
  getEmailAnalytics,
} from "../controllers/analyticsController";

const router = Router();
router.use(authenticate);
router.get("/dashboard", getDashboardStats);
router.get("/leaderboard", authorize("ceo", "supervisor"), getLeaderboard);
router.get(
  "/bottlenecks",
  authorize("ceo", "supervisor"),
  getBottleneckAnalysis,
);
router.get("/trends", authorize("ceo", "supervisor"), getTrendAnalysis);
router.get("/audit-trail", getAuditTrail);
router.get(
  "/collaboration-frequency",
  authorize("ceo", "supervisor"),
  getCollaborationFrequency,
);
router.get("/email-stats", getEmailAnalytics);

export default router;
