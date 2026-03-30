import * as Y from "yjs";
import { WebSocketServer } from "ws";
import YDocModel from "../models/YDoc";

const docs = new Map<string, Y.Doc>();

// ==========================
// 📄 GET OR CREATE DOC
// ==========================
const getYDoc = async (docId: string): Promise<Y.Doc> => {
  if (docs.has(docId)) return docs.get(docId)!;

  const ydoc = new Y.Doc();

  console.log("📄 Creating Yjs doc:", docId);

  // ==========================
  // 📥 LOAD FROM MONGO
  // ==========================
  try {
    const existing = await YDocModel.findOne({ docId });

    if (existing?.data) {
      try {
        const update = new Uint8Array(existing.data); // ✅ SAFE
        Y.applyUpdate(ydoc, update);
        console.log("📥 Loaded Yjs doc from DB:", docId);
      } catch (err) {
        console.error("❌ Corrupted Yjs data. Resetting:", docId);
        await YDocModel.deleteOne({ docId });
      }
    }
  } catch (err) {
    console.error("❌ Failed to load Yjs doc:", err);
  }

  // ==========================
  // 💾 SAVE (DEBOUNCED)
  // ==========================
  let timeout: NodeJS.Timeout;

  ydoc.on("update", () => {
    clearTimeout(timeout);

    timeout = setTimeout(async () => {
      try {
        const state = Y.encodeStateAsUpdate(ydoc);

        await YDocModel.findOneAndUpdate(
          { docId },
          { data: Buffer.from(state) },
          { upsert: true }
        );

        console.log("💾 Saved Yjs doc:", docId);
      } catch (err) {
        console.error("❌ Failed saving Yjs doc:", err);
      }
    }, 1000);
  });

  docs.set(docId, ydoc);
  return ydoc;
};

// ==========================
// 🚀 INIT SERVER
// ==========================
export const initYjsServer = (server: any) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: any, socket: any, head: any) => {
    const { url } = request;

    if (!url?.startsWith("/yjs")) return;

    wss.handleUpgrade(request, socket, head, async (ws) => {
      const docId = request.url.split("/yjs/")[1] || "default";

      const ydoc = await getYDoc(docId);

      console.log("⚡ Yjs client connected:", docId);

      // ==========================
      // 📤 SEND INITIAL STATE
      // ==========================
      try {
        const state = Y.encodeStateAsUpdate(ydoc);
        ws.send(Buffer.from(state));
        console.log("📤 Sent initial state:", docId);
      } catch (err) {
        console.error("❌ Failed to send initial state:", err);
      }

      // ==========================
      // 📥 RECEIVE UPDATES
      // ==========================
      ws.on("message", (message) => {
        try {
          let update: Uint8Array;

          if (message instanceof Buffer) {
            update = new Uint8Array(message);
          } else if (message instanceof ArrayBuffer) {
            update = new Uint8Array(message);
          } else if (typeof message === "string") {
            console.warn("⚠️ Received STRING instead of binary. Ignored.");
            return;
          } else {
            console.warn("⚠️ Unknown message type. Ignored.");
            return;
          }

          Y.applyUpdate(ydoc, update);
        } catch (err) {
          console.error("❌ Apply update failed:", err);
        }
      });

      // ==========================
      // 📡 BROADCAST UPDATES
      // ==========================
      const updateHandler = (update: Uint8Array) => {
        try {
          ws.send(Buffer.from(update));
        } catch (err) {
          console.error("❌ Failed to send update:", err);
        }
      };

      ydoc.on("update", updateHandler);

      // ==========================
      // 🔌 CLEANUP
      // ==========================
      ws.on("close", () => {
        console.log("🔌 Yjs client disconnected:", docId);
        ydoc.off("update", updateHandler);
      });

      ws.on("error", (err) => {
        console.error("❌ WebSocket error:", err);
      });
    });
  });

  console.log("✅ Yjs + Mongo persistence server running (stable)");
};