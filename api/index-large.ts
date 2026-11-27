// ═════════════════════════════════════════════════════════════════
// Same Express app as api/index.ts, deployed as its OWN serverless function
// so it can have a longer time limit than the normal API (see vercel.json).
// Only /api/cron/index-large-documents is rewritten to it — extracting text
// from a big .docx/.xlsx can take minutes, which the regular function's
// 60 s limit would cut off.
// ═════════════════════════════════════════════════════════════════
export { default } from "./index";