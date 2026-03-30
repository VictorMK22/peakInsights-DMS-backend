import mongoose, { Document, Schema } from 'mongoose';
import { DocumentStatus, DocumentPriority } from '../types';

export interface IVersionEntry {
  versionNumber: number;
  fileName: string;
  fileType: string;
  fileKey: string
  fileUrl: string
  previewUrl?: string
  fileSize: number;
  modifiedBy: mongoose.Types.ObjectId;
  modifiedAt: Date;
  changeNote?: string;
}

export interface IDocument extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  fileType: string;
  indexedAt: Date,
  contentText: string;
  currentVersion: number;
  versionHistory: IVersionEntry[];
  documentType: 'working' | 'storage' | 'learning';
  status: DocumentStatus;
  priority: DocumentPriority;
  ownerId: mongoose.Types.ObjectId;
  folderId: mongoose.Types.ObjectId;
  departmentId?: string;
  supervisorId?: mongoose.Types.ObjectId;
  targetCompletionTime?: Date;
  startTime?: Date;
  endTime?: Date;
  tatMinutes?: number;
  targetTatMinutes?: number;
  efficiencyRatio?: number;
  completionRequestedAt?: Date;
  completionRequestedBy?: mongoose.Types.ObjectId;
  supervisorApprovedBy?: mongoose.Types.ObjectId;
  supervisorApprovedAt?: Date;
  accessControlList: mongoose.Types.ObjectId[];
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const VersionEntrySchema = new Schema<IVersionEntry>({
  versionNumber: { type: Number, required: true },
  fileName: { type: String, required: true },
  fileType: { type: String, required: true },

  fileKey: { type: String, required: true },
  fileUrl: { type: String, required: true },
  previewUrl: { type: String },

  fileSize: { type: Number, required: true },

  modifiedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  modifiedAt: { type: Date, default: Date.now },

  changeNote: { type: String }
}, { _id: false });

const DocumentSchema = new Schema<IDocument>({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  fileType: { type: String, required: true },
  contentText: { type: String },
  indexedAt: { type: Date },

  documentType: { type: String, enum: ['working', 'storage', 'learning'], default: 'working' },

  currentVersion: { type: Number, default: 1 },
  versionHistory: [VersionEntrySchema],

  status: { type: String, enum: ['draft', 'in_progress', 'pending_completion', 'completed', 'archived'], default: 'draft' },

  completionRequestedAt: { type: Date },
  completionRequestedBy: { type: Schema.Types.ObjectId, ref: 'User' },

  priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },

  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  folderId: { type: Schema.Types.ObjectId, ref: "Folder", index: true },
  departmentId: { type: String },
  supervisorId: { type: Schema.Types.ObjectId, ref: 'User' },

  targetCompletionTime: { type: Date },
  startTime: { type: Date },
  endTime: { type: Date },

  tatMinutes: { type: Number },
  targetTatMinutes: { type: Number },
  efficiencyRatio: { type: Number },

  supervisorApprovedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  supervisorApprovedAt: { type: Date },

  accessControlList: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  tags: [{ type: String }],
  metadata: { type: Schema.Types.Mixed, default: {} },

}, { timestamps: true });

DocumentSchema.index({ folderId: 1, createdAt: -1 });
DocumentSchema.index({ ownerId: 1, status: 1 });
DocumentSchema.index({ supervisorId: 1 });
DocumentSchema.index({ accessControlList: 1 });
DocumentSchema.index({ title: "text", description: "text", contentText: "text", tags: "text" }, { weights: { title: 5, tags: 4, description: 2, contentText: 1 }, name: "DocumentTextIndex"});

export const DocumentModel = mongoose.model<IDocument>('Document', DocumentSchema);
