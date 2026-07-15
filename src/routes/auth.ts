import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  login,
  loginValidation,
  logout,
  getMe,
  changePassword,
  forgotPassword,
  resetPassword,
} from "../controllers/authController";
import { authenticate } from "../middleware/auth";

const router = Router();

// The app-wide rate limiter (see index.ts) is sized generously to
// accommodate folder uploads (500 req/15min per IP) and gives no real
// protection against password guessing. These endpoints get their own,
// much tighter limit instead.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many attempts, please try again later.",
  skipSuccessfulRequests: true, // only count failed attempts toward the limit
});

router.post("/login", authLimiter, loginValidation, login);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", authLimiter, resetPassword);
router.post("/logout", authenticate, logout); // POST — blacklists the token
router.get("/me", authenticate, getMe);
router.put("/change-password", authenticate, changePassword);

export default router;
