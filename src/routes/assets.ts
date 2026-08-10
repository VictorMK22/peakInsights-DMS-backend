import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  listAssets,
  createAsset,
  updateAsset,
  deleteAsset,
} from "../controllers/assetController";
import {
  makeAddAttachments,
  makeRemoveAttachment,
} from "../controllers/attachmentController";
import { Asset } from "../models/Asset";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listAssets);
router.post("/", createAsset);
router.put("/:id", updateAsset);
router.delete("/:id", deleteAsset);

router.post("/:id/attachments", uploadToLocal.any(), makeAddAttachments(Asset));
router.delete("/:id/attachments/:attachmentId", makeRemoveAttachment(Asset));

export default router;
