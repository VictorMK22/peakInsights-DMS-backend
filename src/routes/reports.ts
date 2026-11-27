import { Router } from "express";
import { authenticate } from "../middleware/auth";
import * as c from "../controllers/reportController";

// /api/reports — Management Accounts & Reports workflow, tracking and
// performance. Authentication happens here; the role/ownership rules are
// enforced server-side in the services (never only in the UI).
const router = Router();
router.use(authenticate);

// Static paths first so they are not swallowed by "/:id".
router.get("/summary", c.summary);
router.get("/delivery-config", c.deliveryConfig);
router.get("/ma/alerts", c.alerts);
router.get("/my-clients", c.myClients);
router.get("/ma/mine", c.myPeriods);
router.get("/ma/delivery", c.delivery);
router.get("/ma/performance", c.performance);
router.get("/ma/client/:clientId", c.clientTracking);
router.get("/ma/client/:clientId/current-period", c.clientCurrentPeriod);
router.patch("/ma/client/:clientId/config", c.setClientMaConfig);
router.post("/ma/period/:periodId/exempt", c.exemptPeriod);
router.post("/ma/period/:periodId/reinstate", c.reinstatePeriod);

router.get("/", c.list);
router.post("/ma", c.openMa);
router.post("/other", c.openOther);

router.get("/:id", c.detail);
router.patch("/:id", c.update);
router.delete("/:id", c.remove);
router.post("/:id/supporting/presign", c.presignSupportingFiles);
router.delete("/:id/supporting/:fileId", c.deleteSupporting);
router.post("/:id/submit", c.submit);

router.post("/:id/return", c.returnReport);
router.post("/:id/approve", c.approve);
router.post("/:id/reopen", c.reopen);

router.post("/:id/final/presign", c.presignFinal);
router.post("/:id/final", c.attachFinal);
router.delete("/:id/final/:attachmentId", c.deleteFinal);

router.post("/:id/send", c.send);

export default router;