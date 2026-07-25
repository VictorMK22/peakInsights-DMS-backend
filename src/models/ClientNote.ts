import mongoose, { Schema, Document } from "mongoose";

export interface IClientNote extends Document {
  clientId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const ClientNoteSchema = new Schema<IClientNote>(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

ClientNoteSchema.index({ clientId: 1, createdAt: -1 });

export const ClientNoteModel = mongoose.model<IClientNote>(
  "ClientNote",
  ClientNoteSchema,
);
