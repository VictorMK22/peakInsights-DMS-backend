import { Request, Response } from "express";
import { AuthRequest } from "../types/auth";
import { canAccess } from "./clientController";
import { ClientModel } from "../models/Client";
import { ClientWhatsappMessageModel } from "../models/ClientWhatsappMessage";
import {
  sendWhatsappTextMessage,
  verifyWebhookToken,
  normalizePhone,
  resolveMediaUrl,
  whatsappIsConfigured,
} from "../services/whatsappService";

// ═══════════════════════════════════════════════════════════════
// CLIENT-FACING — GET/POST under /clients/:id/whatsapp (authenticated)
// ═══════════════════════════════════════════════════════════════

export const getClientWhatsappMessages = async (
  req: AuthRequest,
  res: Response,
) => {
  const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
  if (!ok)
    return res.status(403).json({ success: false, message: "Access denied" });
  const messages = await ClientWhatsappMessageModel.find({
    clientId: req.params.id,
  })
    .populate("authorId", "name role profilePicture")
    .sort({ timestamp: 1 })
    .lean();
  return res.json({
    success: true,
    data: { messages, configured: whatsappIsConfigured() },
  });
};

export const sendClientWhatsappMessage = async (
  req: AuthRequest,
  res: Response,
) => {
  const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
  if (!ok)
    return res.status(403).json({ success: false, message: "Access denied" });

  const client = await ClientModel.findById(req.params.id).select("phone");
  if (!client) return res.status(404).json({ success: false });
  if (!client.phone)
    return res
      .status(400)
      .json({ success: false, message: "Client has no phone number on file" });

  const { body } = req.body as { body: string };
  if (!body?.trim())
    return res
      .status(400)
      .json({ success: false, message: "Message body is required" });

  const result = await sendWhatsappTextMessage(client.phone, body.trim());

  const record = await ClientWhatsappMessageModel.create({
    clientId: req.params.id,
    authorId: req.user!.userId,
    direction: "outbound",
    body: body.trim(),
    waMessageId: result.waMessageId,
    waStatus: result.ok ? "sent" : "failed",
    waError: result.error,
    timestamp: new Date(),
  });

  const populated = await record.populate(
    "authorId",
    "name role profilePicture",
  );

  if (!result.ok) {
    // Saved so the attempt is visible in the thread, but flagged so staff
    // know the client never actually received it.
    return res.status(201).json({
      success: true,
      data: { message: populated },
      warning: result.error,
    });
  }
  return res.status(201).json({ success: true, data: { message: populated } });
};

// ═══════════════════════════════════════════════════════════════
// META WEBHOOK — public routes, NOT behind the app's authenticate
// middleware (Meta calls these directly). Mounted at /webhooks/whatsapp
// in index.ts.
// ═══════════════════════════════════════════════════════════════

/** GET — one-time handshake when you register the webhook URL in the
 *  Meta App dashboard. Must echo back hub.challenge if the verify token
 *  matches WHATSAPP_VERIFY_TOKEN. */
export const verifyWhatsappWebhook = (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && verifyWebhookToken(token)) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
};

/** POST — actual message/status events from Meta. Always respond 200
 *  quickly (per Meta's requirements) even if we can't match a client,
 *  otherwise Meta will retry and eventually disable the webhook. */
export const receiveWhatsappWebhook = async (req: Request, res: Response) => {
  res.sendStatus(200); // ack immediately

  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        // Inbound messages
        for (const msg of value.messages ?? []) {
          await handleInboundMessage(msg);
        }

        // Delivery/read receipts for messages we sent
        for (const status of value.statuses ?? []) {
          await handleStatusUpdate(status);
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook processing error:", err);
  }
};

async function handleInboundMessage(msg: any) {
  const fromPhone = normalizePhone(msg.from || "");
  if (!fromPhone) return;

  // Match the sender to a client by phone number. Stored numbers may
  // include spaces/dashes/"+", so the match is normalized in app code
  // rather than in the query itself.
  const candidates = await ClientModel.find({
    phone: { $exists: true, $ne: "" },
  }).select("phone");
  const matched = candidates.find(
    (c) => normalizePhone(c.phone || "") === fromPhone,
  );
  if (!matched) {
    console.warn(
      `WhatsApp message received from unrecognized number ${msg.from} — no matching client, dropping.`,
    );
    return;
  }

  let body = "";
  let mediaUrl: string | undefined;
  let mediaMimeType: string | undefined;

  if (msg.type === "text") {
    body = msg.text?.body ?? "";
  } else if (["image", "document", "audio", "video"].includes(msg.type)) {
    const mediaId = msg[msg.type]?.id;
    body = msg[msg.type]?.caption || `[${msg.type} received]`;
    if (mediaId) {
      const resolved = await resolveMediaUrl(mediaId);
      if (resolved) {
        mediaUrl = resolved.url;
        mediaMimeType = resolved.mimeType;
      }
    }
  } else {
    body = `[Unsupported message type: ${msg.type}]`;
  }

  // Avoid double-storing on webhook retries
  const existing = await ClientWhatsappMessageModel.findOne({
    waMessageId: msg.id,
  });
  if (existing) return;

  await ClientWhatsappMessageModel.create({
    clientId: matched._id,
    direction: "inbound",
    body,
    mediaUrl,
    mediaMimeType,
    waMessageId: msg.id,
    waStatus: "delivered",
    timestamp: msg.timestamp
      ? new Date(Number(msg.timestamp) * 1000)
      : new Date(),
  });
}

async function handleStatusUpdate(status: any) {
  if (!status?.id) return;
  const mapped =
    status.status === "delivered"
      ? "delivered"
      : status.status === "read"
        ? "read"
        : status.status === "failed"
          ? "failed"
          : undefined;
  if (!mapped) return;
  await ClientWhatsappMessageModel.updateOne(
    { waMessageId: status.id },
    { $set: { waStatus: mapped } },
  );
}
