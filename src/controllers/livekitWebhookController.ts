import { Request, Response } from "express";
import {
  verifyWebhookEvent,
  handleLivekitWebhookEvent,
} from "../services/livekitService";

/**
 * LiveKit posts one event per room/participant/egress state change,
 * signed with our API key/secret, Content-Type "application/webhook+json"
 * (deliberately non-standard so generic JSON body-parsers skip it —
 * see the express.raw() mount for this route in app.ts, which must
 * run before the global express.json() middleware consumes the body).
 */
export const receiveLivekitWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization ?? "";
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body);

    const event = await verifyWebhookEvent(rawBody, authHeader);
    await handleLivekitWebhookEvent(event);

    res.status(200).send();
  } catch (err) {
    // A signature failure or malformed payload — never trust it, but
    // also never let it crash the process.
    console.error("LiveKit webhook rejected:", err);
    res.status(401).send();
  }
};
