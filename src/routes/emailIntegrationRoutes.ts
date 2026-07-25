import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  connectZoho,
  zohoCallback,
  getIntegrationStatus,
  disconnectZoho,
  getAllIntegrations,
} from "../controllers/emailIntegrationController";

const router = Router();

// PUBLIC — Zoho's browser redirect lands here with no auth header available.
// Identity is carried in the signed `state` param instead (see controller).
router.get("/zoho/callback", zohoCallback);

// Everything else requires the user to be logged into our app.
router.get("/zoho/connect", authenticate, connectZoho);
router.get("/zoho/status", authenticate, getIntegrationStatus);
router.post("/zoho/disconnect", authenticate, disconnectZoho);
router.get("/zoho/all", authenticate, getAllIntegrations);

export default router;
