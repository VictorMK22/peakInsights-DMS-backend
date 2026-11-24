import multer from "multer";
import path from "path";
import { Request, Response, NextFunction } from "express";
import { isS3Configured, uploadBufferToS3 } from "../services/s3Storage";
import { sniffImage } from "../utils/errorScrub";
import { REPORTED } from "./requestContext";

// Screenshots / snipped images for error reports.
//
// • Images only, and the real bytes are checked (not the filename or the
//   Content-Type the browser claimed) — these files are shown to other
//   people.
// • Vercel caps a request body at ~4.5 MB, so the frontend shrinks large
//   screenshots before upload; these limits are the server-side backstop.
// • Every failure here is a 4xx with a plain message, never a 500, so a
//   bad upload can't page the tech supervisor.

export const MAX_SCREENSHOTS = 5;
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export interface StoredScreenshot {
  fileKey: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Kept so the same bytes can be attached to the notification email. */
  buffer: Buffer;
}

export interface ScreenshotRequest extends Request {
  screenshots?: StoredScreenshot[];
}

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCREENSHOT_BYTES, files: MAX_SCREENSHOTS },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only PNG, JPG, GIF or WebP images can be attached"));
  },
});

const parseUpload = (req: Request, res: Response, next: NextFunction): void => {
  multerUpload.array("screenshots", MAX_SCREENSHOTS)(req, res, (err: unknown) => {
    if (!err) return next();
    const code = (err as { code?: string }).code;
    if (code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        success: false,
        message: `Each screenshot must be under ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB.`,
      });
    } else if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") {
      res.status(400).json({
        success: false,
        message: `You can attach up to ${MAX_SCREENSHOTS} screenshots.`,
      });
    } else {
      res.status(400).json({
        success: false,
        message: (err as Error).message || "Could not read the attached files",
      });
    }
  });
};

const storeScreenshots = async (
  req: ScreenshotRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    req.screenshots = [];
    if (files.length === 0) return next();

    const sniffed = files.map((f) => sniffImage(f.buffer));
    if (sniffed.some((s) => s === null)) {
      res.status(400).json({
        success: false,
        message: "One of the attached files is not a valid image.",
      });
      return;
    }
    if (!isS3Configured()) {
      // A deployment setting, not a fault to alert on: mark it handled so it
      // is not auto-reported, and say so (reported:false) so the UI does not
      // claim "the tech team has been notified".
      res.locals[REPORTED] = true;
      res.status(503).json({
        success: false,
        reported: false,
        message:
          "Screenshots can't be saved because file storage (S3) isn't configured on this server. Send without a screenshot, or ask your administrator to set the S3 variables.",
      });
      return;
    }

    req.screenshots = await Promise.all(
      files.map(async (f, i) => {
        const kind = sniffed[i]!;
        // Extension comes from the detected type, never the client's filename.
        const fileKey = await uploadBufferToS3(
          f.buffer,
          `screenshot.${kind.ext}`,
          kind.mime,
        );
        const base = path
          .basename(f.originalname || "")
          .replace(/[^\w.\- ]/g, "_")
          .slice(0, 80);
        return {
          fileKey,
          filename: base || `screenshot-${i + 1}.${kind.ext}`,
          mimeType: kind.mime,
          size: f.size,
          buffer: f.buffer,
        };
      }),
    );
    next();
  } catch (err) {
    next(err);
  }
};

export const screenshotUpload = [parseUpload, storeScreenshots];