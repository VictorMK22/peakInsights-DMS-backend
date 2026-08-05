import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import {
  listKbArticles,
  getKbArticle,
  createKbArticle,
  updateKbArticle,
  deleteKbArticle,
} from "../controllers/kbController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listKbArticles);
router.get("/:id", getKbArticle);
router.post("/", createKbArticle);
router.put("/:id", updateKbArticle);
router.delete("/:id", deleteKbArticle);

export default router;
