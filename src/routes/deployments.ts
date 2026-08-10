import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  listDeployments,
  createDeployment,
  updateDeployment,
} from "../controllers/deploymentController";
import {
  makeAddAttachments,
  makeRemoveAttachment,
} from "../controllers/attachmentController";
import { Deployment } from "../models/Deployment";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listDeployments);
router.post("/", createDeployment);
router.put("/:id", updateDeployment);

router.post(
  "/:id/attachments",
  uploadToLocal.any(),
  makeAddAttachments(Deployment),
);
router.delete(
  "/:id/attachments/:attachmentId",
  makeRemoveAttachment(Deployment),
);

export default router;
