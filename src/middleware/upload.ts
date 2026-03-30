import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { Request } from 'express';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads';

// Ensure the uploads directory exists at startup
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── DISK STORAGE ─────────────────────────────────────────────────
// Files are stored locally. The filename is a UUID to avoid collisions.
// The original filename is preserved in file.originalname for display.
// webkitRelativePath is forwarded from the request body so folder
// structure can be reconstructed in the document controller.
const storage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req: Request, file: Express.Multer.File, cb) => {
    // Keep the extension so MIME detection works; UUID prefix avoids collisions
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

// ─── FILE FILTER ──────────────────────────────────────────────────
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  // Block known dangerous executables — allow everything else
  const blocked = ['.exe', '.bat', '.sh', '.cmd', '.ps1', '.msi'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (blocked.includes(ext)) {
    cb(new Error(`File type ${ext} is not allowed`));
  } else {
    cb(null, true);
  }
};

// ─── MAIN UPLOAD MIDDLEWARE ───────────────────────────────────────
// Use .any() so multer accepts any field name and any number of files.
// This supports:
//   • Single file upload   (field name "file")
//   • Multiple files       (field name "files[]" or "files")
//   • Folder uploads       (many files from webkitdirectory, any field name)
// The document controller reads req.files (array) and uses
// file.originalname + body.webkitRelativePath[i] to rebuild structure.
export const uploadToLocal = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024,  // 100 MB per file
    files: 200,                    // max 200 files per request (folder uploads)
  },
});

// ─── SERVE A LOCAL FILE URL ───────────────────────────────────────
// Builds the URL that the frontend uses to view/preview a file.
// In production swap BACKEND_URL for your actual domain.
export const getLocalFileUrl = (filename: string): string => {
  const base = process.env.BACKEND_URL ?? 'http://localhost:5000';
  return `${base}/uploads/${filename}`;
};



// import multer from "multer";
// import multerS3 from "multer-s3";
// import { v4 as uuid } from "uuid";
// import { Request } from "express";
// import { s3, BUCKET } from "../services/s3Storage";

// /**
//  * ✅ 1. S3 Upload Middleware (production storage)
//  */

// export const uploadToS3 = multer({

//   storage: multerS3({

//     s3,
//     bucket: BUCKET,

//     metadata: (
//       _req: Request,
//       file: Express.Multer.File,
//       cb: (error: any, metadata?: any) => void
//     ) => {
//       cb(null, { fieldName: file.fieldname });
//     },

//     key: (
//       _req: Request,
//       file: Express.Multer.File,
//       cb: (error: any, key?: string) => void
//     ) => {

//       const key = `documents/${uuid()}-${file.originalname}`;

//       cb(null, key);
//     }

//   }),

//   limits: {
//     fileSize: 100 * 1024 * 1024
//   }

// });

// /**
//  * ✅ 2. Memory Upload Middleware (for text extraction)
//  */
// export const uploadToMemory = multer({
//   storage: multer.memoryStorage(),
//   limits: {
//     fileSize: 20 * 1024 * 1024 // smaller for RAM safety
//   }
// });


// import multer from "multer";
// import path from "path";
// import { v4 as uuid } from "uuid";

// /**
//  * ✅ LOCAL DISK STORAGE (NO AWS REQUIRED)
//  */

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, "uploads/"); // make sure folder exists
//   },
//   filename: (req, file, cb) => {
//     const uniqueName = `${uuid()}-${file.originalname}`;
//     cb(null, uniqueName);
//   },
// });

// export const uploadToLocal = multer({
//   storage,
//   limits: {
//     fileSize: 100 * 1024 * 1024,
//   },
// });

// /**
//  * ✅ Memory (keep this)
//  */
// export const uploadToMemory = multer({
//   storage: multer.memoryStorage(),
//   limits: {
//     fileSize: 20 * 1024 * 1024,
//   },
// });