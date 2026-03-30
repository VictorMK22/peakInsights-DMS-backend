import mongoose, { Document, Schema } from 'mongoose';
import { AuditAction } from '../types';

export interface IAuditLog extends Document {
  documentId?: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  action: AuditAction;
  targetUserId?: mongoose.Types.ObjectId;
  supervisorIdAtTime?: mongoose.Types.ObjectId;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document' },
  actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['created','viewed','edited','submitted','completed','invited','access_revoked','deleted','downloaded'], required: true },
  targetUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  supervisorIdAtTime: { type: Schema.Types.ObjectId, ref: 'User' },
  details: { type: Schema.Types.Mixed },
  ipAddress: { type: String },
  userAgent: { type: String },
  timestamp: { type: Date, default: Date.now, immutable: true },
}, { timestamps: false });

// Audit logs are immutable - no updates allowed
AuditLogSchema.pre('findOneAndUpdate', function() { throw new Error('Audit logs cannot be modified'); });
AuditLogSchema.index({ actorId: 1, timestamp: -1 });
AuditLogSchema.index({ documentId: 1, timestamp: -1 });
AuditLogSchema.index({ supervisorIdAtTime: 1, timestamp: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
