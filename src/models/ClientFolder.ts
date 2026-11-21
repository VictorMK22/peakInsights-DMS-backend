import mongoose, { Document, Schema } from "mongoose";

/**
 * A folder inside one client's "Documents" tab.
 *
 * Deliberately separate from the personal Drive `Folder` model: Drive folders
 * belong to one owner, while client folders are shared by everyone who works
 * with the client (CEO, assigned sales person/accountant, their supervisor).
 * A document sits in a client folder via Document.clientFolderId, which leaves
 * its Drive placement (Document.folderId) untouched.
 *
 * Folders are flat (one level) and hard-deleted: deleting one never deletes
 * documents, they simply return to the client's main list.
 */
export interface IClientFolder extends Document {
  clientId: mongoose.Types.ObjectId;
  name: string;
  // Lower-cased, trimmed name — makes names unique per client, ignoring case.
  nameKey: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ClientFolderSchema = new Schema<IClientFolder>(
  {
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

ClientFolderSchema.index({ clientId: 1, nameKey: 1 }, { unique: true });

export const ClientFolderModel = mongoose.model<IClientFolder>(
  "ClientFolder",
  ClientFolderSchema,
);