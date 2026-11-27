import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  getDocumentDeletion,
  setDocumentDeletion,
} from "../controllers/settingsController";

const router = Router();
router.use(authenticate);

router.get("/document-deletion", getDocumentDeletion);
router.put("/document-deletion", setDocumentDeletion);

export default router;