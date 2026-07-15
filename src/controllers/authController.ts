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
} from "../services/emailService";
import crypto from "crypto";

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
    const result = await loginUser(email, password);

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

export const forgotPassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email } = req.body as { email: string };
    const user = await User.findOne({ email });

    // Always respond the same way — don't reveal whether email exists
    if (!user) {
      res.json({
        success: true,
        message: "If that email exists, a reset link has been sent.",
      });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    user.passwordResetToken = resetTokenHash;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save({ validateBeforeSave: false });

    try {
      await sendPasswordResetEmail(user.email, user.name, resetToken);
    } catch (mailErr) {
      // Don't let an SMTP hiccup reveal account existence or change the
      // response shape — but do log it, since otherwise this fails
      // completely silently and nobody can reset their password.
      console.error("❌ sendPasswordResetEmail failed:", mailErr);
    }

    const resetUrl = `${process.env["FRONTEND_URL"] ?? "http://localhost:5173"}/reset-password?token=${resetToken}&email=${email}`;

    res.json({
      success: true,
      message: "If that email exists, a reset link has been sent.",
      // Remove in production — only for development convenience:
      dev_resetUrl:
        process.env["NODE_ENV"] === "production" ? undefined : resetUrl,
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
    });

    if (!user) {
      res.status(400).json({
        success: false,
        message: "Reset link is invalid or has expired.",
      });
      return;
    }

    user.password = newPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    sendPasswordChangedEmail(user.email, user.name).catch((err) =>
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
