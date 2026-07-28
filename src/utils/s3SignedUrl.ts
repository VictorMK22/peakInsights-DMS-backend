// Thin re-export — the real implementation lives in services/s3Storage.ts
// alongside the S3 client itself. Kept as a separate importable path so
// call sites can import "the URL function" without pulling in the raw S3
// client/upload functions too.
export { getSignedFileUrl } from "../services/s3Storage";
