export type UserRole = "ceo" | "supervisor" | "user" | "sales_person";
export type DocumentStatus =
  | "draft"
  | "in_progress"
  | "pending_completion"
  | "completed"
  | "archived";
export type DocumentPriority = "low" | "medium" | "high" | "critical";
export type AuditAction =
  | "created"
  | "viewed"
  | "edited"
  | "submitted"
  | "completed"
  | "invited"
  | "access_revoked"
  | "deleted"
  | "downloaded"
  | "email_sent"
  | "email_failed"
  | "trashed"
  | "restored"
  | "permanently_deleted"
  | "copied"
  | "starred"
  | "unstarred"
  | "moved";
export type MappingStatus = "active" | "historical";

export interface User {
  color: string;
  bio?: string;
  phone?: string;
  profilePicture?: string;
  _id: string;
  name: string;
  email: string;
  role: UserRole;
  department?: string;
  isActive: boolean;
  accountStatus: "pending" | "active" | "rejected";
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Department {
  _id: string;
  name: string;
  description?: string;
  isActive: boolean;
  userCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupervisorMapping {
  _id: string;
  supervisorId: User;
  subordinateId: User;
  departmentName: string;
  assignmentDate: string;
  deactivationDate?: string;
  status: MappingStatus;
  createdAt: string;
}

export interface LearningCategory {
  _id: string;
  name: string;
  description?: string;
  icon?: string;
  color: string;
  order: number;
  isActive: boolean;
  resourceCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearningPathItem {
  documentId: string;
  order: number;
  note?: string;
  document?: {
    _id: string;
    title: string;
    fileType: string;
    fileName: string;
    tags?: string[];
  } | null;
  hasRead?: boolean;
}

export interface LearningPath {
  _id: string;
  title: string;
  description?: string;
  categoryId?: LearningCategory | string;
  items: LearningPathItem[];
  isPublished: boolean;
  createdBy: User | string;
  itemCount?: number;
  completedCount?: number;
  progressPercent?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  _id: string;
  title: string;
  description?: string;
  fileType: string;
  fileName: string;
  fileKey: string;
  fileUrl: string;
  fileSize: number;
  modifiedBy?: User;
  modifiedAt?: string;
  status: DocumentStatus;
  priority: DocumentPriority;
  ownerId: User;
  departmentId?: string;
  supervisorId?: User;
  supervisorApprovedBy?: User;
  supervisorApprovedAt?: string;
  completionRequestedAt?: string;
  completionRequestedBy?: string;
  documentType?: "working" | "storage" | "learning";
  // Read receipts — present when the API attaches them (document
  // list/detail endpoints). hasRead reflects the current user.
  hasRead?: boolean;
  readerCount?: number;
  // Learning-library category — populated object on read, plain id
  // string accepted on write.
  categoryId?: LearningCategory | string;
  targetCompletionTime?: string;
  startTime?: string;
  endTime?: string;
  tatMinutes?: number;
  targetTatMinutes?: number;
  efficiencyRatio?: number;
  accessControlList: User[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRead {
  _id: string;
  documentId: string;
  user: User;
  firstReadAt: string;
  lastReadAt: string;
  readCount: number;
}

export interface AuditLog {
  _id: string;
  documentId?: Document;
  actorId: User;
  action: AuditAction;
  targetUserId?: User;
  supervisorIdAtTime?: User;
  details?: Record<string, unknown>;
  ipAddress?: string;
  timestamp: string;
}

export interface DashboardStats {
  totalDocs: number;
  completedDocs: number;
  inProgressDocs: number;
  totalUsers: number;
  completionRate: string;
  avgEfficiency: string;
  avgTatMinutes: number;
}

export interface LeaderboardEntry {
  _id: string;
  avgEfficiency: number;
  totalDocs: number;
  avgTat: number;
  completedDocs: number;
  user: User;
}

export interface BottleneckEntry {
  _id: string;
  totalDocs: number;
  exceededCount: number;
  avgTatMinutes: number;
  avgTargetMinutes: number;
  avgEfficiency: number;
  bottleneckRate: number;
}

export interface TrendEntry {
  _id: string;
  avgEfficiency: number;
  totalCompleted: number;
  avgTat: number;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export type NotificationType =
  | "approval_request"
  | "approval_result"
  | "verification_request"
  | "verification_result"
  | "document_update"
  | "comment"
  | "assignment"
  | "system";

export type NotificationChannel = "in_app" | "email" | "sms";

export type MessageType = "sms" | "email";

export type MessageStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "failed"
  | "cancelled";

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  documentId?: string;
  read: boolean;
  createdAt: string;
  channels: NotificationChannel[];
}

export interface Message {
  id: string;
  type: MessageType;
  recipient: string;
  subject?: string;
  body: string;
  documentId?: string;
  status: MessageStatus;
  sentAt?: string;
  createdAt: string;
  attachments?: string[];
}

export interface NotificationPreferences {
  inApp: boolean;
  email: boolean;
  sms: boolean;
  frequency: "immediate" | "daily" | "weekly";
}
