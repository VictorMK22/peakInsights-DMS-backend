import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { listSystems, createSystem, updateSystemStatus, restartSystem } from "../controllers/systemController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listSystems);
router.post("/", createSystem);
router.put("/:id", updateSystemStatus);
router.post("/:id/restart", restartSystem);

export default router;
