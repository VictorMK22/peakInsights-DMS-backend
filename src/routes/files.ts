import { Router } from "express";
import { serveFile } from "../controllers/fileController";

const router = Router();

// Intentionally public (no `authenticate`) — the signed token in the
// query string is the actual credential. See fileController for
// validation and serveFile's doc comment for why this replaced the
// old unauthenticated express.static mount.
router.get("/:fileKey", serveFile);

export default router;
