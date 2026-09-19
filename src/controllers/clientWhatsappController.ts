import { Request, Response } from "express";
import { AuthRequest } from "../types/auth";
import { canAccess } from "./clientController";
import { ClientModel } from "../models/Client";
import { ClientWhatsappMessageModel } from "../models/ClientWhatsappMessage";
import {
  sendWhatsappTextMessage,
  verifyWebhookToken,
  verifyWebhookSignature,
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
// EDIT / DELETE / RESEND — CRUD on our own local record of a message.
//
// Important limitation: WhatsApp's Business Cloud API has no endpoint
// to edit or recall a message that has already left our server (no
// "edit sent message" call exists in the Graph API, and Meta doesn't
// support us deleting it off the recipient's device either). So:
//   - Editing is only allowed for a message that never actually
//     reached the client (queued/failed) — you're correcting a draft
//     before it goes out, not rewriting something already delivered.
//   - Resending re-sends the (possibly just-edited) body as a brand
//     new WhatsApp send for a failed attempt.
//   - Deleting always just removes our own record of the message —
//     it does not, and cannot, delete it from the client's phone if
//     it was actually delivered. The UI should make that clear.
// ═══════════════════════════════════════════════════════════════

const canManageOwnMessage = (
  message: { authorId?: unknown; direction: string },
  userId: string,
  role: string,
) => {
  if (role === "ceo" || role === "tech") return true;
  if (message.direction !== "outbound") return false;
  const authorId =
    message.authorId &&
    typeof message.authorId === "object" &&
    "_id" in (message.authorId as any)
      ? String((message.authorId as any)._id)
      : String(message.authorId ?? "");
  return authorId === userId;
};

/** PATCH /clients/:id/whatsapp/:messageId — edit the body of a message
 *  that hasn't been delivered yet (queued or failed). */
export const editClientWhatsappMessage = async (
  req: AuthRequest,
  res: Response,
) => {
  const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
  if (!ok)
    return res.status(403).json({ success: false, message: "Access denied" });

  const message = await ClientWhatsappMessageModel.findOne({
    _id: req.params.messageId,
    clientId: req.params.id,
  });
  if (!message)
    return res
      .status(404)
      .json({ success: false, message: "Message not found" });

  if (!canManageOwnMessage(message, req.user!.userId, req.user!.role)) {
    return res.status(403).json({
      success: false,
      message: "You can only edit your own messages",
    });
  }
  if (!["queued", "failed"].includes(message.waStatus)) {
    return res.status(409).json({
      success: false,
      message:
        "This message was already sent to WhatsApp and can't be edited — delete it instead if it's wrong",
    });
  }

  const { body } = req.body as { body: string };
  if (!body?.trim())
    return res
      .status(400)
      .json({ success: false, message: "Message body is required" });

  message.body = body.trim();
  await message.save();

  const populated = await message.populate(
    "authorId",
    "name role profilePicture",
  );
  return res.json({ success: true, data: { message: populated } });
};

/** POST /clients/:id/whatsapp/:messageId/resend — re-send a failed
 *  outbound message (using its current, possibly just-edited, body). */
export const resendClientWhatsappMessage = async (
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

  const message = await ClientWhatsappMessageModel.findOne({
    _id: req.params.messageId,
    clientId: req.params.id,
  });
  if (!message)
    return res
      .status(404)
      .json({ success: false, message: "Message not found" });

  if (!canManageOwnMessage(message, req.user!.userId, req.user!.role)) {
    return res.status(403).json({
      success: false,
      message: "You can only resend your own messages",
    });
  }
  if (message.direction !== "outbound" || message.waStatus !== "failed") {
    return res.status(409).json({
      success: false,
      message: "Only a failed outbound message can be resent",
    });
  }

  const result = await sendWhatsappTextMessage(client.phone, message.body);

  message.waMessageId = result.waMessageId;
  message.waStatus = result.ok ? "sent" : "failed";
  message.waError = result.error;
  message.timestamp = new Date();
  await message.save();

  const populated = await message.populate(
    "authorId",
    "name role profilePicture",
  );

  if (!result.ok) {
    return res.json({
      success: true,
      data: { message: populated },
      warning: result.error,
    });
  }
  return res.json({ success: true, data: { message: populated } });
};

/** DELETE /clients/:id/whatsapp/:messageId — removes our own record of
 *  the message. Does not (and cannot) recall it on the client's phone
 *  if it was actually delivered — see the module note above. */
export const deleteClientWhatsappMessage = async (
  req: AuthRequest,
  res: Response,
) => {
  const ok = await canAccess(req.params.id, req.user!.userId, req.user!.role);
  if (!ok)
    return res.status(403).json({ success: false, message: "Access denied" });

  const message = await ClientWhatsappMessageModel.findOne({
    _id: req.params.messageId,
    clientId: req.params.id,
  });
  if (!message)
    return res
      .status(404)
      .json({ success: false, message: "Message not found" });

  if (!canManageOwnMessage(message, req.user!.userId, req.user!.role)) {
    return res.status(403).json({
      success: false,
      message: "You can only delete your own messages",
    });
  }

  await message.deleteOne();
  return res.json({ success: true, message: "Message deleted" });
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

/**
 * POST — actual message/status events from Meta.
 *
 * Signature check happens FIRST, before the 200 ack: a request that
 * fails HMAC verification did not come from Meta (or the App Secret is
 * misconfigured), so there's no "avoid Meta's retry/disable" concern —
 * it's simply rejected. Once the signature is confirmed, we ack 200
 * immediately per Meta's requirements and process the payload after,
 * so a slow DB write never causes Meta to see a timeout and retry.
 */
export const receiveWhatsappWebhook = async (req: Request, res: Response) => {
  const signatureOk = verifyWebhookSignature(
    (req as any).rawBody,
    req.header("x-hub-signature-256"),
  );
  if (!signatureOk) {
    console.warn("WhatsApp webhook: rejected request with invalid signature");
    res.sendStatus(401);
    return;
  }

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
    // Never log err.config/headers here — could contain the access
    // token on an axios error bubbled up from elsewhere in the chain.
    console.error(
      "WhatsApp webhook processing error:",
      err instanceof Error ? err.message : err,
    );
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
  let metadata: Record<string, unknown> | undefined;
  // Normalized to one of the model's messageType values below —
  // covers every inbound type Meta's Cloud API can send.
  const messageType: string = msg.type || "unknown";

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
  } else if (msg.type === "location") {
    const loc = msg.location ?? {};
    body = loc.name || loc.address || "[Location shared]";
    metadata = {
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.name,
      address: loc.address,
    };
  } else if (msg.type === "contacts") {
    const names = (msg.contacts ?? [])
      .map((c: any) => c?.name?.formatted_name)
      .filter(Boolean);
    body = names.length
      ? `[Contact shared: ${names.join(", ")}]`
      : "[Contact shared]";
    metadata = { contacts: msg.contacts };
  } else if (msg.type === "button") {
    // Reply to a template's quick-reply button.
    body = msg.button?.text || "[Button reply]";
    metadata = { payload: msg.button?.payload, text: msg.button?.text };
  } else if (msg.type === "interactive") {
    // Reply to a list picker or reply-button message we sent.
    const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
    body = reply?.title || "[Interactive reply]";
    metadata = {
      interactiveType: msg.interactive?.type,
      id: reply?.id,
      title: reply?.title,
      description: reply?.description,
    };
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
    messageType,
    body,
    mediaUrl,
    mediaMimeType,
    metadata,
    waMessageId: msg.id,
    waStatus: "delivered",
    timestamp: msg.timestamp
      ? new Date(Number(msg.timestamp) * 1000)
      : new Date(),
  });
}

async function handleStatusUpdate(status: any) {
  if (!status?.id) return;
  const mapped = (["sent", "delivered", "read", "failed"] as const).includes(
    status.status,
  )
    ? (status.status as "sent" | "delivered" | "read" | "failed")
    : undefined;
  if (!mapped) return;

  const update: Record<string, unknown> = { waStatus: mapped };
  if (mapped === "failed") {
    // Meta's failure detail lives under errors[0], not a flat field.
    const reason = status.errors?.[0]?.message || status.errors?.[0]?.title;
    if (reason) update.waError = reason;
  }
  await ClientWhatsappMessageModel.updateOne(
    { waMessageId: status.id },
    { $set: update },
  );
}
