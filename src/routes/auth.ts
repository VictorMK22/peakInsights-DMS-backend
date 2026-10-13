import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  login,
  loginValidation,
  logout,
  getMe,
  changePassword,
  forgotPassword,
  forgotPasswordValidation,
  resetPassword,
  resetPasswordValidation,
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

// forgot-password ALWAYS answers 200 (so it can't leak which emails exist),
// which means authLimiter's skipSuccessfulRequests would never count it and
// it would be unlimited — an email-bombing vector. It gets its own limiter
// that counts every request. (In-memory per instance: best-effort on
// serverless; use a shared store such as Redis if you need a hard cap.)
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many reset requests. Please try again later.",
  },
});

router.post("/login", authLimiter, loginValidation, login);
router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  forgotPasswordValidation,
  forgotPassword,
);
router.post(
  "/reset-password",
  authLimiter,
  resetPasswordValidation,
  resetPassword,
);
router.post("/logout", authenticate, logout); // POST — blacklists the token
router.get("/me", authenticate, getMe);
router.put("/change-password", authenticate, changePassword);

export default router;
