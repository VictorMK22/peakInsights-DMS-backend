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
  getAccountantWorkspace,
} from "../controllers/analyticsController";
import { getSalesActivityReport } from "../controllers/salesReportController";

const router = Router();
router.use(authenticate);
router.get("/dashboard", getDashboardStats);
router.get(
  "/accountant-workspace",
  // Scoped to the CALLER's own assigned clients (see the controller), so
  // opening it to the CEO and supervisors — who can work in the Accountant
  // workspace — never exposes anyone else's book.
  authorize("accountant", "ceo", "supervisor"),
  getAccountantWorkspace,
);
router.get("/leaderboard", authorize("ceo", "supervisor"), getLeaderboard);
// Per-rep sales activity (leads, meetings, calls/emails/WhatsApp, stage moves).
router.get("/sales-activity", authorize("ceo"), getSalesActivityReport);
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