import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import mongoose from 'mongoose';
import http from 'http';
import { initSocket } from './socket/socketServer';
import { initYjsServer } from './yjs/yjsServer';
import { connectDatabase } from './config/database';
import { errorHandler, notFound } from './middleware/errorHandler';

import authRoutes      from './routes/auth';
import userRoutes      from './routes/users';
import documentRoutes  from './routes/documents';
import analyticsRoutes from './routes/analytics';
import folderRoutes    from './routes/folders';
import taskRoutes      from './routes/tasks';
import messageRoutes   from './routes/messages';
import emailRoutes   from './routes/emails';

dotenv.config();

const app = express();

const PORT         = process.env.PORT         ?? 5000;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../uploads');

const allowedOrigins = [FRONTEND_URL];

// ── Ensure uploads directory exists ──────────────────────────────
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ── Serve uploaded files statically ──────────────────────────────
// Files are stored locally (no S3). The frontend accesses them via
// GET /uploads/<filename>. The backend URL is set in BACKEND_URL env var.
// IMPORTANT: This must come before helmet() to avoid CSP blocking.
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      const origin = res.req?.headers?.origin;

      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    },
  })
);

console.log('Uploads path:', path.resolve(UPLOAD_DIR));

// ── Security ──────────────────────────────────────────────────────
app.use(
  helmet({
    // Disable frameguard so PDFs can be embedded in iframes
    frameguard: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'frame-ancestors': ["'self'", FRONTEND_URL],
        'frame-src':       ["'self'", FRONTEND_URL, 'http://localhost:5000'],
      },
    },
  })
);

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,                  // increased — folder uploads generate many requests
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests, please try again later.',
  })
);

app.use((req, _res, next) => {
  console.log('→', req.method, req.url);
  next();
});

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/folders',   folderRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/tasks',     taskRoutes);      
app.use('/api/messages',  messageRoutes);    
app.use("/api/emails", emailRoutes);

// ── Health check ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'PeakInsights DMS API', version: '1.0.0' });
});

// ── Error handling ────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────
const startServer = async () => {
  try {
    await connectDatabase();

    const server = http.createServer(app);

    initSocket(server);
    initYjsServer(server);

    server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📁 Uploads served from ${UPLOAD_DIR} at /uploads`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed.');
  process.exit(0);
});

export default app;