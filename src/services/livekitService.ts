import {
  AccessToken,
  RoomServiceClient,
  WebhookEvent,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from "livekit-server-sdk";
import mongoose from "mongoose";
import {
  getRoomService,
  getEgressClient,
  getWebhookReceiver,
  livekitEnv,
} from "../config/livekit";
import { MeetingModel } from "../models/Meeting";
import { MeetingAttendanceModel } from "../models/MeetingAttendance";
import { logMeetingActivity } from "./meetingActivityService";
import { BUCKET, isS3Configured } from "./s3Storage";

/**
 * Meeting <-> LiveKit room mapping, token minting, and the webhook
 * handler that turns LiveKit's room/participant events into the
 * automatic attendance + activity records the spec calls for (no one
 * should ever have to manually record who joined a call or for how
 * long).
 *
 * Room lifecycle:
 *   - roomNameFor(meetingId) is deterministic, so the room always
 *     exists conceptually the moment the Meeting document does —
 *     nothing extra to create at schedule time.
 *   - The room is only actually provisioned on LiveKit's side lazily,
 *     the first time someone requests a join token (ensureRoom), and
 *     torn down when the meeting is cancelled.
 *   - LiveKit itself closes an empty room automatically after
 *     emptyTimeout, so nothing needs to "end" it on our side.
 */

export const roomNameFor = (meetingId: string | mongoose.Types.ObjectId) =>
  `meeting-${String(meetingId)}`;

/**
 * Idempotently makes sure the LiveKit room exists with the right
 * config (recording flag driven off the Meeting document). Safe to
 * call on every join-token request — createRoom on an existing room
 * just returns it.
 */
export const ensureRoom = async (params: {
  meetingId: string | mongoose.Types.ObjectId;
  title: string;
  recordingEnabled?: boolean;
}): Promise<string> => {
  const roomService: RoomServiceClient = getRoomService();
  const name = roomNameFor(params.meetingId);
  await roomService.createRoom({
    name,
    // Auto-closes the room if it sits empty this long — covers both
    // "nobody ever joined" and "everyone left" cases, since LiveKit
    // resets this timer whenever the room becomes empty.
    emptyTimeout: 10 * 60,
    departureTimeout: 20,
    metadata: JSON.stringify({
      meetingId: String(params.meetingId),
      title: params.title,
      recordingEnabled: Boolean(params.recordingEnabled),
    }),
  });
  return name;
};

/** Deletes the LiveKit room (best-effort — used when a meeting is cancelled). */
export const deleteRoom = async (
  meetingId: string | mongoose.Types.ObjectId,
) => {
  try {
    await getRoomService().deleteRoom(roomNameFor(meetingId));
  } catch (err) {
    // Room may never have been provisioned (nobody joined yet) — not an error.
    console.error("livekitService.deleteRoom:", err);
  }
};

export type MeetingParticipantGrant = {
  meetingId: string | mongoose.Types.ObjectId;
  identity: string; // stable per-user id — the app's userId for internal users
  name: string;
  isHost: boolean; // organizer gets room admin + recording controls
};

/**
 * Mints a short-lived LiveKit access token for one participant to
 * join one meeting's room. This is what the frontend exchanges for a
 * live WebSocket connection to LIVEKIT_URL — the browser never talks
 * to our API again once it has this.
 */
export const createParticipantToken = async (
  params: MeetingParticipantGrant,
): Promise<{ token: string; wsUrl: string; roomName: string }> => {
  if (!livekitEnv.apiKey || !livekitEnv.apiSecret || !livekitEnv.wsUrl) {
    throw new Error(
      "LiveKit is not configured — set LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL",
    );
  }
  const roomName = roomNameFor(params.meetingId);

  const at = new AccessToken(livekitEnv.apiKey, livekitEnv.apiSecret, {
    identity: params.identity,
    name: params.name,
    ttl: "4h",
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    roomAdmin: params.isHost,
    roomRecord: params.isHost,
  });

  return { token: await at.toJwt(), wsUrl: livekitEnv.wsUrl, roomName };
};

/**
 * Starts a room-composite recording (mixed grid of every participant,
 * matching what everyone actually saw) and points LiveKit's Egress
 * service directly at the same S3 bucket the rest of the app already
 * uses for file storage (see services/s3Storage.ts) — Egress runs on
 * LiveKit's infrastructure and uploads straight to S3 itself, the
 * bytes never pass through this server.
 *
 * Caller is responsible for only calling this once per meeting (see
 * meetingController.getJoinToken's atomic claim on
 * Meeting.recordingEgressId) — calling it twice would start two
 * independent recordings of the same room.
 */
export const startRoomRecording = async (params: {
  meetingId: string | mongoose.Types.ObjectId;
}): Promise<{ egressId: string; s3Key: string }> => {
  if (!isS3Configured()) {
    throw new Error(
      "S3 is not configured — set AWS_REGION, S3_ACCESS_KEY, AWS_SECRET_KEY and S3_BUCKET",
    );
  }
  const roomName = roomNameFor(params.meetingId);
  const s3Key = `meeting-recordings/${String(params.meetingId)}/${Date.now()}.mp4`;

  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: s3Key,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey: process.env.S3_ACCESS_KEY!,
        secret: process.env.AWS_SECRET_KEY!,
        region: process.env.AWS_REGION!,
        bucket: BUCKET,
      }),
    },
  });

  const info = await getEgressClient().startRoomCompositeEgress(roomName, {
    file: output,
  });

  return { egressId: info.egressId, s3Key };
};

/** Best-effort stop — used if a meeting is cancelled mid-call. */
export const stopRoomRecording = async (egressId: string) => {
  try {
    await getEgressClient().stopEgress(egressId);
  } catch (err) {
    console.error("livekitService.stopRoomRecording:", err);
  }
};

// ─────────────────────────────────────────────────────────────────
// Webhook handling — LiveKit POSTs these events as rooms/participants
// change state. This is what makes attendance and the
// meeting-started/recording-available activity entries automatic.
// ─────────────────────────────────────────────────────────────────

/** Verifies the webhook signature and parses the event. Throws on a bad signature. */
export const verifyWebhookEvent = (
  body: string,
  authHeader: string,
): Promise<WebhookEvent> => {
  return getWebhookReceiver().receive(body, authHeader);
};

const meetingIdFromRoomName = (roomName: string) =>
  roomName.replace(/^meeting-/, "");

export const handleLivekitWebhookEvent = async (
  event: WebhookEvent,
): Promise<void> => {
  const roomName = event.room?.name;
  if (!roomName?.startsWith("meeting-")) return; // not one of our meeting rooms

  const meetingId = meetingIdFromRoomName(roomName);
  const meeting = await MeetingModel.findById(meetingId)
    .select("title organizer seriesId clientId")
    .lean();
  if (!meeting) return;

  switch (event.event) {
    case "room_started": {
      await logMeetingActivity({
        meetingId,
        seriesId: meeting.seriesId,
        clientId: meeting.clientId,
        actorId: meeting.organizer,
        action: "meeting_started",
        message: `"${meeting.title}" call started`,
      });
      break;
    }

    case "participant_joined": {
      const identity = event.participant?.identity;
      const name = event.participant?.name || identity || "Participant";
      if (!identity) break;
      await MeetingAttendanceModel.create({
        meetingId,
        identity,
        name,
        userId: mongoose.Types.ObjectId.isValid(identity)
          ? new mongoose.Types.ObjectId(identity)
          : undefined,
        joinedAt: new Date(),
      });
      break;
    }

    case "participant_left": {
      const identity = event.participant?.identity;
      if (!identity) break;
      // Close the most recent open attendance record for this identity —
      // handles reconnects (multiple join/leave pairs) correctly.
      const open = await MeetingAttendanceModel.findOne({
        meetingId,
        identity,
        leftAt: { $exists: false },
      }).sort({ joinedAt: -1 });
      if (open) {
        const leftAt = new Date();
        open.leftAt = leftAt;
        open.durationSeconds = Math.max(
          0,
          Math.round((leftAt.getTime() - open.joinedAt.getTime()) / 1000),
        );
        await open.save();
      }
      break;
    }

    case "egress_ended": {
      const egress = event.egressInfo;
      if (!egress) break;
      const failed = Boolean(egress.error);
      const fileResult = egress.fileResults?.[0];

      await MeetingModel.findByIdAndUpdate(meetingId, {
        recordingStatus: failed ? "failed" : "available",
        ...(fileResult && {
          // LiveKit reports duration in nanoseconds.
          recordingDurationSeconds: Math.round(
            Number(fileResult.duration) / 1e9,
          ),
          recordingSizeBytes: Number(fileResult.size),
        }),
      });

      if (!failed) {
        await logMeetingActivity({
          meetingId,
          seriesId: meeting.seriesId,
          clientId: meeting.clientId,
          actorId: meeting.organizer,
          action: "recording_available",
          message: `Recording for "${meeting.title}" is available`,
          details: { egressId: egress.egressId },
        });
      }
      break;
    }

    default:
      break;
  }
};
