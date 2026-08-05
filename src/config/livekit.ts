import {
  RoomServiceClient,
  WebhookReceiver,
  EgressClient,
} from "livekit-server-sdk";

/**
 * LiveKit config.
 *
 * LiveKit Cloud (or a self-hosted LiveKit server) is the actual media
 * server — this app never touches raw WebRTC/SFU traffic itself,
 * which is what makes video conferencing workable from Vercel
 * serverless functions in the first place. This module only talks to
 * LiveKit's control-plane REST API (room create/delete, egress) and
 * mints short-lived participant access tokens; the browser client
 * connects directly to LIVEKIT_URL over WebSocket for the actual
 * call.
 *
 * Required env vars:
 *   LIVEKIT_API_KEY
 *   LIVEKIT_API_SECRET
 *   LIVEKIT_URL          wss://<project>.livekit.cloud (or self-hosted)
 */

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const wsUrl = process.env.LIVEKIT_URL;

export const isLivekitConfigured = Boolean(apiKey && apiSecret && wsUrl);

// RoomServiceClient wants an http(s) URL, not the wss:// one the
// frontend/browser SDK uses to actually join the room.
const restUrl = wsUrl?.replace(/^ws/, "http");

let _roomService: RoomServiceClient | null = null;
let _webhookReceiver: WebhookReceiver | null = null;
let _egressClient: EgressClient | null = null;

export const getRoomService = (): RoomServiceClient => {
  if (!isLivekitConfigured) {
    throw new Error(
      "LiveKit is not configured — set LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL",
    );
  }
  if (!_roomService) {
    _roomService = new RoomServiceClient(restUrl!, apiKey!, apiSecret!);
  }
  return _roomService;
};

export const getEgressClient = (): EgressClient => {
  if (!isLivekitConfigured) {
    throw new Error(
      "LiveKit is not configured — set LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL",
    );
  }
  if (!_egressClient) {
    _egressClient = new EgressClient(restUrl!, apiKey!, apiSecret!);
  }
  return _egressClient;
};

export const getWebhookReceiver = (): WebhookReceiver => {
  if (!isLivekitConfigured) {
    throw new Error(
      "LiveKit is not configured — set LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL",
    );
  }
  if (!_webhookReceiver) {
    _webhookReceiver = new WebhookReceiver(apiKey!, apiSecret!);
  }
  return _webhookReceiver;
};

export const livekitEnv = {
  get apiKey() {
    return apiKey;
  },
  get apiSecret() {
    return apiSecret;
  },
  get wsUrl() {
    return wsUrl;
  },
};
