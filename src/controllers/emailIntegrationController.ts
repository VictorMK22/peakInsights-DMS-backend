import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest } from "../types/auth";
import { EmailIntegrationModel, setTokens } from "../models/EmailIntegration";
import {
  isZohoConfigured,
  buildZohoAuthUrl,
  exchangeCodeForTokens,
  fetchZohoAccount,
} from "../services/zohoMailService";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const signState = (userId: string) => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  // Short-lived — this only needs to survive the OAuth consent round trip
  return jwt.sign({ userId, purpose: "zoho_connect" }, process.env.JWT_SECRET, {
    expiresIn: "10m",
  });
};

const verifyState = (state: string): string => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");
  const decoded = jwt.verify(state, process.env.JWT_SECRET) as {
    userId: string;
    purpose: string;
  };
  if (decoded.purpose !== "zoho_connect") throw new Error("Invalid state");
  return decoded.userId;
};

// GET /integrations/zoho/connect — authenticated. Returns an authUrl for
// the frontend to redirect the browser to (can't do the redirect directly
// here, since this call carries our JWT as a header, which a plain browser
// navigation to Zoho wouldn't have anywhere to put).
export const connectZoho = (req: AuthRequest, res: Response) => {
  if (!isZohoConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        "Zoho integration is not configured on the server (missing ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REDIRECT_URI)",
    });
  }
  const state = signState(req.user!.userId);
  return res.json({
    success: true,
    data: { authUrl: buildZohoAuthUrl(state) },
  });
};

// GET /integrations/zoho/callback — PUBLIC. Zoho redirects the user's
// browser here directly after they accept/deny the consent screen.
export const zohoCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.redirect(`${FRONTEND_URL}/profile?zoho=denied`);
  }

  try {
    const userId = verifyState(state);
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Happens if the user previously connected without revoking access
      // first — Zoho only issues a refresh token on the *first* consent.
      return res.redirect(`${FRONTEND_URL}/profile?zoho=reauth_required`);
    }
    const account = await fetchZohoAccount(tokens.access_token);

    const integration =
      (await EmailIntegrationModel.findOne({ userId })) ||
      new EmailIntegrationModel({ userId, provider: "zoho" });

    integration.emailAddress = account.emailAddress;
    integration.providerAccountId = account.accountId;
    setTokens(
      integration,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
    );
    integration.status = "connected";
    integration.lastError = undefined;
    await integration.save();

    return res.redirect(`${FRONTEND_URL}/profile?zoho=connected`);
  } catch (err) {
    console.error("Zoho OAuth callback failed:", err);
    return res.redirect(`${FRONTEND_URL}/profile?zoho=error`);
  }
};

// GET /integrations/zoho/status — the current user's own connection state
export const getIntegrationStatus = async (req: AuthRequest, res: Response) => {
  const integration = await EmailIntegrationModel.findOne({
    userId: req.user!.userId,
  }).select("emailAddress status lastSyncedAt lastError");
  return res.json({
    success: true,
    data: {
      configured: isZohoConfigured(),
      integration: integration || null,
    },
  });
};

// POST /integrations/zoho/disconnect
export const disconnectZoho = async (req: AuthRequest, res: Response) => {
  await EmailIntegrationModel.findOneAndUpdate(
    { userId: req.user!.userId },
    { status: "disconnected" },
  );
  return res.json({ success: true });
};

// GET /integrations/zoho/all — CEO-only. Lets the executive see who on
// the team has actually connected their mailbox, since this whole feature
// depends on opt-in — visibility of *coverage*, not just of messages.
export const getAllIntegrations = async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== "ceo" && req.user!.role !== "tech") {
    return res.status(403).json({ success: false, message: "CEO only" });
  }
  const integrations = await EmailIntegrationModel.find()
    .populate("userId", "name email role")
    .select("userId emailAddress status lastSyncedAt lastError")
    .lean();
  return res.json({ success: true, data: { integrations } });
};
