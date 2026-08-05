import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  getLearningCategories,
  createLearningCategory,
  updateLearningCategory,
  deleteLearningCategory,
} from "../controllers/learningCategoryController";

const router = Router();

router.use(authenticate);

// Any authenticated role can browse categories.
router.get("/", getLearningCategories);

// CEO / supervisor manage the taxonomy.
router.post(
  "/",
  requireRole("ceo", "tech", "supervisor"),
  createLearningCategory,
);
router.put(
  "/:id",
  requireRole("ceo", "tech", "supervisor"),
  updateLearningCategory,
);
router.delete(
  "/:id",
  requireRole("ceo", "tech", "supervisor"),
  deleteLearningCategory,
);

export default router;
