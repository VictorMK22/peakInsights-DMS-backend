import { Router } from "express";
import { authenticate } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  createClient,
  getClients,
  getClient,
  updateClient,
  deleteClient,
  assignClient,
  updateClientStage,
  getClientEmails,
  sendClientEmail,
  logInboundEmail,
  deleteClientEmail,
  getClientDocuments,
  getAssignableEmployees,
} from "../controllers/clientController";

const router = Router();
router.use(authenticate);

// Static routes BEFORE /:id
router.get("/employees", getAssignableEmployees);

// Client CRUD — CEO can create/manage any client; sales persons (BD)
// can create their own leads (see controller for the exact rule).
router.get("/", getClients);
router.post("/", createClient);
router.get("/:id", getClient);
router.put("/:id", updateClient);
router.delete("/:id", deleteClient);

// Assignment
router.post("/:id/assign", assignClient);

// Sales pipeline — In discussion / Proposal Sent / Awaiting Client
// Decision / Agreement Sent / Won / Lost, with a note per change.
router.patch("/:id/stage", updateClientStage);

// Email channel — uploadToLocal.any() accepts optional file attachments
// under any field name (e.g. "attachments") alongside subject/body.
router.get("/:id/emails", getClientEmails);
router.post("/:id/emails/send", uploadToLocal.any(), sendClientEmail);
router.post("/:id/emails/log-inbound", logInboundEmail);
router.delete("/:id/emails/:emailId", deleteClientEmail);

// Linked working documents
router.get("/:id/documents", getClientDocuments);

export default router;
