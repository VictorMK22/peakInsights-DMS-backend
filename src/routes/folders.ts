import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createFolder,
  deleteFolderRecursive,
  restoreFolder,
  permanentlyDeleteFolder,
  toggleStarFolder,
  copyFolder,
  bulkDeleteFolders,
  getFolderActivity,
  getFolderContents,
  getRootContents,
  getStarredFolders,
  moveFolder,
  updateFolder,
} from "../controllers/folderController";

const router = Router();

router.use(authenticate);

router.post("/", createFolder);
// POST (not DELETE) so the client can send a JSON body listing the
// folder ids to remove. Registered here alongside the other
// non-param POST route, ahead of the /:folderId group below.
router.post("/bulk-delete", bulkDeleteFolders);

// ⚠️  /root/contents and /starred/list MUST come before /:folderId/contents
// If the param route is registered first, Express will treat the
// literal string as a folderId and these handlers are never reached.
router.get("/root/contents", getRootContents);
router.get("/starred/list", getStarredFolders);
router.get("/:folderId/contents", getFolderContents);
router.get("/:folderId/activity", getFolderActivity);
router.put("/:folderId/move", moveFolder);
router.put("/:folderId", updateFolder);
// Delete = move to Trash (cascades to everything inside). Restore
// and permanent-delete are the other two legs of that lifecycle.
router.delete("/:folderId", deleteFolderRecursive);
router.post("/:folderId/restore", restoreFolder);
router.delete("/:folderId/permanent", permanentlyDeleteFolder);
router.patch("/:folderId/star", toggleStarFolder);
router.post("/:folderId/copy", copyFolder);

export default router;
