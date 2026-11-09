import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { heartbeat, getOnline } from "../controllers/presenceController";

const router = Router();
router.use(authenticate);

router.post("/heartbeat", heartbeat);
router.get("/online", getOnline);

export default router;