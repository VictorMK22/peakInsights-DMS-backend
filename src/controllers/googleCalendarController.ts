import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../types/auth";
import {
  GoogleCalendarAccountModel,
  setTokens,
} from "../models/GoogleCalendarAccount";
import {
  isGoogleCalendarConfigured,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  fetchGoogleEmail,
} from "../services/googleCalendarService";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const signState = (userId: string) => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  return jwt.sign(
    { userId, purpose: "google_calendar_connect" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );
};

const verifyState = (state: string): string => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  const decoded = jwt.verify(state, process.env.JWT_SECRET) as {
    userId: string;
    purpose: string;
  };
  if (decoded.purpose !== "google_calendar_connect")
    throw new Error("Invalid state");
  return decoded.userId;
};

// GET /integrations/google-calendar/connect — authenticated. Returns an
// authUrl for the frontend to open (can't redirect directly since this
// call carries our own JWT as a header, not something a plain browser
// navigation to Google would have anywhere to put).
export const connectGoogleCalendar = (req: AuthRequest, res: Response) => {
  if (!isGoogleCalendarConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        "Google Calendar isn't configured on the server (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)",
    });
  }
  const state = signState(req.user!.userId);
  return res.json({
    success: true,
    data: { authUrl: buildGoogleAuthUrl(state) },
  });
};

// GET /integrations/google-calendar/callback — PUBLIC. Google redirects
// the user's browser here directly after they accept/deny consent.
export const googleCalendarCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.redirect(`${FRONTEND_URL}/profile?google_calendar=denied`);
  }

  try {
    const userId = verifyState(state);
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Happens if the user previously connected without revoking
      // access first — Google only issues a refresh token on the
      // *first* consent for a given client/user pair.
      return res.redirect(
        `${FRONTEND_URL}/profile?google_calendar=reauth_required`,
      );
    }
    const googleEmail = await fetchGoogleEmail(tokens.access_token);

    const account =
      (await GoogleCalendarAccountModel.findOne({ userId })) ||
      new GoogleCalendarAccountModel({ userId });

    account.googleEmail = googleEmail;
    setTokens(
      account,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
    );
    account.status = "connected";
    account.lastError = undefined;
    await account.save();

    return res.redirect(`${FRONTEND_URL}/profile?google_calendar=connected`);
  } catch (err) {
    console.error("Google Calendar OAuth callback failed:", err);
    return res.redirect(`${FRONTEND_URL}/profile?google_calendar=error`);
  }
};

// GET /integrations/google-calendar/status
export const getGoogleCalendarStatus = async (
  req: AuthRequest,
  res: Response,
) => {
  const account = await GoogleCalendarAccountModel.findOne({
    userId: req.user!.userId,
  }).select("googleEmail status lastError");
  return res.json({
    success: true,
    data: {
      configured: isGoogleCalendarConfigured(),
      account: account || null,
    },
  });
};

// POST /integrations/google-calendar/disconnect
export const disconnectGoogleCalendar = async (
  req: AuthRequest,
  res: Response,
) => {
  await GoogleCalendarAccountModel.findOneAndUpdate(
    { userId: req.user!.userId },
    { status: "disconnected" },
  );
  return res.json({ success: true });
};
