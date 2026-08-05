import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { listAssets, createAsset, updateAsset, deleteAsset } from "../controllers/assetController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listAssets);
router.post("/", createAsset);
router.put("/:id", updateAsset);
router.delete("/:id", deleteAsset);

export default router;
