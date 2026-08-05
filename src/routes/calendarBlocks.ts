import { Router } from "express";
import { authenticate } from "../middleware/auth";
import {
  createCalendarBlock,
  getMyCalendarBlocks,
  deleteCalendarBlock,
} from "../controllers/calendarBlockController";

/**
 * Personal calendar blocks (out-of-office / focus time / personal
 * appointments) — how a user marks themselves unavailable so other
 * users' meeting-conflict checks pick it up.
 */

const router = Router();
router.use(authenticate);

router.get("/", getMyCalendarBlocks);
router.post("/", createCalendarBlock);
router.delete("/:id", deleteCalendarBlock);

export default router;
