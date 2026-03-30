import mongoose, { Document, Schema } from 'mongoose';

export type CollaborationStatus = 'pending' | 'active' | 'revoked' | 'declined';

export interface ICollaboration extends Document {
  documentId: mongoose.Types.ObjectId;
  inviterId: mongoose.Types.ObjectId;
  inviteeId: mongoose.Types.ObjectId;
  status: CollaborationStatus;
  grantedAt?: Date;
  revokedAt?: Date;
  revokedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CollaborationSchema = new Schema<ICollaboration>({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  inviterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  inviteeId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'active', 'revoked', 'declined'], default: 'pending' },
  grantedAt: { type: Date },
  revokedAt: { type: Date },
  revokedReason: { type: String },
}, { timestamps: true });

CollaborationSchema.index({ documentId: 1, inviteeId: 1 });
CollaborationSchema.index({ inviterId: 1, status: 1 });

export const Collaboration = mongoose.model<ICollaboration>('Collaboration', CollaborationSchema);
