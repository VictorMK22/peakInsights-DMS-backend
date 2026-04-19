import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { uploadToLocal } from '../middleware/upload';
import {
  createTask,
  getTasks,
  getTask,
  updateTask,
  updateTaskStatus,
  approveTask,
  deleteTask,
  inviteTaskCollaborator,
  revokeTaskCollaborator,
  getTaskLeaderboard,
  getUserAppraisal,
} from '../controllers/taskController';

/**
 * Tasks — own TAT, efficiency, collaboration, file uploads, document linking.
 *
 * Lifecycle:
 *   POST   /              CEO/Supervisor creates task (can upload briefing files)
 *   PATCH  /:id/status    Drives TAT state machine:
 *                           pending → in_progress (assignee sets targetMinutes)
 *                           in_progress → submitted (assignee attaches docs)
 *                           submitted → completed   (approver approves)
 *                           submitted → rejected    (approver rejects, back to in_progress)
 *                           any → cancelled
 *   PATCH  /:id/approve   Convenience shortcut: directly approve a submitted task
 */

const router = Router();
router.use(authenticate);

// ── Appraisal (before /:id to avoid param collision) ─────────────
router.get('/analytics/leaderboard',       authorize('ceo', 'supervisor'), getTaskLeaderboard);
router.get('/analytics/appraisal/:userId', getUserAppraisal);

// ── CRUD ──────────────────────────────────────────────────────────
router.get('/',    getTasks);
// CEO/Supervisor can upload briefing files when creating a task.
// uploadToLocal.any() accepts any field name and any number of files.
router.post('/',   uploadToLocal.any(), createTask);

router.get('/:id',            getTask);
router.put('/:id',            updateTask);
router.patch('/:id/status',   updateTaskStatus);
router.patch('/:id/approve',  approveTask);
router.delete('/:id',         deleteTask);

// ── Collaboration ─────────────────────────────────────────────────
router.post('/:id/invite',                           inviteTaskCollaborator);
router.delete('/:id/collaborators/:collaboratorId',  revokeTaskCollaborator);

export default router;