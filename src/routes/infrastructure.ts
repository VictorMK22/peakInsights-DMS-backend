import { Router } from "express";
import { authenticate, requireIctAccess } from "../middleware/auth";
import {
  listInfra,
  createInfra,
  heartbeatInfra,
  deleteInfra,
} from "../controllers/infraController";

const router = Router();
router.use(authenticate, requireIctAccess);

router.get("/", listInfra);
router.post("/", createInfra);
router.put("/:id/heartbeat", heartbeatInfra);
router.delete("/:id", deleteInfra);

export default router;
