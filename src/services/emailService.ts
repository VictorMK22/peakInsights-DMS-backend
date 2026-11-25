/**
 * services/emailService.ts
 *
 * Transactional emails for PeakInsights Hub.
 *
 * Account creation is CEO-only — there is no self-registration or
 * approval workflow. Accounts are created directly by the CEO and
 * are immediately active. There are therefore no pending / approved /
 * rejected account emails.
 *
 * Events covered:
 *   - Account created by CEO (user or supervisor, includes temp password)
 *   - Password reset request
 *   - Password changed notification
 *   - Task assigned
 *   - Task completed
 *   - Task collaboration invitation
 *   - New message notification
 */

import crypto from "crypto";
import { Resend } from "resend";
import { formatEatDateTime, formatEatWindow } from "../utils/eatTime";

/** What a successful send hands back to callers. */
interface SentMessageInfo {
  /** RFC 5322 Message-ID we stamped on the message — stored on EmailLog and
   *  used as In-Reply-To / References for the next reply in the thread. */
  messageId: string;
  /** Resend's own id for the email (useful when looking it up in their dashboard). */
  resendId?: string;
}

interface DirectEmailOptions {
  toEmail: string;
  /** Carbon-copy recipients (plain email addresses). */
  ccEmails?: string[];
  toName?: string;
  fromName?: string;
  fromEmail?: string;
  subject: string;
  body: string;
  /** Set when this send is a reply — makes it thread as a real email conversation. */
  inReplyTo?: string; // immediate parent's SMTP Message-ID
  references?: string[]; // accumulated Message-ID chain for the whole thread
  quoted?: {
    fromName: string;
    date: string; // pre-formatted, human readable
    body: string;
  };
  /** Files to attach — in-memory buffers (Vercel has no persistent disk), or a path/URL. */
  attachments?: MailAttachment[];
  /**
   * Blind-copy recipients. Used for announcements so one SMTP transaction
   * reaches many people without exposing anyone's address to the others.
   */
  bccEmails?: string[];
  /** Renders the "Announcement from …" layout instead of a 1:1 message. */
  broadcast?: boolean;
}

/** An attachment as Resend accepts it. Prefer `content` (Buffer) — `path` must be a public URL. */
type MailAttachment = {
  filename: string;
  content?: Buffer;
  path?: string;
  contentType?: string;
};

// ─── Transport (Resend) ───────────────────────────────────────────
//
// Required env vars:
//   RESEND_API_KEY      — from resend.com/api-keys
//   MAIL_FROM_DOMAIN    — the domain verified in Resend, e.g. peak-insights.com
// Optional:
//   MAIL_FROM_ADDRESS   — the one address all mail is sent from
//                         (defaults to peakinsights@<MAIL_FROM_DOMAIN>)

const MAIL_DOMAIN = (process.env.MAIL_FROM_DOMAIN ?? "").trim().toLowerCase();

/** True if Resend can send as this address (its domain is the verified one). */
export function canSendAs(address?: string): boolean {
  if (!address || !MAIL_DOMAIN) return false;
  const at = address.lastIndexOf("@");
  return (
    at > 0 &&
    address
      .slice(at + 1)
      .trim()
      .toLowerCase() === MAIL_DOMAIN
  );
}

/** Address used for system notifications and as the fallback sender. */
export function getDefaultFromAddress(): string {
  return (
    process.env.MAIL_FROM_ADDRESS?.trim() ||
    (MAIL_DOMAIN ? `peakinsights@${MAIL_DOMAIN}` : "")
  );
}

let resendClient: Resend | null = null;

function getClient(): Resend | null {
  if (resendClient) return resendClient;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !getDefaultFromAddress()) {
    console.warn(
      "⚠️  Resend not configured (RESEND_API_KEY / MAIL_FROM_DOMAIN) — emails will be skipped",
    );
    return null;
  }

  resendClient = new Resend(apiKey);
  return resendClient;
}

const cleanDisplayName = (name: string) =>
  name
    .replace(/[\r\n"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/**
 * Builds the visible From header. The address is always the shared one
 * (peakinsights@<domain>); when a person composed the email, their name is
 * shown in front of it, e.g.  Nelson Kyebei via PeakInsights Hub.
 * Replies go to that person's real address through Reply-To.
 */
function buildFrom(senderName?: string, fromAddress?: string): string {
  const name = cleanDisplayName(senderName ?? "");
  // Sending as a specific person's own mailbox: show exactly that person.
  if (fromAddress) return `"${name || fromAddress}" <${fromAddress}>`;
  const label = name ? `${name} via PeakInsights Hub` : "PeakInsights Hub";
  return `"${label}" <${getDefaultFromAddress()}>`;
}

// ─── Helpers ──────────────────────────────────────────────────────
const APP_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

/** Send a single email. Never throws unless `throwOnError` — logs on failure. */
async function send(
  to: string,
  subject: string,
  html: string,
  replyTo?: string,
  threading?: { inReplyTo?: string; references?: string[] },
  attachments?: MailAttachment[],
  opts?: {
    cc?: string[];
    bcc?: string[];
    throwOnError?: boolean;
    /** Name of the person who composed this email (shown in the From name). */
    fromName?: string;
    /** Send as this mailbox instead of the shared address. Caller must ensure its domain is verified in Resend. */
    fromAddress?: string;
  },
): Promise<SentMessageInfo | null> {
  const client = getClient();
  if (!client) {
    if (opts?.throwOnError) {
      throw new Error(
        "Email is not configured on the server (RESEND_API_KEY / MAIL_FROM_DOMAIN missing)",
      );
    }
    return null;
  }

  // We choose the Message-ID ourselves so we can store it and use it for
  // In-Reply-To / References on the next reply in the thread.
  const messageId = `<${crypto.randomUUID()}@${MAIL_DOMAIN}>`;

  // Standard RFC 5322 threading headers — these make a reply show up in the
  // same conversation in the recipient's real inbox (Gmail, Outlook, …).
  const headers: Record<string, string> = { "Message-ID": messageId };
  if (threading?.inReplyTo) headers["In-Reply-To"] = threading.inReplyTo;
  if (threading?.references?.length) {
    headers["References"] = threading.references.join(" ");
  }

  try {
    // The Resend SDK reports API failures through `error` instead of throwing.
    const { data, error } = await client.emails.send({
      from: buildFrom(opts?.fromName, opts?.fromAddress),
      to,
      cc: opts?.cc?.length ? opts.cc : undefined,
      bcc: opts?.bcc?.length ? opts.bcc : undefined,
      subject,
      html,
      replyTo,
      headers,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        path: a.path,
        contentType: a.contentType,
      })),
    });

    if (error) {
      throw new Error(`${error.name}: ${error.message}`);
    }

    console.log(`📧 Email sent → ${to}: ${subject}`);
    return { messageId, resendId: data?.id };
  } catch (err) {
    console.error(`❌ Email failed → ${to}: ${subject}`, err);
    if (opts?.throwOnError) throw err;
    return null;
  }
}

// ─── HTML wrapper ─────────────────────────────────────────────────

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#0ea5e9,#7c3aed);padding:28px 32px;">
            <p style="margin:0;font-size:22px;font-weight:700;color:#fff;letter-spacing:-.5px;">⚡ PeakInsights Hub</p>
            <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,.75);">Business Operations Hub</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">${body}</td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f1f5f9;background:#f8fafc;">
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
              This email was sent by PeakInsights Hub. If you didn't expect this, you can safely ignore it.<br />
              © ${new Date().getFullYear()} PeakInsights. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const h1 = (t: string) =>
  `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">${t}</h1>`;
const p = (t: string) =>
  `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.7;">${t}</p>`;
const btn = (text: string, href: string, color = "#0ea5e9") =>
  `<a href="${href}" style="display:inline-block;margin:8px 0 20px;padding:12px 28px;background:${color};color:#fff;font-size:14px;font-weight:600;border-radius:8px;text-decoration:none;">${text}</a>`;
/** Escapes text interpolated into HTML (names, temp passwords, etc.). */
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const info = (label: string, value: string) =>
  `<p style="margin:4px 0;font-size:14px;color:#475569;"><strong style="color:#0f172a;">${label}:</strong> ${value}</p>`;
const highlight = (text: string) =>
  `<div style="background:#f0f9ff;border-left:4px solid #0ea5e9;border-radius:4px;padding:12px 16px;margin:16px 0;font-size:14px;color:#0369a1;">${text}</div>`;

// ═════════════════════════════════════════════════════════════════
// ACCOUNT — CEO creation only
// There is no self-registration, pending approval, or rejection flow.
// The CEO creates accounts directly; they are immediately active.
// ═════════════════════════════════════════════════════════════════

/**
 * Sent when the CEO creates a user or supervisor account directly.
 * Includes the temporary password so the recipient can log in immediately.
 */
export async function sendAccountCreatedByCEOEmail(
  to: string,
  name: string,
  temporaryPassword: string,
  role: "supervisor" | "sales_person" | "accountant" | "tech",
  sender?: { name?: string; email?: string; role?: string },
): Promise<boolean> {
  // Sent FROM the CEO's own mailbox. Resend only accepts addresses on the
  // verified domain (MAIL_FROM_DOMAIN); if the CEO's address is elsewhere
  // (e.g. gmail.com) we fall back to the shared address, still showing the
  // CEO's name and replying to them, rather than failing to send at all.
  const senderName = sender?.name?.trim();
  const fromAddress = canSendAs(sender?.email) ? sender?.email : undefined;
  if (sender?.email && !fromAddress) {
    console.warn(
      `⚠️  CEO mailbox ${sender.email} is not on the verified domain (${MAIL_DOMAIN || "unset"}) — sending the invite from the shared address with Reply-To instead`,
    );
  }
  const senderLabel = senderName
    ? esc(senderName) + (sender?.role === "ceo" ? " (CEO)" : "")
    : "The CEO";
  const roleLabel =
    role === "sales_person"
      ? "Sales Person / Business Development Officer"
      : role === "accountant"
        ? "Accountant"
        : role === "tech"
          ? "Tech / Admin"
          : role;
  const sent = await send(
    to,
    "Your PeakInsights Hub account is ready",
    wrap(
      "Account Created",
      `
      ${h1("Welcome to PeakInsights Hub, " + esc(name) + "!")}
      ${p(senderLabel + " has created a <strong>" + roleLabel + "</strong> account for you. Your account is active immediately.")}
      ${info("Email", esc(to))}
      ${highlight(
        "<strong>Temporary password:</strong> " +
          `<code style="font-size:16px;letter-spacing:2px;">${esc(temporaryPassword)}</code>` +
          "<br/><br/>Please change your password after your first login.",
      )}
      ${btn("Log in Now", `${APP_URL}/login`, "#7c3aed")}
    `,
    ),
    sender?.email,
    undefined,
    undefined,
    { fromName: senderName, fromAddress },
  );
  return !!sent;
}

// ═════════════════════════════════════════════════════════════════
// PASSWORD
// ═════════════════════════════════════════════════════════════════

/** Builds the link emailed for a password reset (single source of truth). */
export function buildPasswordResetUrl(
  resetToken: string,
  email: string,
): string {
  return `${APP_URL}/reset-password?token=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(email)}`;
}

/** Sent when a user requests a password reset link. Resolves false if it could not be sent. */
export async function sendPasswordResetEmail(
  to: string,
  name: string,
  resetToken: string,
): Promise<boolean> {
  const resetUrl = buildPasswordResetUrl(resetToken, to);
  const sent = await send(
    to,
    "Reset your PeakInsights Hub password",
    wrap(
      "Password Reset",
      `
      ${h1("Password Reset Request")}
      ${p("Hi " + esc(name) + ", we received a request to reset your PeakInsights Hub password.")}
      ${btn("Reset My Password", resetUrl)}
      ${p('If the button doesn\'t work, copy this link into your browser:<br/><span style="word-break:break-all;font-size:12px;color:#64748b;">' + esc(resetUrl) + "</span>")}
      ${highlight("This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.")}
    `,
    ),
  );
  return !!sent;
}

/** Sent after a successful password change (via change-password endpoint). */
export async function sendPasswordChangedEmail(
  to: string,
  name: string,
  fromEmail?: string,
): Promise<void> {
  await send(
    to,
    "Your PeakInsights Hub password was changed",
    wrap(
      "Password Changed",
      `
      ${h1("Password Changed")}
      ${p("Hi " + esc(name) + ", your password was successfully updated.")}
      ${highlight("If you didn't make this change, please contact your administrator immediately.")}
      ${btn("Log in", `${APP_URL}/login`)}
    `,
    ),
    fromEmail,
  );
}

// ═════════════════════════════════════════════════════════════════
// TASKS
// ═════════════════════════════════════════════════════════════════

interface TaskEmailData {
  assigneeName: string;
  assigneeTo: string;
  assignerName: string;
  taskTitle: string;
  taskDescription?: string;
  priority: string;
  dueDate?: string;
  taskId: string;
}

/** Sent to the assignee when a task is created and assigned to them. */
export async function sendTaskAssignedEmail(
  data: TaskEmailData,
  fromEmail?: string,
): Promise<void> {
  const priorityColor: Record<string, string> = {
    low: "#64748b",
    medium: "#0ea5e9",
    high: "#f59e0b",
    critical: "#ef4444",
  };
  await send(
    data.assigneeTo,
    `📋 New task assigned: "${data.taskTitle}"`,
    wrap(
      "Task Assigned",
      `
      ${h1("You have a new task")}
      ${p("Hi " + data.assigneeName + ", " + data.assignerName + " has assigned you a new task.")}
      ${info("Task", data.taskTitle)}
      ${data.taskDescription ? info("Description", data.taskDescription) : ""}
      ${info(
        "Priority",
        `<span style="color:${priorityColor[data.priority] ?? "#0f172a"};font-weight:600;text-transform:uppercase;">${data.priority}</span>`,
      )}
      ${data.dueDate ? info("Due date", data.dueDate) : ""}
      ${highlight("When you're ready to start, open the task and set your <strong>target completion time</strong>. This becomes your personal commitment for appraisal.")}
      ${btn("View Task", `${APP_URL}/workspace/tasks`)}
    `,
    ),
    fromEmail,
  );
}

// ═════════════════════════════════════════════════════════════════
// CLIENTS
// ═════════════════════════════════════════════════════════════════

interface ClientAssignedEmailData {
  assigneeName: string;
  assigneeTo: string;
  /** Decides which workspace the button opens. */
  assigneeRole: string;
  assignerName: string;
  clients: { id: string; name: string }[];
}

const MAX_CLIENTS_LISTED = 15;

/** Sent to an accountant / accountant supervisor when the CEO assigns them clients. */
export async function sendClientAssignedEmail(
  data: ClientAssignedEmailData,
  fromEmail?: string,
): Promise<void> {
  const n = data.clients.length;
  if (n === 0) return;
  const base = data.assigneeRole === "supervisor" ? "supervisor" : "accountant";
  const link =
    n === 1
      ? `${APP_URL}/${base}/clients/${encodeURIComponent(data.clients[0].id)}`
      : `${APP_URL}/${base}/clients`;
  const listed = data.clients
    .slice(0, MAX_CLIENTS_LISTED)
    .map((c) => `<li style="margin:2px 0;">${esc(c.name)}</li>`)
    .join("");
  const more =
    n > MAX_CLIENTS_LISTED
      ? `<p style="margin:0 0 16px;font-size:14px;color:#475569;">…and ${n - MAX_CLIENTS_LISTED} more.</p>`
      : "";
  await send(
    data.assigneeTo,
    n === 1
      ? `👤 New client assigned: ${data.clients[0].name}`
      : `👤 ${n} new clients assigned to you`,
    wrap(
      "Client Assigned",
      `
      ${h1(n === 1 ? "You have a new client" : `You have ${n} new clients`)}
      ${p("Hi " + esc(data.assigneeName) + ", " + esc(data.assignerName) + " has assigned " + (n === 1 ? "a client" : "clients") + " to you.")}
      ${
        n === 1
          ? info("Client", esc(data.clients[0].name))
          : `<ul style="margin:0 0 12px;padding-left:20px;font-size:14px;color:#0f172a;">${listed}</ul>${more}`
      }
      ${btn(n === 1 ? "View Client" : "View My Clients", link)}
    `,
    ),
    fromEmail,
  );
}

/** Sent to the assigner when the task is completed by the assignee. */
export async function sendTaskCompletedEmail(
  to: string,
  assignerName: string,
  taskTitle: string,
  assigneeName: string,
  efficiencyRatio?: number,
  fromEmail?: string,
): Promise<void> {
  const effStr =
    efficiencyRatio != null
      ? `<br/>Efficiency ratio: <strong>${efficiencyRatio.toFixed(3)}×</strong> (${efficiencyRatio >= 1 ? "✅ on or ahead of target" : "⚠️ over target"})`
      : "";
  await send(
    to,
    `✅ Task completed: "${taskTitle}"`,
    wrap(
      "Task Completed",
      `
      ${h1("Task Completed")}
      ${p("Hi " + assignerName + ", " + assigneeName + " has completed the task.")}
      ${info("Task", taskTitle)}
      ${highlight(assigneeName + " finished the task." + effStr)}
      ${btn("View Task Details", `${APP_URL}/tasks`)}
    `,
    ),
    fromEmail,
  );
}

/** Sent to the invitee when they are added as a task collaborator. */
export async function sendTaskCollaborationInviteEmail(
  to: string,
  inviteeName: string,
  inviterName: string,
  taskTitle: string,
  fromEmail?: string,
): Promise<void> {
  await send(
    to,
    `🤝 You've been invited to collaborate on "${taskTitle}"`,
    wrap(
      "Collaboration Invite",
      `
      ${h1("Collaboration Invitation")}
      ${p("Hi " + inviteeName + ", " + inviterName + " has invited you to help with a task.")}
      ${info("Task", taskTitle)}
      ${highlight("Your access to the linked document will be <strong>automatically revoked</strong> once the task is completed or cancelled.")}
      ${btn("View the Task", `${APP_URL}/workspace/tasks`)}
    `,
    ),
    fromEmail,
  );
}

// ═════════════════════════════════════════════════════════════════
// MESSAGES
// ═════════════════════════════════════════════════════════════════

/** Sent when a user receives a new direct message. */
export async function sendNewMessageEmail(
  to: string,
  recipientName: string,
  senderName: string,
  subject?: string,
  bodyPreview?: string,
  fromEmail?: string,
): Promise<void> {
  await send(
    to,
    `💬 New message from ${senderName}${subject ? ": " + subject : ""}`,
    wrap(
      "New Message",
      `
      ${h1("New message from " + senderName)}
      ${p("Hi " + recipientName + ", you have a new message in PeakInsights Hub.")}
      ${subject ? info("Subject", subject) : ""}
      ${
        bodyPreview
          ? highlight(
              '"' +
                bodyPreview.slice(0, 200) +
                (bodyPreview.length > 200 ? "…" : "") +
                '"',
            )
          : ""
      }
      ${btn("Read & Reply", `${APP_URL}/workspace/messages`)}
    `,
    ),
    fromEmail,
  );
}

// ═════════════════════════════════════════════════════════════════
// DIRECT USER EMAIL
// ═════════════════════════════════════════════════════════════════

/**
 * Sends a direct email composed by a user (not a system notification).
 */

export async function sendDirectUserEmail(
  options: DirectEmailOptions,
): Promise<{ messageId?: string }> {
  const {
    toEmail,
    ccEmails,
    fromName = "A colleague",
    fromEmail,
    subject,
    body,
    inReplyTo,
    references,
    quoted,
    attachments,
    bccEmails,
    broadcast,
  } = options;

  const safeSubject = subject.slice(0, 150);
  const trimmedBody = body.slice(0, 5000);

  const escapeHtml = (input: string) =>
    input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  const safeBody = escapeHtml(trimmedBody).replace(/\n/g, "<br/>");
  const senderLine = fromName;

  // Real email clients render a reply as: the new text on top, then
  // the original message quoted underneath in an indented block —
  // e.g. "On Jan 4, 2026, Jane wrote: <quoted original>". Building
  // that here (instead of a generic "New Email Message" wrapper for
  // every reply) is what makes this actually feel like a real email
  // reply rather than another chat notification.
  const quoteBlock = quoted
    ? `
      <div style="margin-top:24px;padding-left:16px;border-left:3px solid #cbd5e1;color:#64748b;">
        <p style="margin:0 0 8px;font-size:13px;">On ${escapeHtml(quoted.date)}, ${escapeHtml(quoted.fromName)} wrote:</p>
        <p style="margin:0;font-size:14px;line-height:1.7;">${escapeHtml(quoted.body.slice(0, 3000)).replace(/\n/g, "<br/>")}</p>
      </div>`
    : "";

  // Plain new messages carry no "New message for …" banner; the
  // From/Cc/attachment lines are also omitted because the real email
  // headers and attachments already convey them.
  const heading = broadcast
    ? "Announcement from " + senderLine
    : quoted
      ? "Reply from " + senderLine
      : "";

  const result = await send(
    toEmail,
    safeSubject,
    wrap(
      broadcast ? "Announcement" : quoted ? "New Reply" : "New Email Message",
      `
      ${heading ? h1(heading) : ""}
      ${p(safeBody)}
      ${quoteBlock}
    `,
    ),
    // Reply-To is the real PeakInsights user, so a reply from the
    // recipient's mail client goes straight to them, not the shared address.
    fromEmail,
    { inReplyTo, references },
    attachments,
    // throwOnError so the real provider reason (invalid domain, rate limit,
    // not-configured…) lands in EmailLog.error instead of a generic message.
    {
      cc: ccEmails,
      bcc: bccEmails,
      throwOnError: true,
      fromName,
    },
  );

  if (!result?.messageId) {
    throw new Error("Email send failed");
  }

  // Logged only once the provider has accepted it (it used to log before
  // sending, which made failed sends look successful in the logs).
  console.log("📨 Direct Email Sent", {
    to: toEmail,
    from: fromEmail,
    subject: safeSubject,
    reply: !!inReplyTo,
    resendId: result.resendId,
    timestamp: new Date().toISOString(),
  });

  return { messageId: result.messageId };
}

// ═════════════════════════════════════════════════════════════════
// MEETINGS & CALENDAR
// ═════════════════════════════════════════════════════════════════

interface MeetingEmailData {
  toEmail: string;
  toName: string;
  meetingId: string;
  title: string;
  organizerName: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  meetingLink?: string;
  /** Password for the meeting link (Zoho Meeting asks guests for one). */
  meetingPassword?: string;
  /** "voice" = audio-only online meeting: the email says no camera is needed. */
  callType?: "video" | "voice";
  isRecurring?: boolean;
  /** True when this recipient has no login (external attendee) — swaps the CTA button for a plain "add to calendar" note instead of a deep link. */
  isExternal?: boolean;
  /**
   * Signed token (utils/meetingRsvpToken.ts) identifying this recipient for
   * this meeting. When present the email carries Accept / Decline buttons
   * that work without logging in; when absent it falls back to the old
   * "View & Respond" deep link (internal) / plain note (external).
   */
  rsvpToken?: string;
}

const formatMeetingWindow = (start: Date, end: Date) =>
  formatEatWindow(start, end);

/**
 * Meeting emails drop names, titles and locations straight into HTML. Those
 * are staff-typed for ordinary meetings, but a booking-link meeting carries
 * text typed into a PUBLIC form (the client's name becomes part of the
 * title) — so anyone could book under a victim's email address and have
 * this system send them an email containing the attacker's HTML or links.
 * Every free-text field is therefore escaped here, and a meeting link is
 * only kept when it is a plain http(s) URL (blocks javascript: and the like).
 * Use the result for the email BODY only — subjects are plain text.
 */
const escMeeting = <T extends MeetingEmailData & { reason?: string }>(
  data: T,
): T =>
  ({
    ...data,
    toName: esc(data.toName),
    title: esc(data.title),
    organizerName: esc(data.organizerName),
    location: data.location ? esc(data.location) : data.location,
    meetingLink:
      data.meetingLink && /^https?:\/\//i.test(data.meetingLink)
        ? esc(data.meetingLink)
        : undefined,
    reason: data.reason ? esc(data.reason) : data.reason,
    meetingPassword: data.meetingPassword ? esc(data.meetingPassword) : undefined,
    // Only the one known value is ever honoured, whatever was passed in.
    callType: data.callType === "voice" ? "voice" : undefined,
  }) as T;

const VOICE_CALL_NOTE = "Voice call (audio only, no camera needed)";

/**
 * Where the Accept / Decline buttons lead: the public response page in the
 * web app. Opening the page records nothing — the person confirms there
 * (and, for Decline, gives a reason) — so mail scanners that pre-fetch
 * every link can't answer on anyone's behalf.
 */
export const buildRsvpUrl = (
  token: string,
  action: "accept" | "tentative" | "decline",
): string =>
  `${APP_URL}/meeting-rsvp?token=${encodeURIComponent(token)}&action=${action}`;

const rsvpBlock = (token: string) => `
  <div style="margin:8px 0 4px;">
    <span style="display:inline-block;margin-right:10px;">${btn("✓ Accept", buildRsvpUrl(token, "accept"), "#16a34a")}</span>
    <span style="display:inline-block;margin-right:10px;">${btn("? Maybe", buildRsvpUrl(token, "tentative"), "#d97706")}</span>
    <span style="display:inline-block;">${btn("✕ Decline", buildRsvpUrl(token, "decline"), "#dc2626")}</span>
  </div>
  <p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.6;">
    No login needed. If you decline, you'll be asked to give the organizer a short reason.
  </p>`;

/** Sent to every internal + external invitee when a meeting is created. */
export async function sendMeetingInviteEmail(
  data: MeetingEmailData,
  fromEmail?: string,
): Promise<void> {
  const d = escMeeting(data);
  await send(
    data.toEmail,
    `📅 You're invited: "${data.title}"`,
    wrap(
      "Meeting Invitation",
      `
      ${h1("Meeting Invitation")}
      ${p("Hi " + d.toName + ", " + d.organizerName + " has invited you to a meeting.")}
      ${info("Title", d.title)}
      ${info("When", formatMeetingWindow(data.startTime, data.endTime) + (data.isRecurring ? " (recurring)" : ""))}
      ${d.location ? info("Location", d.location) : ""}
      ${d.meetingLink ? info("Meeting link", `<a href="${d.meetingLink}">${d.meetingLink}</a>`) : ""}
      ${d.meetingLink && d.meetingPassword ? info("Meeting password", d.meetingPassword) : ""}
      ${d.callType === "voice" ? info("Call type", VOICE_CALL_NOTE) : ""}
      ${data.rsvpToken ? p("<strong>Will you be there?</strong> Please let " + d.organizerName + " know:") + rsvpBlock(data.rsvpToken) : ""}
      ${
        data.isExternal
          ? highlight(
              "This invitation was sent to your email address. Please add it to your own calendar — you'll receive an email if it's rescheduled or cancelled.",
            )
          : data.rsvpToken
            ? ""
            : btn("View & Respond", `${APP_URL}/meetings`)
      }
    `,
    ),
    fromEmail,
  );
}

/** Sent when a meeting's time, location, or link changes materially. */
export async function sendMeetingUpdatedEmail(
  data: MeetingEmailData,
  fromEmail?: string,
): Promise<void> {
  const d = escMeeting(data);
  await send(
    data.toEmail,
    `🔄 Updated: "${data.title}"`,
    wrap(
      "Meeting Updated",
      `
      ${h1("Meeting Updated")}
      ${p("Hi " + d.toName + ", " + d.organizerName + " updated the meeting details.")}
      ${info("Title", d.title)}
      ${info("New time", formatMeetingWindow(data.startTime, data.endTime))}
      ${d.location ? info("Location", d.location) : ""}
      ${d.meetingLink ? info("Meeting link", `<a href="${d.meetingLink}">${d.meetingLink}</a>`) : ""}
      ${d.meetingLink && d.meetingPassword ? info("Meeting password", d.meetingPassword) : ""}
      ${d.callType === "voice" ? info("Call type", VOICE_CALL_NOTE) : ""}
      ${data.rsvpToken ? p("Your earlier response was cleared because the time changed. <strong>Can you still make it?</strong>") + rsvpBlock(data.rsvpToken) : ""}
      ${
        data.isExternal
          ? highlight("Please update your own calendar to match.")
          : data.rsvpToken
            ? ""
            : btn("View Meeting", `${APP_URL}/meetings`)
      }
    `,
    ),
    fromEmail,
  );
}

/** Sent when a meeting is postponed (optionally to a known new date). */
export async function sendMeetingPostponedEmail(
  data: MeetingEmailData & { postponedTo?: Date; reason?: string },
  fromEmail?: string,
): Promise<void> {
  const d = escMeeting(data);
  await send(
    data.toEmail,
    `⏸️ Postponed: "${data.title}"`,
    wrap(
      "Meeting Postponed",
      `
      ${h1("Meeting Postponed")}
      ${p("Hi " + d.toName + ", " + d.organizerName + " postponed this meeting.")}
      ${info("Title", d.title)}
      ${info("Was scheduled for", formatMeetingWindow(data.startTime, data.endTime))}
      ${
        data.postponedTo
          ? info(
              "Postponed to",
              formatEatDateTime(data.postponedTo),
            )
          : info("Postponed to", "New date to be confirmed")
      }
      ${d.reason ? info("Reason", d.reason) : ""}
      ${
        data.isExternal
          ? highlight("Please update your own calendar once a new time is confirmed.")
          : btn("View Meeting", `${APP_URL}/meetings`)
      }
    `,
    ),
    fromEmail,
  );
}

/** Sent when a meeting (or an occurrence of a series) is cancelled. */
export async function sendMeetingCancelledEmail(
  data: MeetingEmailData & { reason?: string },
  fromEmail?: string,
): Promise<void> {
  const d = escMeeting(data);
  await send(
    data.toEmail,
    `❌ Cancelled: "${data.title}"`,
    wrap(
      "Meeting Cancelled",
      `
      ${h1("Meeting Cancelled")}
      ${p("Hi " + d.toName + ", " + d.organizerName + " cancelled this meeting.")}
      ${info("Title", d.title)}
      ${info("Was scheduled for", formatMeetingWindow(data.startTime, data.endTime))}
      ${d.reason ? info("Reason", d.reason) : ""}
    `,
    ),
    fromEmail,
  );
}


// ═════════════════════════════════════════════════════════════════
// BOOKING LINKS — requests that wait for the host's approval
// Everything below is typed by the public (client name, topic, reason),
// so every value is escaped.
// ═════════════════════════════════════════════════════════════════

/** To a client right after they ask for a time that needs the host's OK. */
export async function sendBookingRequestReceivedEmail(data: {
  toEmail: string;
  toName: string;
  hostName: string;
  title: string;
  startTime: Date;
  endTime: Date;
  callType?: "video" | "voice";
}): Promise<void> {
  await send(
    data.toEmail,
    `🕓 Request received: "${data.title}"`,
    wrap(
      "Booking Request Received",
      `
      ${h1("Request received")}
      ${p("Hi " + esc(data.toName) + ", thanks — " + esc(data.hostName) + " will review your request and confirm by email.")}
      ${info("Meeting", esc(data.title))}
      ${info("Requested time", formatMeetingWindow(data.startTime, data.endTime))}
      ${data.callType === "voice" ? info("Call type", VOICE_CALL_NOTE) : ""}
      ${highlight("Nothing is confirmed yet. You'll receive a calendar invitation as soon as it's approved.")}
    `,
    ),
  );
}

/** To a client whose request the host couldn't accept. */
export async function sendBookingRequestDeclinedEmail(data: {
  toEmail: string;
  toName: string;
  hostName: string;
  title: string;
  startTime: Date;
  endTime: Date;
  reason?: string;
  rebookUrl?: string;
  /** Times the host offered instead; each link confirms that time in one click. */
  alternatives?: { label: string; url: string }[];
}): Promise<void> {
  await send(
    data.toEmail,
    `Update on your booking request: "${data.title}"`,
    wrap(
      "Booking Request Update",
      `
      ${h1("Your request couldn't be confirmed")}
      ${p("Hi " + esc(data.toName) + ", " + esc(data.hostName) + " isn't able to take this meeting at the time you asked for.")}
      ${info("Meeting", esc(data.title))}
      ${info("Requested time", formatMeetingWindow(data.startTime, data.endTime))}
      ${data.reason ? info("Note from " + esc(data.hostName), esc(data.reason)) : ""}
      ${
        data.alternatives?.length
          ? p(esc(data.hostName) + " suggested these times instead. Pick one to confirm it right away:") +
            data.alternatives.map((a) => btn(esc(a.label), esc(a.url))).join("") +
            p("These times are open now but not reserved for you, so please book soon.") +
            (data.rebookUrl ? p("None of them suit you?") + btn("Choose a different time", esc(data.rebookUrl)) : "")
          : data.rebookUrl
            ? p("You're welcome to choose another time:") + btn("Pick another time", esc(data.rebookUrl))
            : ""
      }
    `,
    ),
  );
}

/** To the host so a waiting request doesn't go unnoticed. */
export async function sendBookingRequestOwnerEmail(data: {
  toEmail: string;
  ownerName: string;
  clientName: string;
  clientEmail: string;
  title: string;
  startTime: Date;
  endTime: Date;
  topic?: string;
  callType?: "video" | "voice";
}): Promise<void> {
  await send(
    data.toEmail,
    `🕓 Booking request: ${data.clientName}`,
    wrap(
      "Booking Request",
      `
      ${h1("New booking request")}
      ${p("Hi " + esc(data.ownerName) + ", " + esc(data.clientName) + " asked to book a time with you. Nothing is confirmed until you approve it.")}
      ${info("Meeting", esc(data.title))}
      ${info("From", esc(data.clientName) + " (" + esc(data.clientEmail) + ")")}
      ${info("Requested time", formatMeetingWindow(data.startTime, data.endTime))}
      ${data.callType === "voice" ? info("Call type", VOICE_CALL_NOTE) : ""}
      ${data.topic ? info("Topic", esc(data.topic)) : ""}
      ${btn("Review request", `${APP_URL}/meetings`)}
      ${p("Open Meetings → Booking links to approve or decline.")}
    `,
    ),
  );
}

/** To a client whose request lapsed because the host didn't answer in time. */
export async function sendBookingRequestExpiredEmail(data: {
  toEmail: string;
  toName: string;
  hostName: string;
  title: string;
  startTime: Date;
  endTime: Date;
  rebookUrl?: string;
}): Promise<void> {
  await send(
    data.toEmail,
    `Your booking request has expired: "${data.title}"`,
    wrap(
      "Booking Request Expired",
      `
      ${h1("Your request wasn't confirmed in time")}
      ${p("Hi " + esc(data.toName) + ", " + esc(data.hostName) + " wasn't able to respond to your request in time, so the time you asked for has been released. Nothing has been booked.")}
      ${info("Meeting", esc(data.title))}
      ${info("Requested time", formatMeetingWindow(data.startTime, data.endTime))}
      ${data.rebookUrl ? p("You're welcome to request another time:") + btn("Choose a time", esc(data.rebookUrl)) : ""}
    `,
    ),
  );
}

/** To the host when a request has been waiting a while and will soon lapse. */
export async function sendBookingRequestReminderEmail(data: {
  toEmail: string;
  ownerName: string;
  clientName: string;
  clientEmail: string;
  title: string;
  startTime: Date;
  endTime: Date;
  expiresAt: Date;
}): Promise<void> {
  await send(
    data.toEmail,
    `⏰ Booking request still waiting: ${data.clientName}`,
    wrap(
      "Booking Request Reminder",
      `
      ${h1("A booking request is still waiting")}
      ${p("Hi " + esc(data.ownerName) + ", " + esc(data.clientName) + " is still waiting to hear back. If nobody replies, the request lapses and the time is released.")}
      ${info("Meeting", esc(data.title))}
      ${info("From", esc(data.clientName) + " (" + esc(data.clientEmail) + ")")}
      ${info("Requested time", formatMeetingWindow(data.startTime, data.endTime))}
      ${info("Lapses at", formatEatDateTime(data.expiresAt))}
      ${btn("Review request", `${APP_URL}/meetings`)}
    `,
    ),
  );
}

// ═════════════════════════════════════════════════════════════════
// SALES — weekly activity report (sent to the CEO by the weekly cron)
// ═════════════════════════════════════════════════════════════════

export interface SalesWeeklyReportEmailData {
  recipientName: string;
  periodLabel: string;
  /** Friday (start) of the reported week, YYYY-MM-DD — used to deep-link the report page. */
  from: string;
  totals: SalesReportRow;
  reps: (SalesReportRow & { name: string })[];
  pipeline: Record<string, number>;
}

interface SalesReportRow {
  leadsAdded: number;
  meetingsSet: number;
  meetingsDone: number;
  discussions: number;
  proposalsSent: number;
  won: number;
}

const STAGE_LABELS: Record<string, string> = {
  in_discussion: "In discussion",
  proposal_sent: "Proposal sent",
  awaiting_decision: "Awaiting decision",
  agreement_sent: "Agreement sent",
  won: "Won",
  lost: "Lost",
};

/** Weekly summary of the sales team's activity, sent to the CEO. */
export async function sendSalesWeeklyReportEmail(
  to: string,
  data: SalesWeeklyReportEmailData,
): Promise<void> {
  const th =
    'style="padding:8px 6px;text-align:right;font-size:12px;color:#64748b;border-bottom:2px solid #e2e8f0;"';
  const td = (bold = false) =>
    `style="padding:8px 6px;text-align:right;font-size:14px;color:#0f172a;border-bottom:1px solid #f1f5f9;${bold ? "font-weight:700;" : ""}"`;
  const row = (label: string, r: SalesReportRow, bold = false) => `
    <tr>
      <td style="padding:8px 6px;font-size:14px;color:#0f172a;border-bottom:1px solid #f1f5f9;${bold ? "font-weight:700;" : ""}">${esc(label)}</td>
      <td ${td(bold)}>${r.leadsAdded}</td>
      <td ${td(bold)}>${r.meetingsSet}</td>
      <td ${td(bold)}>${r.meetingsDone}</td>
      <td ${td(bold)}>${r.discussions}</td>
      <td ${td(bold)}>${r.proposalsSent}</td>
      <td ${td(bold)}>${r.won}</td>
    </tr>`;

  const table = `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;">
      <tr>
        <th style="padding:8px 6px;text-align:left;font-size:12px;color:#64748b;border-bottom:2px solid #e2e8f0;">Sales person</th>
        <th ${th}>Leads</th><th ${th}>Mtgs set</th><th ${th}>Mtgs done</th>
        <th ${th}>Talks</th><th ${th}>Proposals</th><th ${th}>Won</th>
      </tr>
      ${data.reps.map((r) => row(r.name, r)).join("")}
      ${data.reps.length ? row("Team total", data.totals, true) : ""}
    </table>`;

  const pipeline = Object.entries(data.pipeline)
    .map(([k, v]) => `${esc(STAGE_LABELS[k] ?? k)}: <strong>${v}</strong>`)
    .join(" &nbsp;·&nbsp; ");

  await send(
    to,
    `📈 Sales team weekly report — ${data.periodLabel}`,
    wrap(
      "Sales Weekly Report",
      `
      ${h1("Sales team weekly report")}
      ${p("Hi " + esc(data.recipientName) + ", here is what the sales team did during <strong>" + esc(data.periodLabel) + "</strong>.")}
      ${data.reps.length ? table : p("No active sales people to report on.")}
      <p style="margin:0 0 16px;font-size:12px;color:#94a3b8;">Talks = calls + emails and WhatsApp messages sent to clients.</p>
      ${pipeline ? highlight("<strong>Pipeline right now</strong><br />" + pipeline) : ""}
      ${btn("Open full report", `${APP_URL}/ceo/sales-activity?from=${encodeURIComponent(data.from)}`)}
    `,
    ),
  );
}

// ═════════════════════════════════════════════════════════════════
// ERROR REPORTS — alerts to the tech supervisor, and the two-way
// conversation between a person who reported a problem and the ICT team.
// Everything interpolated into the HTML is escaped: error messages and
// user comments are untrusted text.
// ═════════════════════════════════════════════════════════════════

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#dc2626",
  high: "#ea580c",
  medium: "#ca8a04",
  low: "#2563eb",
};

const sevChip = (severity: string) =>
  `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${SEVERITY_COLORS[severity] ?? "#64748b"};color:#fff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;">${esc(severity)}</span>`;

const preBlock = (text: string) =>
  `<pre style="margin:8px 0 16px;padding:12px;background:#0f172a;color:#e2e8f0;border-radius:8px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;">${esc(text)}</pre>`;

/** Link that opens a report for whoever clicks it (see /error-reports on the frontend). */
export const buildErrorReportUrl = (reportId: string): string =>
  `${APP_URL}/error-reports?report=${encodeURIComponent(reportId)}`;

const oneLine = (s: string, max = 150) =>
  s.replace(/\s+/g, " ").trim().slice(0, max);

export interface ErrorAlertEmailData {
  reportId: string;
  reportNumber: string;
  severity: string;
  source: "server" | "client" | "user_report";
  title: string;
  message?: string;
  stack?: string;
  method?: string;
  route?: string;
  pageUrl?: string;
  statusCode?: number;
  kind?: string;
  userAgent?: string;
  requestId?: string;
  /** "Jane Doe (sales_person)" — who it happened to. */
  userLabel?: string;
  occurredAt: Date;
  occurrences: number;
  /** Occurrences since the previous alert for this same error. */
  sinceLastAlert?: number;
  /** True when this is a repeat alert for a still-unacknowledged error. */
  isRepeat?: boolean;
}

/**
 * Sent to the tech supervisor when an error occurs anywhere in the system
 * (server, browser, background job). Returns true if the email was sent.
 */
export async function sendErrorAlertEmail(
  to: string,
  toName: string | undefined,
  d: ErrorAlertEmailData,
): Promise<boolean> {
  const where =
    d.source === "client"
      ? (d.pageUrl ?? "browser")
      : [d.method, d.route].filter(Boolean).join(" ") || "server";
  const sourceLabel =
    d.source === "client" ? "Browser (frontend)" : "Server (API / background)";

  const repeatNote = d.isRepeat
    ? highlight(
        `<strong>This error is still happening.</strong> It has occurred ${d.occurrences} time${d.occurrences === 1 ? "" : "s"} in total` +
          (d.sinceLastAlert ? ` (${d.sinceLastAlert} since the last alert)` : "") +
          `. You will not get another email for it once you acknowledge it.`,
      )
    : d.occurrences > 1
      ? highlight(`This error has occurred ${d.occurrences} times.`)
      : "";

  const html = wrap(
    "Error alert",
    `
      ${h1("An error occurred in the system")}
      ${p(
        "Hi " +
          esc(toName ?? "there") +
          ", PeakInsights Hub captured an error that needs the tech team's attention.",
      )}
      <p style="margin:0 0 12px;">${sevChip(d.severity)}</p>
      ${info("Reference", esc(d.reportNumber))}
      ${info("Where", esc(where))}
      ${info("Source", esc(sourceLabel))}
      ${d.statusCode ? info("Response", String(d.statusCode)) : ""}
      ${d.kind ? info("Type", esc(d.kind)) : ""}
      ${info("When", esc(formatEatDateTime(d.occurredAt)))}
      ${d.userLabel ? info("Affected user", esc(d.userLabel)) : ""}
      ${d.requestId ? info("Request ID", esc(d.requestId)) : ""}
      ${d.userAgent ? info("Browser", esc(oneLine(d.userAgent, 120))) : ""}
      ${repeatNote}
      ${d.message ? `<p style="margin:16px 0 4px;font-size:13px;font-weight:700;color:#0f172a;">Error message</p>${preBlock(d.message)}` : ""}
      ${
        d.stack
          ? `<p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#0f172a;">Stack trace</p>${preBlock(d.stack.split("\n").slice(0, 14).join("\n"))}`
          : ""
      }
      ${btn("Open error report", buildErrorReportUrl(d.reportId), "#dc2626")}
    `,
  );

  const sent = await send(
    to,
    `🚨 ${d.severity.toUpperCase()} · ${d.reportNumber} · ${oneLine(d.title)}`,
    html,
  );
  return sent !== null;
}

export interface UserErrorReportEmailData {
  reportId: string;
  reportNumber: string;
  severity: string;
  title: string;
  description?: string;
  reporterName: string;
  reporterEmail?: string;
  reporterRole?: string;
  pageUrl?: string;
  requestId?: string;
  lastApiError?: string;
  screenshotCount: number;
  /** Set when the report was linked to an auto-captured server error. */
  relatedReportNumber?: string;
  occurredAt: Date;
}

/**
 * A person pressed "Report a problem" and shared it with the tech
 * supervisor. Their screenshots are attached to the email itself, so they
 * can be read straight from the inbox. Reply-To is the reporter, so
 * replying to the email reaches them directly.
 */
export async function sendUserErrorReportEmail(
  to: string,
  toName: string | undefined,
  d: UserErrorReportEmailData,
  attachments: MailAttachment[],
): Promise<boolean> {
  const html = wrap(
    "Problem reported",
    `
      ${h1("A user reported a problem")}
      ${p(
        "Hi " +
          esc(toName ?? "there") +
          ", <strong>" +
          esc(d.reporterName) +
          "</strong> shared a problem with you from PeakInsights Hub.",
      )}
      <p style="margin:0 0 12px;">${sevChip(d.severity)}</p>
      ${info("Reference", esc(d.reportNumber))}
      ${info("Reported by", esc(d.reporterName + (d.reporterRole ? ` (${d.reporterRole})` : "")))}
      ${d.reporterEmail ? info("Email", esc(d.reporterEmail)) : ""}
      ${d.pageUrl ? info("Page", esc(d.pageUrl)) : ""}
      ${d.requestId ? info("Request ID", esc(d.requestId)) : ""}
      ${d.relatedReportNumber ? info("Linked server error", esc(d.relatedReportNumber)) : ""}
      ${info("Screenshots", d.screenshotCount ? `${d.screenshotCount} attached to this email` : "none")}
      ${info("When", esc(formatEatDateTime(d.occurredAt)))}
      ${d.description ? `<p style="margin:16px 0 4px;font-size:13px;font-weight:700;color:#0f172a;">What they said</p>${highlight(esc(d.description).replace(/\n/g, "<br />"))}` : ""}
      ${d.lastApiError ? `<p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#0f172a;">Last failed request seen by their browser</p>${preBlock(d.lastApiError)}` : ""}
      ${btn("Open report & reply", buildErrorReportUrl(d.reportId), "#0ea5e9")}
      ${p('<span style="font-size:13px;color:#64748b;">You can also reply to this email — it goes straight to ' + esc(d.reporterName) + ".</span>")}
    `,
  );

  const sent = await send(
    to,
    `🐞 ${d.reportNumber} · ${oneLine(d.reporterName, 60)} reported: ${oneLine(d.title, 110)}`,
    html,
    d.reporterEmail,
    undefined,
    attachments,
    { fromName: d.reporterName },
  );
  return sent !== null;
}

export interface ErrorReportCommentEmailData {
  reportId: string;
  reportNumber: string;
  title: string;
  authorName: string;
  authorRole?: string;
  body: string;
  screenshotCount: number;
  /** Who this email is for. */
  audience: "ict" | "reporter";
}

/** A new comment on a report — to the ICT team, or back to the reporter. */
export async function sendErrorReportCommentEmail(
  to: string,
  toName: string | undefined,
  d: ErrorReportCommentEmailData,
  attachments: MailAttachment[],
  replyTo?: string,
): Promise<boolean> {
  const html = wrap(
    "New comment on error report",
    `
      ${h1(d.audience === "ict" ? "New comment on a reported problem" : "The tech team replied to your report")}
      ${p(
        "Hi " +
          esc(toName ?? "there") +
          ", <strong>" +
          esc(d.authorName) +
          "</strong> commented on <strong>" +
          esc(d.reportNumber) +
          "</strong> — " +
          esc(oneLine(d.title, 120)) +
          ".",
      )}
      ${d.body ? highlight(esc(d.body).replace(/\n/g, "<br />")) : ""}
      ${d.screenshotCount ? p(`${d.screenshotCount} screenshot${d.screenshotCount === 1 ? "" : "s"} attached.`) : ""}
      ${btn(d.audience === "ict" ? "Open report & reply" : "View the conversation", buildErrorReportUrl(d.reportId))}
    `,
  );
  const sent = await send(
    to,
    `💬 ${d.reportNumber} · new comment from ${oneLine(d.authorName, 60)}`,
    html,
    replyTo,
    undefined,
    attachments,
    { fromName: d.authorName },
  );
  return sent !== null;
}

/** Tells the reporter their report was resolved (or re-opened). */
export async function sendErrorReportStatusEmail(
  to: string,
  toName: string | undefined,
  d: {
    reportId: string;
    reportNumber: string;
    title: string;
    status: string;
    byName: string;
  },
): Promise<boolean> {
  const resolved = d.status === "resolved";
  const html = wrap(
    "Report status updated",
    `
      ${h1(resolved ? "Your reported problem was marked resolved" : "Your report status changed")}
      ${p(
        "Hi " +
          esc(toName ?? "there") +
          ", <strong>" +
          esc(d.byName) +
          "</strong> set <strong>" +
          esc(d.reportNumber) +
          "</strong> (" +
          esc(oneLine(d.title, 120)) +
          ") to <strong>" +
          esc(d.status.replace("_", " ")) +
          "</strong>.",
      )}
      ${resolved ? highlight("If it's still not working for you, just reply on the report and it will be re-opened.") : ""}
      ${btn("View report", buildErrorReportUrl(d.reportId))}
    `,
  );
  const sent = await send(
    to,
    `${resolved ? "✅" : "ℹ️"} ${d.reportNumber} · ${d.status.replace("_", " ")}`,
    html,
  );
  return sent !== null;
}