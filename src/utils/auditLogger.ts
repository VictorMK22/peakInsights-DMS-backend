import { AuditLog } from '../models/AuditLog';
import { SupervisorMapping } from '../models/SupervisorMapping';
import { AuditAction } from '../types';
import mongoose from 'mongoose';

interface AuditParams {
  documentId?: string;
  actorId: string;
  action: AuditAction;
  targetUserId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export const createAuditLog = async (params: AuditParams): Promise<void> => {
  try {
    // Find the active supervisor for the actor at this timestamp
    const mapping = await SupervisorMapping.findOne({
      subordinateId: new mongoose.Types.ObjectId(params.actorId),
      status: 'active',
    }).select('supervisorId');

    await AuditLog.create({
      ...params,
      documentId: params.documentId ? new mongoose.Types.ObjectId(params.documentId) : undefined,
      actorId: new mongoose.Types.ObjectId(params.actorId),
      targetUserId: params.targetUserId ? new mongoose.Types.ObjectId(params.targetUserId) : undefined,
      supervisorIdAtTime: mapping?.supervisorId,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('Failed to create audit log:', err);
  }
};
