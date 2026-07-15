import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { getTrash, emptyTrash } from "../controllers/trashController";

const router = Router();
router.use(authenticate);

router.get("/", getTrash);
router.post("/empty", emptyTrash);

export default router;
