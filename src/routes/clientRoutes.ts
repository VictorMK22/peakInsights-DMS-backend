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
  deleteClientEmail,
  getClientDocuments,
  getAssignableEmployees,
} from "../controllers/clientController";
import {
  getClientNotes,
  createClientNote,
  deleteClientNote,
  getClientMeetings,
  createClientMeeting,
  updateClientMeeting,
  deleteClientMeeting,
  getClientCalls,
  createClientCall,
  deleteClientCall,
  getClientInvoices,
  createClientInvoice,
  updateClientInvoice,
  deleteClientInvoice,
  getClientTasks,
} from "../controllers/clientChannelsController";
import {
  getClientWhatsappMessages,
  sendClientWhatsappMessage,
} from "../controllers/clientWhatsappController";

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
// Inbound emails are no longer logged manually here — they arrive
// exclusively via Zoho sync (see services/emailSyncService.ts), which
// writes directly into ClientEmail with source: "external_sync".
router.get("/:id/emails", getClientEmails);
router.post("/:id/emails/send", uploadToLocal.any(), sendClientEmail);
router.delete("/:id/emails/:emailId", deleteClientEmail);

// WhatsApp channel (real WhatsApp Business Cloud API — see
// services/whatsappService.ts and routes/whatsappWebhook.ts for the
// public webhook Meta calls into)
router.get("/:id/whatsapp", getClientWhatsappMessages);
router.post("/:id/whatsapp/send", sendClientWhatsappMessage);

// Notes — quick running log, separate from sales-stage notes
router.get("/:id/notes", getClientNotes);
router.post("/:id/notes", createClientNote);
router.delete("/:id/notes/:noteId", deleteClientNote);

// Meetings
router.get("/:id/meetings", getClientMeetings);
router.post("/:id/meetings", createClientMeeting);
router.put("/:id/meetings/:meetingId", updateClientMeeting);
router.delete("/:id/meetings/:meetingId", deleteClientMeeting);

// Calls
router.get("/:id/calls", getClientCalls);
router.post("/:id/calls", createClientCall);
router.delete("/:id/calls/:callId", deleteClientCall);

// Invoices — lightweight reference record, not full accounting
// (uploadToLocal.any() accepts a single optional file, e.g. an invoice PDF)
router.get("/:id/invoices", getClientInvoices);
router.post("/:id/invoices", uploadToLocal.any(), createClientInvoice);
router.put("/:id/invoices/:invoiceId", updateClientInvoice);
router.delete("/:id/invoices/:invoiceId", deleteClientInvoice);

// Tasks — read-only proxy into the existing Task system, filtered to this
// client. Create/update tasks via the normal /tasks endpoints (pass
// clientId in the body to link them here).
router.get("/:id/tasks", getClientTasks);

// Linked working documents
router.get("/:id/documents", getClientDocuments);

export default router;
