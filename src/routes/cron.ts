import { Router } from "express";
import { requireCronSecret } from "../middleware/cronAuth";
import {
  runEmailSync,
  runDocumentRetrySweep,
} from "../controllers/cronController";

const router = Router();
router.use(requireCronSecret);

router.post("/sync-emails", runEmailSync);
router.post("/process-documents", runDocumentRetrySweep);

export default router;
