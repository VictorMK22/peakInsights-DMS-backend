import { Request } from "express";
import { UserRole } from "../types";

export interface AuthRequest extends Request {
    user?: {
      userId: string;
      role: UserRole;
      email: string;
    };
    token?: string;
  }