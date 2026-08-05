import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { listDeployments, createDeployment, updateDeployment } from "../controllers/deploymentController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listDeployments);
router.post("/", createDeployment);
router.put("/:id", updateDeployment);

export default router;
