import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listProjectTasks,
  createProjectTask,
  updateProjectTask,
  deleteProjectTask,
} from "../controllers/projectController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listProjects);
router.post("/", createProject);
router.put("/:id", updateProject);
router.delete("/:id", deleteProject);

router.get("/tasks/all", listProjectTasks);
router.post("/tasks", createProjectTask);
router.put("/tasks/:id", updateProjectTask);
router.delete("/tasks/:id", deleteProjectTask);

export default router;
