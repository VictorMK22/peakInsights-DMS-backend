import mongoose, { Document, Schema } from 'mongoose';
import { MappingStatus } from '../types';

export interface ISupervisorMapping extends Document {
  supervisorId: mongoose.Types.ObjectId;
  subordinateId: mongoose.Types.ObjectId;
  departmentName: string;
  assignmentDate: Date;
  deactivationDate?: Date;
  status: MappingStatus;
  assignedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SupervisorMappingSchema = new Schema<ISupervisorMapping>({
  supervisorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  subordinateId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  departmentName: { type: String, required: true, trim: true },
  assignmentDate: { type: Date, required: true, default: Date.now },
  deactivationDate: { type: Date },
  status: { type: String, enum: ['active', 'historical'], default: 'active' },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

SupervisorMappingSchema.index({ supervisorId: 1, status: 1 });
SupervisorMappingSchema.index({ subordinateId: 1, status: 1 });

export const SupervisorMapping = mongoose.model<ISupervisorMapping>('SupervisorMapping', SupervisorMappingSchema);
