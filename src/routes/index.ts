import { Router } from 'express';
import authRoutes from './auth';
import userRoutes from './users';
import documentRoutes from './documents';
import analyticsRoutes from './analytics';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/documents', documentRoutes);
router.use('/analytics', analyticsRoutes);

export default router;
