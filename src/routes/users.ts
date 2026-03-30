import { Router } from 'express';
import {
  registerUser,
  createUserByCEO,
  createSupervisor,
  promoteToSupervisor,
  getAllUsers,
  updateUser,
  deleteUser,
  assignUserToSupervisor,
  getMappings,
  deleteMapping,
  getPendingUsers,
  approveUser,
  rejectUser,
  demoteSupervisor,
  getMyProfile,
  updateMyProfile,
  getUserProfile,
  getNotifications,
} from '../controllers/userController';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// ─── Public ──────────────────────────────────────────────────────
// Anyone can self-register; account starts as 'pending' awaiting CEO approval.
router.post('/register', registerUser);

// ─── Authenticated ────────────────────────────────────────────────
router.use(authenticate);

// Profile (own) — any authenticated role
router.get('/profile/me',  getMyProfile);
router.put('/profile/me',  updateMyProfile);

// Notifications
router.get('/notifications', getNotifications);

// ─── CEO ONLY ─────────────────────────────────────────────────────
// All account creation routes are restricted to CEO at the router
// level. The controller also checks the role as a belt-and-suspenders
// guard. Supervisors cannot create any accounts.

router.post(
  '/create-user',
  requireRole('ceo'),   // ← enforced here — supervisors get 403
  createUserByCEO
);

router.post(
  '/supervisor',
  requireRole('ceo'),   // ← CEO only — supervisor accounts
  createSupervisor
);

router.post(
  '/assign',
  requireRole('ceo'),
  assignUserToSupervisor
);

router.get(
  '/pending',
  requireRole('ceo'),
  getPendingUsers
);

router.patch(
  '/:id/approve',
  requireRole('ceo'),
  approveUser
);

router.patch(
  '/:id/reject',
  requireRole('ceo'),
  rejectUser
);

router.patch(
  '/:id/promote',
  requireRole('ceo'),
  promoteToSupervisor
);

router.patch(
  '/:id/demote',
  requireRole('ceo'),
  demoteSupervisor
);

router.delete(
  '/mappings/:mappingId',
  requireRole('ceo'),
  deleteMapping
);

// ─── CEO + Supervisor ──────────────────────────────────────────────
router.get('/mappings', requireRole('ceo', 'supervisor'), getMappings);
router.get('/:id/profile', requireRole('ceo', 'supervisor'), getUserProfile);

// ─── CEO only (user list + update + deactivate) ───────────────────
router.get('/',      requireRole('ceo'), getAllUsers);
router.put('/:id',   requireRole('ceo'), updateUser);
router.delete('/:id', requireRole('ceo'), deleteUser);

export default router;