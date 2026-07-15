import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { User } from "../models/User";
import { TokenBlacklist } from "../models/TokenBlacklist";

interface Viewer {
  id: string;
  name: string;
  avatar?: string | null;
}

const onlineUsers = new Map<string, string>();

let io: Server;

const getSafeUser = (socket: any): Viewer | null => {
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
  // 🔐 AUTH MIDDLEWARE
  // ==========================
  // Mirrors the REST `authenticate` middleware's checks (see
  // middleware/auth.ts) — a socket connection is just another way to
  // act as an authenticated user, so it shouldn't skip the checks
  // that route applies: blacklisted tokens (explicit logout) and
  // deactivated accounts must both be rejected here too, not just on
  // HTTP requests. The previous version only verified the JWT
  // signature/expiry, which meant a logged-out or deactivated user
  // could still hold a live, fully-functional socket connection for
  // up to 7 days (the token's lifetime).
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1];

      if (!token) {
        return next(new Error("Unauthorized"));
      }

      const blacklisted = await TokenBlacklist.findOne({ token });
      if (blacklisted) {
        return next(new Error("Unauthorized"));
      }

      const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);

      const user = await User.findById(decoded.userId).select(
        "name avatar isActive",
      );
      if (!user || !user.isActive) {
        return next(new Error("Unauthorized"));
      }

      socket.data.user = {
        id: decoded.userId,
        name: user.name,
        avatar: user.avatar || null,
      };

      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = getSafeUser(socket);
    if (!user) return;

    console.log("⚡ User connected:", user.id);

    onlineUsers.set(user.id, socket.id);
    socket.join(`user:${user.id}`);

    io.emit("presence:update", {
      userId: user.id,
      status: "online",
    });

    // ==========================
    // ❌ DISCONNECT CLEANUP
    // ==========================
    socket.on("disconnect", () => {
      onlineUsers.delete(user.id);

      io.emit("presence:update", {
        userId: user.id,
        status: "offline",
      });

      console.log(`🔴 User disconnected: ${user.id}`);
    });

    // ==========================
    // ✍️ TYPING (message threads)
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
    // ✅ MARK READ relay
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
