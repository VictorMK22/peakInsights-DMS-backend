import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  listKbArticles,
  getKbArticle,
  createKbArticle,
  updateKbArticle,
  deleteKbArticle,
  uploadKbImage,
} from "../controllers/kbController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listKbArticles);
router.get("/:id", getKbArticle);
router.post("/", createKbArticle);
router.put("/:id", updateKbArticle);
router.delete("/:id", deleteKbArticle);

router.post("/images", uploadToLocal.single("image"), uploadKbImage);

export default router;
