import { Router } from "express"
import { authenticate } from "../middleware/auth"
import {
  createFolder,
  deleteFolderRecursive,
  getFolderActivity,
  getFolderContents,
  moveFolder
} from "../controllers/folderController"

const router = Router()

router.use(authenticate)

router.post("/", createFolder)

router.get("/:folderId/contents", getFolderContents)
router.put('/:folderId/move', moveFolder);
router.get('/:folderId/activity', getFolderActivity);
router.delete('/:folderId', deleteFolderRecursive);

export default router