import mongoose, { Document, Schema } from 'mongoose';

export type EmailStatus =
  | 'pending'
  | 'sent'
  | 'failed';

export interface IEmailLog extends Document {
  _id: mongoose.Types.ObjectId;

  senderId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;

  toEmail: string;

  subject: string;
  body: string;
  bodyPreview: string;

  status: EmailStatus;
  error?: string;

  sentAt?: Date;

  // Optional tracking (future-ready)
  messageId?: string; // SMTP / provider ID

  createdAt: Date;
  updatedAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
  {
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    receiverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    toEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    subject: {
      type: String,
      required: true,
      trim: true,
      default: '(No subject)',
    },

    body: {
      type: String,
      required: true,
    },

    bodyPreview: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending',
      index: true,
    },

    error: {
      type: String,
    },

    sentAt: {
      type: Date,
    },

    messageId: {
      type: String,
    },
  },
  { timestamps: true }
);

EmailLogSchema.index({ senderId: 1, createdAt: -1 });
EmailLogSchema.index({ receiverId: 1, createdAt: -1 });
EmailLogSchema.index({ status: 1, createdAt: -1 });

export const EmailLog = mongoose.model<IEmailLog>('EmailLog', EmailLogSchema);