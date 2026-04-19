export type UserRole = 'ceo' | 'supervisor' | 'user';
export type AccountStatus = 'pending' | 'active' | 'rejected' | 'disabled';
export type DocumentStatus = 'draft' | 'in_progress' | 'pending_completion' | 'completed' | 'archived';
export type DocumentPriority = 'low' | 'medium' | 'high' | 'critical';
export type AuditAction = 'created' | 'viewed' | 'edited' | 'submitted' | 'completed' | 'invited' | 'access_revoked' | 'deleted' | 'downloaded' | 'email_sent';
export type MappingStatus = 'active' | 'historical';

export interface JwtPayload {
  userId: string;
  role: UserRole;
  email: string;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  error?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
