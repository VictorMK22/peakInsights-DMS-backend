import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate, requireIctAccess } from "../middleware/auth";
import { screenshotUpload } from "../middleware/screenshotUpload";
import {
  createUserReport,
  listMine,
  listAll,
  getReport,
  addComment,
  updateReport,
  reportClientError,
  tryAuthenticate,
} from "../controllers/errorReportController";
import { AuthRequest } from "../types/auth";

const router = Router();

// Browser crash intake. Can fire before login, so it is limited per IP.
const clientErrorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many error reports." },
});

// One person can't flood the tech supervisor's inbox.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).user?.userId ?? req.ip ?? "anon",
  message: {
    success: false,
    message: "You've sent a lot of reports in the last hour. Please try again later.",
  },
});

router.post("/client", clientErrorLimiter, tryAuthenticate, reportClientError);

router.use(authenticate);

// Order matters: fixed paths before "/:id".
router.get("/mine", listMine);
router.post("/", submitLimiter, ...screenshotUpload, createUserReport);
router.get("/", requireIctAccess, listAll);
router.get("/:id", getReport);
router.post("/:id/comments", submitLimiter, ...screenshotUpload, addComment);
router.patch("/:id", requireIctAccess, updateReport);

export default router;