import { Router } from 'express';
import { login, loginValidation, logout, getMe, changePassword, forgotPassword, resetPassword } from '../controllers/authController';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post('/login', loginValidation, login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/logout', authenticate, logout);       // POST — blacklists the token
router.get('/me', authenticate, getMe);
router.put('/change-password', authenticate, changePassword);

export default router;
