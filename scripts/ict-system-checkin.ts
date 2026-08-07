/**
 * Systems check-in helper.
 *
 * Unlike infrastructure (which is polled by an external agent),
 * jobs/workers/services are best reported by *themselves* — a cron
 * job that calls this at the end of its run tells you far more
 * (did it actually finish, did it error) than an external poller
 * ever could. Import reportSystemStatus() from your job's own
 * script, or run this file directly for a one-off status update.
 *
 * As a library:
 *   import { reportSystemStatus } from "./ict-system-checkin";
 *   await reportSystemStatus({ systemId, status: "running" });
 *
 * As a CLI (e.g. appended to the end of an existing cron job):
 *   SYSTEM_ID=... STATUS=running \
 *     npx ts-node scripts/ict-system-checkin.ts
 */

interface CheckinOptions {
  systemId: string;
  status: "running" | "failed" | "restart_required" | "offline";
  apiUrl?: string; // defaults to API_URL env var
  token?: string; // defaults to API_TOKEN env var
  nextRunAt?: string; // ISO string, e.g. next scheduled cron fire
}

export async function reportSystemStatus(opts: CheckinOptions): Promise<void> {
  const apiUrl = opts.apiUrl ?? process.env.API_URL;
  const token = opts.token ?? process.env.API_TOKEN;
  if (!apiUrl)
    throw new Error("API_URL is required (env var or apiUrl option)");
  if (!token)
    throw new Error("API_TOKEN is required (env var or token option)");

  const res = await fetch(`${apiUrl}/systems/${opts.systemId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ status: opts.status, nextRunAt: opts.nextRunAt }),
  });

  if (!res.ok) {
    throw new Error(`check-in failed: ${res.status} ${await res.text()}`);
  }
}

// Allow running directly as a CLI for simple cases.
if (require.main === module) {
  const systemId = process.env.SYSTEM_ID;
  const status = process.env.STATUS as CheckinOptions["status"];
  if (!systemId || !status) {
    console.error(
      "Usage: SYSTEM_ID=... STATUS=running|failed|restart_required|offline npx ts-node scripts/ict-system-checkin.ts",
    );
    process.exit(1);
  }
  reportSystemStatus({ systemId, status })
    .then(() =>
      console.log(`[ict-system-checkin] reported ${status} for ${systemId}`),
    )
    .catch((err) => {
      console.error("[ict-system-checkin] failed:", err);
      process.exit(1);
    });
}
