import { Router } from "express";
import { authenticate, requireIctAccess } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import { resolveAttachmentUploads } from "../services/documentDirectUpload";
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
router.use(authenticate, requireIctAccess);

router.get("/", listDeployments);
router.post("/", createDeployment);
router.put("/:id", updateDeployment);

router.post(
  "/:id/attachments",
  uploadToLocal.any(),
  resolveAttachmentUploads,
  makeAddAttachments(Deployment),
);
router.delete(
  "/:id/attachments/:attachmentId",
  makeRemoveAttachment(Deployment),
);

export default router;