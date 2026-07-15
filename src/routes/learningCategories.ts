import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  getLearningCategories,
  createLearningCategory,
  updateLearningCategory,
  deleteLearningCategory,
} from "../controllers/learningcategoryController";

const router = Router();

router.use(authenticate);

// Any authenticated role can browse categories.
router.get("/", getLearningCategories);

// CEO / supervisor manage the taxonomy.
router.post("/", requireRole("ceo", "supervisor"), createLearningCategory);
router.put("/:id", requireRole("ceo", "supervisor"), updateLearningCategory);
router.delete("/:id", requireRole("ceo", "supervisor"), deleteLearningCategory);

export default router;
