import { Router } from "express";
import { searchDocuments } from "../controllers/searchController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.get("/", authenticate, searchDocuments);

export default router;