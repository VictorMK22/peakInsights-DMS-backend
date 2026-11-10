import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { authenticate } from "../middleware/auth";
import { uploadToLocal } from "../middleware/upload";
import {
  createClient,
  importClients,
  downloadClientImportTemplate,
  getClients,
  getClient,
  updateClient,
  deleteClient,
  assignClient,
  getAwaitingAllocation,
  allocateAccountant,
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
  getClientScheduledMeetings,
  getClientMeetingActivityFeed,
  getClientCalls,
  createClientCall,
  deleteClientCall,
  getClientTasks,
} from "../controllers/clientChannelsController";
import {
  getClientWhatsappMessages,
  sendClientWhatsappMessage,
  editClientWhatsappMessage,
  resendClientWhatsappMessage,
  deleteClientWhatsappMessage,
} from "../controllers/clientWhatsappController";

const router = Router();

// Spreadsheet imports are parsed in memory and never stored, so this uses
// its own small multer instance instead of uploadToLocal (which pushes
// every file to S3).
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5 MB, single file
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    if (ok) cb(null, true);
    else cb(new Error("Only .xlsx, .xls or .csv files are allowed"));
  },
});
const handleImportUpload = (req: Request, res: Response, next: NextFunction) =>
  importUpload.single("file")(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({
        success: false,
        message:
          (err as any).code === "LIMIT_FILE_SIZE"
            ? "File is too large (max 5 MB)"
            : (err as Error).message,
      });
      return;
    }
    next();
  });
router.use(authenticate);

// Static routes BEFORE /:id
router.get("/employees", getAssignableEmployees);
router.get("/awaiting-allocation", getAwaitingAllocation);
router.get("/import/template", downloadClientImportTemplate);
router.post("/import", handleImportUpload, importClients);

// Client CRUD — CEO can create/manage any client; sales persons (BD)
// can create their own leads (see controller for the exact rule).
router.get("/", getClients);
router.post("/", createClient);
router.get("/:id", getClient);
router.put("/:id", updateClient);
router.delete("/:id", deleteClient);

// Assignment
router.post("/:id/assign", assignClient);
router.post("/:id/allocate-accountant", allocateAccountant);

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
router.patch("/:id/whatsapp/:messageId", editClientWhatsappMessage);
router.post("/:id/whatsapp/:messageId/resend", resendClientWhatsappMessage);
router.delete("/:id/whatsapp/:messageId", deleteClientWhatsappMessage);

// Notes — quick running log, separate from sales-stage notes
router.get("/:id/notes", getClientNotes);
router.post("/:id/notes", createClientNote);
router.delete("/:id/notes/:noteId", deleteClientNote);

// Meetings
// "/meetings" = manual log (informal, off-system meetings)
// "/meetings/scheduled" = auto-synced from the Meeting & Calendar module
// "/meetings/activity" = automatic lifecycle activity trail
router.get("/:id/meetings", getClientMeetings);
router.post("/:id/meetings", createClientMeeting);
router.put("/:id/meetings/:meetingId", updateClientMeeting);
router.delete("/:id/meetings/:meetingId", deleteClientMeeting);
router.get("/:id/meetings/scheduled", getClientScheduledMeetings);
router.get("/:id/meetings/activity", getClientMeetingActivityFeed);

// Calls
router.get("/:id/calls", getClientCalls);
router.post("/:id/calls", createClientCall);
router.delete("/:id/calls/:callId", deleteClientCall);

// Tasks — read-only proxy into the existing Task system, filtered to this
// client. Create/update tasks via the normal /tasks endpoints (pass
// clientId in the body to link them here).
router.get("/:id/tasks", getClientTasks);

// Linked working documents
router.get("/:id/documents", getClientDocuments);

export default router;