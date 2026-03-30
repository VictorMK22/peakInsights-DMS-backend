import { Router } from "express";
import { createShareLink, accessSharedDocument } from "../controllers/shareController";

const router = Router();

router.post("/:documentId/share", createShareLink);
router.get("/share/:token", accessSharedDocument);

export default router;