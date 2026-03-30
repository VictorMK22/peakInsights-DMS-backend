import mongoose, { Schema, Document } from "mongoose";

export interface IFolder extends Document {
  name: string
  parentFolderId?: mongoose.Types.ObjectId
  ownerId: mongoose.Types.ObjectId
  path: string
  accessControlList: mongoose.Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

const FolderSchema = new Schema<IFolder>(
  {
    name: {
      type: String,
      required: true
    },

    parentFolderId: {
      type: Schema.Types.ObjectId,
      ref: "Folder",
      default: null
    },

    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },

    path: {
      type: String,
      required: true,
      index: true
    },
    
    accessControlList: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ]

  },

  { timestamps: true }
)

FolderSchema.index({ ownerId: 1, path: 1 }, { unique: true })

export const FolderModel = mongoose.model<IFolder>("Folder", FolderSchema)