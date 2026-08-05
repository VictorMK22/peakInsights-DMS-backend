import { Router } from "express";
import { authenticate, requireRole } from "../middleware/auth";
import { listTickets, createTicket, updateTicket, addTicketNote } from "../controllers/ticketController";

const router = Router();
router.use(authenticate, requireRole("ceo", "tech"));

router.get("/", listTickets);
router.post("/", createTicket);
router.put("/:id", updateTicket);
router.post("/:id/notes", addTicketNote);

export default router;
