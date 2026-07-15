import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  getSharedDocumentInfo,
  accessSharedDocument,
} from "../controllers/shareController";

const router = Router();

// Management endpoints — require auth, ownership checked in the controller.
router.post("/documents/:documentId/share", authenticate, createShareLink);
router.get("/documents/:documentId/share", authenticate, listShareLinks);
router.delete("/share-links/:linkId", authenticate, revokeShareLink);

// Public access — intentionally NOT behind authenticate. The token
// itself is the credential; see accessSharedDocument for validation.
router.get("/share/:token/info", getSharedDocumentInfo);
router.get("/share/:token", accessSharedDocument);

export default router;
