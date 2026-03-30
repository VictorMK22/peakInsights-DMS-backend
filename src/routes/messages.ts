import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  sendMessage,
  getInbox,
  getSent,
  getThread,
  markRead,
  getUnreadCount,
  getContacts,
} from '../controllers/messageController';

const router = Router();
router.use(authenticate);

router.get('/contacts',      getContacts);
router.get('/unread-count',  getUnreadCount);
router.get('/inbox',         getInbox);
router.get('/sent',          getSent);
router.get('/thread/:id',    getThread);
router.post('/',             sendMessage);
router.patch('/:id/read',    markRead);

export default router;