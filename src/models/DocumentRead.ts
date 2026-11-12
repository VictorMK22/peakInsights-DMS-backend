import mongoose from "mongoose";

/**
 * DocumentRead
 *
 * One row per (document, user) pair. A row starts as "opened" (the person
 * loaded or downloaded the material) and only becomes "read" once they have
 * genuinely gone through it — enough active reading time (tracked on the
 * server from heartbeats) and, where the viewer can measure it, scrolled to
 * the end — or explicitly confirmed it after a minimum amount of time.
 * Rows written before this field existed have no status and count as read.
 *
 * Records when they first did so, and how many times they've
 * been back. Primarily used by the Learning Library to show "who's
 * read this" and per-user completion state, but works for any
 * document type since read receipts aren't learning-specific.
 *
 * Not modelled as an array field on Document itself because a
 * frequently-updated read log would blow up Document's update
 * frequency/size and contend with the document's own edit history —
 * a separate collection keeps reads cheap to write and easy to
 * query/aggregate independently.
 */
const documentReadSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    firstReadAt: {
      type: Date,
      default: Date.now,
    },
    lastReadAt: {
      type: Date,
      default: Date.now,
    },
    // "opened" = loaded/downloaded only; "read" = completed. Defaults to
    // "read" so legacy rows (and non-learning documents) keep counting.
    status: {
      type: String,
      enum: ["opened", "read"],
      default: "read",
    },
    // Seconds of verified, active reading (visible tab + recent activity),
    // accumulated server-side from heartbeats.
    activeSeconds: { type: Number, default: 0 },
    // Furthest scroll position reached (0–100), only meaningful when the
    // viewer could measure scrolling (scrollTracked).
    maxScrollPct: { type: Number, default: 0 },
    scrollTracked: { type: Boolean, default: false },
    lastHeartbeatAt: { type: Date },
    // The file was downloaded — they may be reading it offline.
    downloaded: { type: Boolean, default: false },
    completedAt: { type: Date },
    completionMethod: { type: String, enum: ["engagement", "confirmed"] },
    // Number of times markDocumentRead has been called for this pair
    // (i.e. distinct open events, not page renders).
    readCount: {
      type: Number,
      default: 1,
    },
  },
  { timestamps: true },
);

// A user can only have one read-receipt row per document — repeat
// reads update the existing row (see markDocumentRead) rather than
// inserting a new one.
documentReadSchema.index({ documentId: 1, user: 1 }, { unique: true });

export const DocumentReadModel = mongoose.model(
  "DocumentRead",
  documentReadSchema,
);