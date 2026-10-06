import { Router } from "express";
import { authenticate, requireIctAccess } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  listTickets,
  createTicket,
  updateTicket,
  addTicketNote,
} from "../controllers/ticketController";
import {
  makeAddAttachments,
  makeRemoveAttachment,
} from "../controllers/attachmentController";
import { Ticket } from "../models/Ticket";

const router = Router();
router.use(authenticate, requireIctAccess);

router.get("/", listTickets);
router.post("/", createTicket);
router.put("/:id", updateTicket);
router.post("/:id/notes", addTicketNote);

router.post(
  "/:id/attachments",
  uploadToLocal.any(),
  makeAddAttachments(Ticket),
);
router.delete("/:id/attachments/:attachmentId", makeRemoveAttachment(Ticket));

export default router;
