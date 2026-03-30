import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { CommentModel } from "../models/Comment";

interface Viewer {
  id: string;
  name: string;
  avatar?: string | null;
}

interface ViewerMap {
  [documentId: string]: Map<string, Viewer>;
}

const viewers: ViewerMap = {};
const locks: Record<string, string> = {};
const onlineUsers = new Map<string, string>();

let io: Server;

// 🔒 Safe helper
const getSafeUser = (socket: any) => {
  const user = socket.data.user;
  if (!user?.id) {
    console.error("❌ Missing user in socket");
    return null;
  }
  return user;
};

export const initSocket = (server: any) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL,
      credentials: true,
    },
  });

  // ==========================
  // 🔐 AUTH MIDDLEWARE (FIXED)
  // ==========================
  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("Unauthorized"));
      }

      const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);

      // ✅ NORMALIZE USER STRUCTURE
      socket.data.user = {
        id: decoded.userId || decoded.id,
        name: decoded.name || "User",
        avatar: decoded.avatar || null,
      };

      next();
    } catch (err) {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = getSafeUser(socket);
    if (!user) return;

    // ==========================
    // 🟢 USER ONLINE
    // ==========================
    onlineUsers.set(user.id, socket.id);

    // already exists but ensure it's here
    socket.join(`user:${user.id}`);

    io.emit("presence:update", {
      userId: user.id,
      status: "online",
    });

    const COLORS = ["#7C3AED", "#06B6D4", "#10B981", "#F59E0B", "#EF4444"];

    const getColor = (userId: string) =>
      COLORS[userId.charCodeAt(0) % COLORS.length];

    console.log("⚡ User connected:", user.id);

    socket.join(`user:${user.id}`);

    // ==========================
    // 📄 JOIN DOCUMENT
    // ==========================
    socket.on("join-document", ({ documentId }) => {
      const user = getSafeUser(socket);
      if (!user) return;

      if (!viewers[documentId]) {
        viewers[documentId] = new Map<string, Viewer>();
      }

      // ✅ prevent duplicates
      if (!viewers[documentId].has(user.id)) {
        viewers[documentId].set(user.id, {
          id: user.id,
          name: user.name,
          avatar: user.avatar,
        });
      }

      socket.join(`document:${documentId}`);

      io.to(`document:${documentId}`).emit(
        "viewers-update",
        Array.from(viewers[documentId].values())
      );

      console.log(`User ${user.id} joined document ${documentId}`);
    });

    // ==========================
    // 🚪 LEAVE DOCUMENT (FIXED)
    // ==========================
    socket.on("leave-document", ({ documentId }) => {
      const user = getSafeUser(socket);
      if (!user) return;

      const docViewers = viewers[documentId];
      if (!docViewers) return;

      docViewers.delete(user.id);

      if (docViewers.size === 0) {
        delete viewers[documentId]; // ✅ prevent memory leak
      }

      io.to(`document:${documentId}`).emit(
        "viewers-update",
        Array.from(docViewers.values())
      );

      socket.leave(`document:${documentId}`);

      console.log(`User ${user.id} left document ${documentId}`);
    });

    // ==========================
    // ❌ DISCONNECT CLEANUP
    // ==========================
    socket.on("disconnect", () => {
      const user = getSafeUser(socket);
      if (!user) return;
    
      // ❗ remove from online users
      onlineUsers.delete(user.id);
    
      io.emit("presence:update", {
        userId: user.id,
        status: "offline",
      });
    
      // 🔁 KEEP YOUR EXISTING DOCUMENT CLEANUP
      for (const docId in viewers) {
        const docViewers = viewers[docId];
        if (!docViewers) continue;
    
        if (docViewers.has(user.id)) {
          docViewers.delete(user.id);
    
          if (docViewers.size === 0) {
            delete viewers[docId];
          } else {
            io.to(`document:${docId}`).emit(
              "viewers-update",
              Array.from(docViewers.values())
            );
          }
        }
      }
    
      console.log(`🔴 User disconnected: ${user.id}`);
    });

    // ==========================
    // ✍️ EDITING INDICATOR
    // ==========================
    socket.on("editing", ({ documentId, section }) => {
      const user = getSafeUser(socket);
      if (!user) return;

      socket.to(`document:${documentId}`).emit("user-editing", {
        user: { id: user.id, name: user.name },
        section,
      });
    });

    // ==========================
    // 🖱 CURSOR TRACKING
    // ==========================
    socket.on("cursor-move", ({ documentId, x, y }) => {
      const user = getSafeUser(socket);
      if (!user) return;

      socket.to(`document:${documentId}`).emit("cursor-update", {
        user: {
          id: user.id,
          name: user.name,
          color: getColor(user.id),
        },
        x,
        y,
      });
    });

    // ==========================
    // 💬 COMMENTS (SAFE)
    // ==========================
    socket.on("add-comment", async ({ documentId, text }) => {
      try {
        const user = getSafeUser(socket);
        if (!user) return;

        const comment = await CommentModel.create({
          documentId,
          user: user.id,
          text,
        });

        const populated = await comment.populate("user", "name email");

        io.to(`document:${documentId}`).emit("new-comment", populated);
      } catch (err) {
        console.error("❌ Error adding comment:", err);
      }
    });

    // ==========================
    // 🔒 SECTION LOCKING (SAFE)
    // ==========================
    socket.on("lock-section", ({ documentId, section }) => {
      const user = getSafeUser(socket);
      if (!user) return;

      const key = `${documentId}:${section}`;

      if (locks[key] && locks[key] !== user.id) {
        return; // already locked by someone else
      }

      locks[key] = user.id;

      io.to(`document:${documentId}`).emit("section-locked", {
        section,
        userId: user.id,
      });
    });

    socket.on("unlock-section", ({ documentId, section }) => {
      const key = `${documentId}:${section}`;

      delete locks[key];

      io.to(`document:${documentId}`).emit("section-unlocked", {
        section,
      });
    });

    // ==========================
    // 📝 DOCUMENT EDITING (NON-YJS SAFE)
    // ==========================
    socket.on("edit-document", ({ documentId, content }) => {
      socket.to(`document:${documentId}`).emit("document-updated", content);
    });

    // ==========================
    // 🟢 USER ONLINE
    // ==========================
    onlineUsers.set(user.id, socket.id);

    // already exists but ensure it's here
    socket.join(`user:${user.id}`);

    io.emit("presence:update", {
      userId: user.id,
      status: "online",
    });

    // ==========================
    // ✍️ TYPING
    // ==========================
    socket.on("chat:typing", ({ to }) => {
      const target = onlineUsers.get(to);
      if (target) {
        io.to(target).emit("chat:typing", { from: user.id });
      }
    });

    socket.on("chat:stop-typing", ({ to }) => {
      const target = onlineUsers.get(to);
      if (target) {
        io.to(target).emit("chat:stop-typing", { from: user.id });
      }
    });

    // ==========================
    // ✅ MARK READ
    // ==========================
    socket.on("chat:read", ({ messageId, from }) => {
      const target = onlineUsers.get(from);

      if (target) {
        io.to(target).emit("chat:read", { messageId });
      }
    });

  });
};


export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};