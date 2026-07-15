import { Router } from "express";
import {
  createUserByCEO,
  createSupervisor,
  createSalesPerson,
  promoteToSupervisor,
  getAllUsers,
  updateUser,
  deleteUser,
  permanentlyDeleteUser,
  assignUserToSupervisor,
  getMappings,
  deleteMapping,
  demoteSupervisor,
  getMyProfile,
  updateMyProfile,
  getUserProfile,
  getNotifications,
  getMyTeammates,
} from "../controllers/userController";
import { authenticate, requireRole } from "../middleware/auth";

const router = Router();

// ─── No public registration ────────────────────────────────────────
// Account creation is CEO-only by design — there is no self-service
// sign-up. Every route below requires authentication.
router.use(authenticate);

// Profile (own) — any authenticated role
router.get("/profile/me", getMyProfile);
router.put("/profile/me", updateMyProfile);

// Notifications
router.get("/notifications", getNotifications);

// Teammates (peers under the same supervisor) — used by the task
// collaboration "invite" picker. Any authenticated role can call this.
router.get("/teammates", getMyTeammates);

// ─── CEO ONLY ─────────────────────────────────────────────────────
// All account creation routes are restricted to CEO at the router
// level. The controller also checks the role as a belt-and-suspenders
// guard. Supervisors cannot create any accounts.

router.post(
  "/create-user",
  requireRole("ceo"), // ← enforced here — supervisors get 403
  createUserByCEO,
);

router.post(
  "/supervisor",
  requireRole("ceo"), // ← CEO only — supervisor accounts
  createSupervisor,
);

router.post(
  "/sales-person",
  requireRole("ceo"), // ← CEO only — sales / BD accounts
  createSalesPerson,
);

router.post("/assign", requireRole("ceo"), assignUserToSupervisor);

router.patch("/:id/promote", requireRole("ceo"), promoteToSupervisor);

router.patch("/:id/demote", requireRole("ceo"), demoteSupervisor);

router.delete("/mappings/:mappingId", requireRole("ceo"), deleteMapping);

// ─── CEO + Supervisor ──────────────────────────────────────────────
router.get("/mappings", requireRole("ceo", "supervisor"), getMappings);
router.get("/:id/profile", requireRole("ceo", "supervisor"), getUserProfile);

// ─── CEO only (user list + update + deactivate) ───────────────────
router.get("/", requireRole("ceo"), getAllUsers);
router.put("/:id", requireRole("ceo"), updateUser);
router.delete("/:id", requireRole("ceo"), deleteUser);
// Separate path from the deactivate route above — deliberately not the
// same DELETE /:id, so a permanent delete can never happen by accident
// via the wrong verb/route pairing. Irreversible, so it gets its own
// explicit endpoint the frontend has to opt into.
router.delete("/:id/permanent", requireRole("ceo"), permanentlyDeleteUser);

export default router;
