import { Worker } from 'bullmq';
import path from 'path';
import fs from 'fs';
import { DocumentModel } from '../models/Document';
import { extractDocumentText } from '../utils/extractDocumentText';
import { redisConnection } from '../config/redisOptions';
import { getIO } from '../socket/socketServer';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads';

let worker: Worker | null = null;

if (redisConnection) {
  worker = new Worker(
    'document-processing',
    async (job) => {
      const { documentId, fileKey, fileType } = job.data as {
        documentId: string;
        fileKey: string;
        fileType: string;
      };

      try {
        const filePath = path.join(UPLOAD_DIR, fileKey);

        if (!fs.existsSync(filePath)) {
          console.warn(`⚠️ File not found: ${filePath}`);
          await DocumentModel.findByIdAndUpdate(documentId, {
            contentText: '',
            indexedAt: new Date(),
            status: 'processed',
          });
          return;
        }

        const buffer = fs.readFileSync(filePath);
        const contentText = await extractDocumentText(buffer, fileType);

        const updatedDoc = await DocumentModel.findByIdAndUpdate(
          documentId,
          { contentText, indexedAt: new Date(), status: 'processed' },
          { new: true }
        );

        console.log(`✅ Processed document ${documentId}`);

        try {
          const io = getIO();
          const docId  = updatedDoc?._id.toString();
          const userId = updatedDoc?.ownerId?.toString();

          io.to(`document:${docId}`).emit('documentProcessed', updatedDoc);
          if (userId) io.to(`user:${userId}`).emit('documentProcessed', updatedDoc);
        } catch {
          // ignore
        }

      } catch (err) {
        console.error('❌ Worker failed:', err);
        await DocumentModel.findByIdAndUpdate(documentId, { status: 'failed' });
        throw err;
      }
    },
    { connection: redisConnection }
  );

  worker.on('completed', (job) => console.log(`Job completed: ${job.id}`));
  worker.on('failed', (job, err) => console.error(`Job failed: ${job?.id}`, err));

  console.log("✅ Document worker started");
} else {
  console.log("⚠️ Worker disabled — Redis not configured");
}

export { worker };