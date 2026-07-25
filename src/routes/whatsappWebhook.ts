import { Router } from "express";
import {
  verifyWhatsappWebhook,
  receiveWhatsappWebhook,
} from "../controllers/clientWhatsappController";

const router = Router();

// Meta hits GET once to verify the endpoint when you register it in the
// App dashboard, then POSTs every subsequent message/status event here.
// This must NOT sit behind the app's authenticate middleware.
router.get("/", verifyWhatsappWebhook);
router.post("/", receiveWhatsappWebhook);

export default router;
