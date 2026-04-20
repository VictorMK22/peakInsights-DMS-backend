import { Router } from "express"
import { authenticate } from "../middleware/auth"
import {
  createFolder,
  deleteFolderRecursive,
  getFolderActivity,
  getFolderContents,
  getRootContents,       
  moveFolder,
} from "../controllers/folderController"

const router = Router()

router.use(authenticate)

router.post("/", createFolder)

// ⚠️  /root/contents MUST come before /:folderId/contents
// If the param route is registered first, Express will treat the
// literal string "root" as a folderId and getRootContents is never reached.
router.get("/root/contents",      getRootContents)       
router.get("/:folderId/contents", getFolderContents)
router.get("/:folderId/activity", getFolderActivity)
router.put("/:folderId/move",     moveFolder)
router.delete("/:folderId",       deleteFolderRecursive)

export default router