import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { seedIctDemoData } from "../controllers/ictSeedController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.post("/", seedIctDemoData);

export default router;
