import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import {
  createTask,
  getTasks,
  getTask,
  updateTask,
  updateTaskStatus,
  deleteTask,
  inviteTaskCollaborator,
  revokeTaskCollaborator,
  getTaskLeaderboard,
  getUserAppraisal,
} from '../controllers/taskController';

// ─── Tasks own TAT, efficiency, and collaboration ─────────────────
//
//  CRUD:
//    GET    /                  list tasks (role-scoped)
//    POST   /                  create / assign (CEO or Supervisor)
//    GET    /:id               get one
//    PUT    /:id               update metadata / set target
//    PATCH  /:id/status        advance status (pending→in_progress→completed)
//    DELETE /:id               delete (assigner or CEO)
//
//  Collaboration:
//    POST   /:id/invite                        invite a collaborator
//    DELETE /:id/collaborators/:collaboratorId  manually revoke access early
//    (Access is auto-revoked when task is completed or cancelled)
//
//  Appraisal:
//    GET    /analytics/leaderboard             ranked efficiency (CEO/Supervisor)
//    GET    /analytics/appraisal/:userId       individual report
//
// ─────────────────────────────────────────────────────────────────

const router = Router();
router.use(authenticate);

// ── Appraisal (before /:id to avoid param collision) ─────────────
router.get('/analytics/leaderboard',       authorize('ceo', 'supervisor'), getTaskLeaderboard);
router.get('/analytics/appraisal/:userId', getUserAppraisal);

// ── CRUD ──────────────────────────────────────────────────────────
router.get('/',              getTasks);
router.post('/',             createTask);
router.get('/:id',           getTask);
router.put('/:id',           updateTask);
router.patch('/:id/status',  updateTaskStatus);
router.delete('/:id',        deleteTask);

// ── Collaboration ─────────────────────────────────────────────────
router.post('/:id/invite',                            inviteTaskCollaborator);
router.delete('/:id/collaborators/:collaboratorId',   revokeTaskCollaborator);

export default router;