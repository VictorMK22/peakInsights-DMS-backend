import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { getSentEmails, retryEmail, sendEmailDirect } from '../controllers/emailController';

const router = Router();
router.use(authenticate);

router.post('/', sendEmailDirect);
router.get("/sent", getSentEmails);
router.get("/:id/retry", retryEmail);

export default router;