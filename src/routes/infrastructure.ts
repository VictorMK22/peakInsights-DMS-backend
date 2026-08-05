import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { listInfra, createInfra, heartbeatInfra, deleteInfra } from "../controllers/infraController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listInfra);
router.post("/", createInfra);
router.put("/:id/heartbeat", heartbeatInfra);
router.delete("/:id", deleteInfra);

export default router;
