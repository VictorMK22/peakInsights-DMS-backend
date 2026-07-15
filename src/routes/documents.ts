import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  createDocument,
  checkDuplicateFilenames,
  getDocuments,
  getDocumentTypeCounts,
  getDocument,
  updateDocument,
  deleteDocument,
  restoreDocument,
  permanentlyDeleteDocument,
  toggleStarDocument,
  copyDocument,
  bulkDeleteDocuments,
  patchDocumentContent,
  replaceFile,
  createComment,
  getComments,
  updateComment,
  deleteComment,
  markDocumentRead,
  getDocumentReaders,
  previewDocument,
  downloadDocument,
  moveDocument,
  getDocumentActivity,
} from "../controllers/documentController";

const router = Router();
router.use(authenticate);

// ── Document ──────────────────────────────────────────────────────
router.get("/", getDocuments);
router.post("/", uploadToLocal.any(), createDocument);
router.post("/check-duplicates", checkDuplicateFilenames);
// Must be registered before /:id so "type-counts" isn't consumed by it.
router.get("/type-counts", getDocumentTypeCounts);
// Same reason — must come before /:id, and POST (not DELETE) so the
// browser/axios can send a JSON body listing the ids to remove.
router.post("/bulk-delete", bulkDeleteDocuments);

router.get("/:id", getDocument);
router.put("/:id", updateDocument);
router.patch("/:id/content", patchDocumentContent);
// Delete = move to Trash. Restore/permanent-delete are the other two
// legs of the same Drive-style lifecycle.
router.delete("/:id", deleteDocument);
router.post("/:id/restore", restoreDocument);
router.delete("/:id/permanent", permanentlyDeleteDocument);
router.patch("/:id/star", toggleStarDocument);
router.post("/:id/copy", copyDocument);

// ── Replace file (no versioning) ─────────────────────────────────
router.post("/:id/replace", uploadToLocal.single("file"), replaceFile);

// ── Comments ──────────────────────────────────────────────────────
router.post("/:id/comments", createComment);
router.get("/:id/comments", getComments);
router.put("/:id/comments/:commentId", updateComment);
router.delete("/:id/comments/:commentId", deleteComment);

// ── Read receipts ────────────────────────────────────────────────
router.post("/:id/read", markDocumentRead);
router.get("/:id/reads", getDocumentReaders);

// ── Utility ───────────────────────────────────────────────────────
router.get("/:id/preview", previewDocument);
router.get("/:id/download", downloadDocument);
router.put("/:id/move", moveDocument);
router.get("/:id/activity", getDocumentActivity);

export default router;
