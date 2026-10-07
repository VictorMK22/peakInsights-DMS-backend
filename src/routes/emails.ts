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
  syncEmailsNow,
  getBroadcastAudience,
  sendBroadcast,
  getAttachmentLimits,
  presignAttachmentUploads,
  getEmailContacts,
} from "../controllers/emailController";
import { emailUpload } from "../middleware/emailUpload";

const router = Router();
router.use(authenticate);

router.post("/", emailUpload, sendEmailDirect);
router.get("/contacts", getEmailContacts);
router.get("/attachments/limits", getAttachmentLimits);
router.post("/attachments/presign", presignAttachmentUploads);
router.get("/broadcast/audience", getBroadcastAudience);
router.post("/broadcast", emailUpload, sendBroadcast);
router.get("/sent", getSentEmails);
router.get("/inbox", getInboxEmails);
router.post("/sync-now", syncEmailsNow);
router.get("/unread-count", getUnreadEmailCount);
router.get("/thread/:id", getEmailThread);
router.patch("/:id/read", markEmailRead);
router.get("/:id/retry", retryEmail);

export default router;
