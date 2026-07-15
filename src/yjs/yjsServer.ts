import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WebSocket, WebSocketServer, RawData } from "ws";
import YDocModel from "../models/YDoc";

// =====================================================================
// Yjs collaboration server
//
// Implements the standard y-websocket wire protocol (sync + awareness)
// so it is compatible with the `WebsocketProvider` client from the
// `y-websocket` npm package used on the frontend. Each message starts
// with a varUint message type:
//   0 = sync      (sync step 1 / step 2 / update — see y-protocols/sync)
//   1 = awareness (presence / cursors — see y-protocols/awareness)
//
// Documents are kept in memory per "room" (one room per docId) and
// persisted to MongoDB (debounced) so edits survive server restarts.
// =====================================================================

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SAVE_DEBOUNCE_MS = 1000;

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  // Maps each open socket to the set of awareness clientIDs it controls,
  // so we can clear their presence when the socket disconnects.
  conns: Map<WebSocket, Set<number>>;
  saveTimeout?: NodeJS.Timeout;
}

const rooms = new Map<string, Room>();

function sendBuffer(ws: WebSocket, message: Uint8Array) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(message);
  } catch (err) {
    console.error("❌ Failed to send Yjs message:", err);
  }
}

function toUint8Array(data: RawData): Uint8Array | null {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  return null;
}

async function loadPersistedDoc(docId: string, doc: Y.Doc): Promise<void> {
  try {
    const existing = await YDocModel.findOne({ docId });
    if (existing?.data) {
      try {
        Y.applyUpdate(doc, new Uint8Array(existing.data));
        console.log("📥 Loaded Yjs doc from DB:", docId);
      } catch (err) {
        console.error("❌ Corrupted Yjs data. Resetting:", docId, err);
        await YDocModel.deleteOne({ docId });
      }
    }
  } catch (err) {
    console.error("❌ Failed to load Yjs doc:", err);
  }
}

function schedulePersist(docId: string, room: Room): void {
  if (room.saveTimeout) clearTimeout(room.saveTimeout);
  room.saveTimeout = setTimeout(async () => {
    try {
      const state = Y.encodeStateAsUpdate(room.doc);
      await YDocModel.findOneAndUpdate(
        { docId },
        { data: Buffer.from(state) },
        { upsert: true },
      );
      console.log("💾 Saved Yjs doc:", docId);
    } catch (err) {
      console.error("❌ Failed saving Yjs doc:", err);
    }
  }, SAVE_DEBOUNCE_MS);
}

async function getOrCreateRoom(docId: string): Promise<Room> {
  const existingRoom = rooms.get(docId);
  if (existingRoom) return existingRoom;

  console.log("📄 Creating Yjs room:", docId);
  const doc = new Y.Doc();
  await loadPersistedDoc(docId, doc);

  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // the server itself has no cursor/presence

  const room: Room = { doc, awareness, conns: new Map() };
  rooms.set(docId, room);

  // Broadcast document updates to every connected client except the
  // one that produced the change (it already has it).
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    room.conns.forEach((_ids, conn) => {
      if (conn !== origin) sendBuffer(conn, message);
    });
    schedulePersist(docId, room);
  });

  // Broadcast presence/cursor changes the same way.
  awareness.on(
    "update",
    (
      {
        added,
        updated,
        removed,
      }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin instanceof WebSocket && room.conns.has(origin)) {
        const controlled = room.conns.get(origin)!;
        added.forEach((id) => controlled.add(id));
        removed.forEach((id) => controlled.delete(id));
      }
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
      );
      const message = encoding.toUint8Array(encoder);
      room.conns.forEach((_ids, conn) => {
        if (conn !== origin) sendBuffer(conn, message);
      });
    },
  );

  return room;
}

export const initYjsServer = (server: any) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: any, socket: any, head: any) => {
    const { url } = request;
    if (!url?.startsWith("/yjs")) return;

    wss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
      const rawDocId = request.url.split("/yjs/")[1]?.split("?")[0];
      const docId = decodeURIComponent(rawDocId || "default");
      const room = await getOrCreateRoom(docId);

      room.conns.set(ws, new Set());
      console.log(
        "⚡ Yjs client connected:",
        docId,
        `(${room.conns.size} online)`,
      );

      // Kick off sync: tell the client our state vector (sync step 1).
      // The client replies with step 2, and we apply it in the message
      // handler below — this is the standard client/server handshake.
      {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, room.doc);
        sendBuffer(ws, encoding.toUint8Array(encoder));
      }

      // Send the current presence of everyone already in the room.
      const awarenessStates = room.awareness.getStates();
      if (awarenessStates.size > 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            room.awareness,
            Array.from(awarenessStates.keys()),
          ),
        );
        sendBuffer(ws, encoding.toUint8Array(encoder));
      }

      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          console.warn("⚠️ Received non-binary Yjs message. Ignored.");
          return;
        }
        const bytes = toUint8Array(data);
        if (!bytes) {
          console.warn("⚠️ Unrecognized Yjs message payload type. Ignored.");
          return;
        }
        try {
          const decoder = decoding.createDecoder(bytes);
          const messageType = decoding.readVarUint(decoder);

          switch (messageType) {
            case MESSAGE_SYNC: {
              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, MESSAGE_SYNC);
              syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
              // readSyncMessage only writes a reply for step1 (→ step2);
              // for step2/update there's nothing to send back.
              if (encoding.length(encoder) > 1)
                sendBuffer(ws, encoding.toUint8Array(encoder));
              break;
            }
            case MESSAGE_AWARENESS: {
              awarenessProtocol.applyAwarenessUpdate(
                room.awareness,
                decoding.readVarUint8Array(decoder),
                ws,
              );
              break;
            }
            default:
              console.warn("⚠️ Unknown Yjs message type:", messageType);
          }
        } catch (err) {
          console.error("❌ Apply update failed:", err);
        }
      });

      ws.on("close", () => {
        const controlledIds = room.conns.get(ws);
        room.conns.delete(ws);
        if (controlledIds && controlledIds.size > 0) {
          awarenessProtocol.removeAwarenessStates(
            room.awareness,
            Array.from(controlledIds),
            null,
          );
        }
        console.log(
          "🔌 Yjs client disconnected:",
          docId,
          `(${room.conns.size} remaining)`,
        );
      });

      ws.on("error", (err: Error) => {
        console.error("❌ WebSocket error:", err);
      });
    });
  });

  console.log(
    "✅ Yjs collaboration server running (sync + awareness protocol, Mongo-backed persistence)",
  );
};
