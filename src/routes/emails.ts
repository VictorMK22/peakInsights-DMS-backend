import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  getSentEmails,
  getInboxEmails,
  getEmailThread,
  retryEmail,
  sendEmailDirect,
  markEmailRead,
  getUnreadEmailCount,
} from "../controllers/emailController";

const router = Router();
router.use(authenticate);

router.post("/", sendEmailDirect);
router.get("/sent", getSentEmails);
router.get("/inbox", getInboxEmails);
router.get("/unread-count", getUnreadEmailCount);
router.get("/thread/:id", getEmailThread);
router.patch("/:id/read", markEmailRead);
router.get("/:id/retry", retryEmail);

export default router;
