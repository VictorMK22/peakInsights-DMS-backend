import { Response, NextFunction } from "express";
import { body, validationResult } from "express-validator";
import jwt from "jsonwebtoken";
import { loginUser } from "../services/authService";
import { AuthRequest } from "../types/auth";
import { User } from "../models/User";
import { TokenBlacklist } from "../models/TokenBlacklist";
import { JwtPayload } from "../types";
import {
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  buildPasswordResetUrl,
} from "../services/emailService";
import crypto from "crypto";
import { SecurityEvent } from "../models/SecurityEvent";

// Best-effort security event logging — never allowed to affect the
// actual login outcome, so every call site wraps this in a swallowed
// catch. This is what powers the ICT Security Center's "real" login
// activity feed instead of it being purely manual/mock data.
const logSecurityEvent = (data: {
  type: "login" | "failed_login";
  actor?: string;
  actorLabel?: string;
  detail: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  ipAddress?: string;
}) => {
  SecurityEvent.create(data).catch(() => {
    /* logging must never break auth */
  });
};

export const loginValidation = [
  body("email")
    .isEmail()
    .withMessage("Valid email required")
    .trim()
    .toLowerCase(),

  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
];

export const login = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({
        success: false,
        message: "Validation error",
        errors: errors.array(),
      });
      return;
    }

    const { email, password } = req.body as { email: string; password: string };
    let result;
    try {
      result = await loginUser(email, password);
    } catch (loginErr) {
      logSecurityEvent({
        type: "failed_login",
        actorLabel: email,
        detail: `Failed login attempt for ${email}`,
        severity: "low",
        ipAddress: req.ip,
      });
      throw loginErr;
    }

    logSecurityEvent({
      type: "login",
      actor: result.user._id?.toString(),
      actorLabel: result.user.name,
      detail: `${result.user.name} logged in`,
      severity: "info",
      ipAddress: req.ip,
    });

    res.json({ success: true, message: "Login successful", data: result });
  } catch (err) {
    next(err);
  }
};

export const logout = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const token = req.token; // attached by authenticate middleware
    if (!token) {
      res
        .status(400)
        .json({ success: false, message: "No active token found" });
      return;
    }

    // Decode to get expiry so we can set the TTL correctly (no point storing it longer than needed)
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not set");
    }
    const secret = process.env.JWT_SECRET;
    const decoded = jwt.verify(token, secret) as JwtPayload & { exp?: number };
    const expiresAt = decoded.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await TokenBlacklist.create({
      token,
      userId: req.user?.userId,
      expiresAt,
    });

    res.json({
      success: true,
      message: "Logged out successfully. Token has been revoked.",
    });
  } catch (err) {
    next(err);
  }
};

export const getMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = await User.findById(req.user?.userId).select("-password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.json({ success: true, message: "User retrieved", data: { user } });
  } catch (err) {
    next(err);
  }
};

export const changePassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };
    const user = await User.findById(req.user?.userId).select("+password");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      res
        .status(400)
        .json({ success: false, message: "Current password is incorrect" });
      return;
    }

    user.password = newPassword;
    await user.save();

    sendPasswordChangedEmail(user.email, user.name).catch((err) =>
      console.error(
        "❌ sendPasswordChangedEmail failed (password still changed):",
        err,
      ),
    );

    // Blacklist current token so they must re-login with new password
    const token = req.token;
    if (token) {
      if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET is not set");
      }
      const secret = process.env.JWT_SECRET;

      const decoded = jwt.verify(token, secret) as JwtPayload & {
        exp?: number;
      };
      const expiresAt = decoded.exp
        ? new Date(decoded.exp * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await TokenBlacklist.create({
        token,
        userId: req.user?.userId,
        expiresAt,
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: "Password changed successfully. Please log in again.",
    });
  } catch (err) {
    next(err);
  }
};

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
// Minimum gap between reset emails for the same account. Stops someone
// mail-bombing a victim from many IPs; the earlier link stays valid.
const RESET_EMAIL_COOLDOWN_MS = 2 * 60 * 1000;

const FORGOT_GENERIC_MESSAGE =
  "If that email exists, a reset link has been sent.";

/** Returns the first validation message as a 400, or false if all good. */
const rejectIfInvalid = (req: AuthRequest, res: Response): boolean => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    success: false,
    message: errors.array()[0]?.msg ?? "Validation error",
    errors: errors.array(),
  });
  return true;
};

export const forgotPasswordValidation = [
  body("email")
    .isString()
    .withMessage("Valid email required")
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage("Valid email required"),
];

export const resetPasswordValidation = [
  body("email")
    .isString()
    .withMessage("Valid email required")
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage("Valid email required"),
  body("token")
    .isString()
    .isHexadecimal()
    .isLength({ min: 64, max: 64 })
    .withMessage("Reset link is invalid or has expired."),
  body("newPassword")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be between 8 and 128 characters"),
];

export const forgotPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (rejectIfInvalid(req, res)) return;
    const { email } = req.body as { email: string };

    // Always respond the same way — don't reveal whether the email exists,
    // is deactivated, or was rate-limited per account.
    const generic = () =>
      res.json({ success: true, message: FORGOT_GENERIC_MESSAGE });

    const user = await User.findOne({ email }).select(
      "+passwordResetToken +passwordResetExpires",
    );
    if (!user || !user.isActive || user.accountStatus !== "active") {
      generic();
      return;
    }

    if (user.passwordResetExpires) {
      const issuedAt = user.passwordResetExpires.getTime() - RESET_TOKEN_TTL_MS;
      if (Date.now() - issuedAt < RESET_EMAIL_COOLDOWN_MS) {
        generic();
        return;
      }
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.passwordResetToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    user.passwordResetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await user.save({ validateBeforeSave: false });

    // Awaited on purpose: on Vercel the function is frozen once the
    // response is sent, so a fire-and-forget send would be dropped.
    const sent = await sendPasswordResetEmail(
      user.email,
      user.name,
      resetToken,
    ).catch((mailErr) => {
      console.error("❌ sendPasswordResetEmail threw:", mailErr);
      return false;
    });
    if (!sent) {
      console.error(
        `❌ Password reset email NOT delivered to ${user.email} — check RESEND_API_KEY / MAIL_FROM_DOMAIN`,
      );
    }

    res.json({
      success: true,
      message: FORGOT_GENERIC_MESSAGE,
      // Local development convenience ONLY. Must be an explicit
      // "development" — if NODE_ENV is unset this would otherwise hand a
      // working reset link (account takeover) to anyone who asks.
      ...(process.env["NODE_ENV"] === "development" && {
        dev_resetUrl: buildPasswordResetUrl(resetToken, user.email),
      }),
    });
  } catch (err) {
    next(err);
  }
};

export const resetPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (rejectIfInvalid(req, res)) return;
    const { token, email, newPassword } = req.body as {
      token: string;
      email: string;
      newPassword: string;
    };

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      email,
      passwordResetToken: tokenHash,
      passwordResetExpires: { $gt: new Date() },
    }).select("+passwordResetToken +passwordResetExpires");

    if (!user || !user.isActive || user.accountStatus !== "active") {
      res.status(400).json({
        success: false,
        message: "Reset link is invalid or has expired.",
      });
      return;
    }

    // The save hook hashes the password and stamps passwordChangedAt,
    // which invalidates every session issued before this reset.
    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    await sendPasswordChangedEmail(user.email, user.name).catch((err) =>
      console.error(
        "❌ sendPasswordChangedEmail failed (password still reset):",
        err,
      ),
    );

    res.json({
      success: true,
      message: "Password reset successfully. You can now sign in.",
    });
  } catch (err) {
    next(err);
  }
};
