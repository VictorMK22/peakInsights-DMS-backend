import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { uploadToLocal } from '../middleware/upload';
import {
  // Document CRUD
  createDocument,
  getDocuments,
  getDocument,
  updateDocument,
  deleteDocument,
  patchDocumentContent,
  // Version CRUD
  uploadNewVersion,
  getVersions,
  restoreVersion,
  deleteVersion,
  // Comment CRUD
  createComment,
  getComments,
  updateComment,
  deleteComment,
  // Utility
  previewDocument,
  downloadDocument,
  moveDocument,
  getDocumentActivity,
} from '../controllers/documentController';

/**
 * Documents = pure file storage.
 *
 * No TAT, no efficiency, no status workflow, no supervisor approval,
 * no collaborators. All of those belong to /api/tasks.
 *
 * Full CRUD on three dimensions:
 *
 *  1. Document (metadata + file)
 *     POST   /                     upload (single / multi / folder)
 *     GET    /                     list (role-scoped)
 *     GET    /:id                  get one
 *     PUT    /:id                  update metadata (title, desc, tags…)
 *     PATCH  /:id/content          save inline text (Yjs / editor)
 *     DELETE /:id                  delete document + all files
 *
 *  2. File versions (content history)
 *     POST   /:id/versions                        upload new version
 *     GET    /:id/versions                        list all versions
 *     PATCH  /:id/versions/:versionNumber/restore restore older version
 *     DELETE /:id/versions/:versionNumber         delete a version
 *
 *  3. Comments (discussion on the document)
 *     POST   /:id/comments              add a comment
 *     GET    /:id/comments              list all comments
 *     PUT    /:id/comments/:commentId   edit own comment
 *     DELETE /:id/comments/:commentId   delete comment (author / owner / CEO)
 *
 *  Utility:
 *     GET    /:id/preview   DOCX→HTML or file URL for browser rendering
 *     GET    /:id/download  stream file as attachment
 *     PUT    /:id/move      move into a folder
 *     GET    /:id/activity  audit log entries for this document
 */

const router = Router();
router.use(authenticate);

// ── Document ──────────────────────────────────────────────────────
router.get('/',  getDocuments);
router.post('/', uploadToLocal.any(), createDocument);

router.get('/:id',            getDocument);
router.put('/:id',            updateDocument);
router.patch('/:id/content',  patchDocumentContent);
router.delete('/:id',         deleteDocument);

// ── Versions ──────────────────────────────────────────────────────
router.post('/:id/versions',                          uploadToLocal.single('file'), uploadNewVersion);
router.get('/:id/versions',                           getVersions);
router.patch('/:id/versions/:versionNumber/restore',  restoreVersion);
router.delete('/:id/versions/:versionNumber',         deleteVersion);

// ── Comments ──────────────────────────────────────────────────────
router.post('/:id/comments',              createComment);
router.get('/:id/comments',               getComments);
router.put('/:id/comments/:commentId',    updateComment);
router.delete('/:id/comments/:commentId', deleteComment);

// ── Utility ───────────────────────────────────────────────────────
router.get('/:id/preview',   previewDocument);
router.get('/:id/download',  downloadDocument);
router.put('/:id/move',      moveDocument);
router.get('/:id/activity',  getDocumentActivity);

export default router;