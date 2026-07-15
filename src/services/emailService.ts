/**
 * services/emailService.ts
 *
 * Transactional emails for PeakInsights DMS.
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

import nodemailer, { SentMessageInfo, Transporter } from "nodemailer";

interface DirectEmailOptions {
  toEmail: string;
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
  /** Files on local disk to attach — absolute paths (see middleware/upload.ts). */
  attachments?: { filename: string; path: string; contentType?: string }[];
}

// ─── Transport ────────────────────────────────────────────────────

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    console.warn("⚠️  SMTP not configured — emails will be skipped");
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465, // true for 465, false for 587/25
    auth: { user, pass },
  });

  return transporter;
}

// ─── Helpers ──────────────────────────────────────────────────────
const APP_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

/** Send a single email. Never throws — logs on failure. */
async function send(
  to: string,
  subject: string,
  html: string,
  replyTo?: string,
  threading?: { inReplyTo?: string; references?: string[] },
  attachments?: { filename: string; path: string; contentType?: string }[],
): Promise<SentMessageInfo | null> {
  const t = getTransporter();
  if (!t) return null;

  const from = `"PeakInsights" <${process.env.SMTP_USER}>`;

  try {
    const info = await t.sendMail({
      from: from, // 🔥 FIXED (ONLY AUTH USER)
      to,
      subject,
      html,
      replyTo,
      // Standard RFC 2822 threading headers — this is what makes a
      // reply show up as part of the same conversation in the
      // recipient's real inbox (Gmail, Outlook, Apple Mail, etc.)
      // instead of arriving as an unrelated new email.
      inReplyTo: threading?.inReplyTo,
      references: threading?.references?.length
        ? threading.references.join(" ")
        : undefined,
      attachments,
    });

    console.log(`📧 Email sent → ${to}: ${subject}`);
    return info;
  } catch (err) {
    console.error(`❌ Email failed → ${to}: ${subject}`, err);
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
            <p style="margin:0;font-size:22px;font-weight:700;color:#fff;letter-spacing:-.5px;">⚡ PeakInsights</p>
            <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,.75);">Document Management System</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">${body}</td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f1f5f9;background:#f8fafc;">
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
              This email was sent by PeakInsights DMS. If you didn't expect this, you can safely ignore it.<br />
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
  role: "user" | "supervisor" | "sales_person",
  fromEmail?: string,
): Promise<void> {
  await send(
    to,
    "Your PeakInsights account is ready",
    wrap(
      "Account Created",
      `
      ${h1("Welcome to PeakInsights, " + name + "!")}
      ${p("The CEO has created a <strong>" + (role === "sales_person" ? "Sales Person / Business Development Officer" : role) + "</strong> account for you. Your account is active immediately.")}
      ${info("Email", to)}
      ${highlight(
        "<strong>Temporary password:</strong> " +
          `<code style="font-size:16px;letter-spacing:2px;">${temporaryPassword}</code>` +
          "<br/><br/>Please change your password after your first login.",
      )}
      ${btn("Log in Now", `${APP_URL}/login`, "#7c3aed")}
    `,
    ),
    fromEmail,
  );
}

// ═════════════════════════════════════════════════════════════════
// PASSWORD
// ═════════════════════════════════════════════════════════════════

/** Sent when a user requests a password reset link. */
export async function sendPasswordResetEmail(
  to: string,
  name: string,
  resetToken: string,
  fromEmail?: string,
): Promise<void> {
  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}&email=${encodeURIComponent(to)}`;
  await send(
    to,
    "Reset your PeakInsights password",
    wrap(
      "Password Reset",
      `
      ${h1("Password Reset Request")}
      ${p("Hi " + name + ", we received a request to reset your PeakInsights password.")}
      ${btn("Reset My Password", resetUrl)}
      ${highlight("This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.")}
    `,
    ),
    fromEmail,
  );
}

/** Sent after a successful password change (via change-password endpoint). */
export async function sendPasswordChangedEmail(
  to: string,
  name: string,
  fromEmail?: string,
): Promise<void> {
  await send(
    to,
    "Your PeakInsights password was changed",
    wrap(
      "Password Changed",
      `
      ${h1("Password Changed")}
      ${p("Hi " + name + ", your password was successfully updated.")}
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
      ${p("Hi " + recipientName + ", you have a new message in PeakInsights.")}
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
    toName,
    fromName = "A colleague",
    fromEmail,
    subject,
    body,
    inReplyTo,
    references,
    quoted,
    attachments,
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

  console.log("📨 Direct Email Sent", {
    to: toEmail,
    from: fromEmail,
    subject: safeSubject,
    reply: !!inReplyTo,
    timestamp: new Date().toISOString(),
  });

  const result = await send(
    toEmail,
    safeSubject,
    wrap(
      quoted ? "New Reply" : "New Email Message",
      `
      ${h1((quoted ? "Reply from " : "New message for ") + (quoted ? senderLine : (toName ?? "you")))}
      ${quoted ? "" : p("<strong>From:</strong> " + senderLine)}
      ${p(safeBody)}
      ${quoteBlock}
      ${highlight("Reply directly to respond to the sender.")}
    `,
    ),
    // fromEmail becomes the Reply-To header — so if the recipient
    // replies from their own real mail client, it goes straight back
    // to the actual PeakInsights user, not the shared SMTP mailbox.
    fromEmail,
    { inReplyTo, references },
    attachments,
  );

  if (!result?.messageId) {
    throw new Error("SMTP send failed");
  }

  return { messageId: result.messageId };
}
