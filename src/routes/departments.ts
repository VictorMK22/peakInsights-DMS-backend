import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  createDepartment,
  getAllDepartments,
  updateDepartment,
  deleteDepartment,
} from "../controllers/departmentController";

const router = Router();

router.use(authenticate);

// Any authenticated role can read the list — used to populate
// department dropdowns across the app (create user, assign, profile).
router.get("/", getAllDepartments);

// CEO only — management actions.
router.post("/", requireRole("ceo"), createDepartment);
router.put("/:id", requireRole("ceo"), updateDepartment);
router.delete("/:id", requireRole("ceo"), deleteDepartment);

export default router;
