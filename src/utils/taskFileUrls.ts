import { buildSignedFileUrl } from "./fileAccessToken";

/**
 * Task brief files are stored with only their S3 `fileKey` being meaningful.
 * The `fileUrl` saved at upload time is a signed link that expires after
 * 30 minutes, so serving it as-is means the person the task was sent to gets
 * "Invalid or expired file link" shortly after. Every read therefore builds
 * fresh links from the key instead:
 *
 *   fileUrl      – opens the file in the browser where it can be shown inline
 *                  (images, PDFs, text, audio, video) — used for previews
 *   downloadUrl  – same file, forced to download under its original name
 */
interface StoredTaskFile {
  fileName: string;
  fileKey: string;
  fileUrl?: string;
  [k: string]: unknown;
}

export const signTaskFile = <T extends StoredTaskFile>(file: T) => {
  const base = buildSignedFileUrl(file.fileKey);
  const name = `&name=${encodeURIComponent(file.fileName)}`;
  return { ...file, fileUrl: `${base}${name}`, downloadUrl: `${base}${name}&download=1` };
};

export const signTaskFiles = <T extends StoredTaskFile>(files?: T[]) =>
  (files ?? []).map(signTaskFile);