import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  listSprints,
  createSprint,
  updateSprint,
  deleteSprint,
  getSprintSummary,
} from "../controllers/sprintController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listSprints);
router.post("/", createSprint);
router.put("/:id", updateSprint);
router.delete("/:id", deleteSprint);
router.get("/:id/summary", getSprintSummary);

export default router;
