/**
 * ICT infrastructure heartbeat agent.
 *
 * This is the piece referenced everywhere in InfraResource.ts /
 * infraController.ts as "nothing calls this yet" — run this on (or
 * with network access to) the box you're monitoring, on a schedule
 * (systemd timer, cron, k8s CronJob — every 1-2 minutes is
 * reasonable), and the Infrastructure page stops being manually
 * maintained and starts being live.
 *
 * What it reports:
 *   - cpuPercent, memoryPercent — real, via Node's os module
 *   - diskPercent — real, via `df` (Linux/macOS only; skipped on
 *     other platforms rather than faked)
 *   - responseMs — real, if TARGET_URL is set: measures a GET to
 *     that URL, useful when this agent runs somewhere other than
 *     the resource itself (e.g. a healthcheck against an API/DB
 *     endpoint from a central monitoring box)
 *   - status — derived from thresholds below; override with
 *     STATUS_OVERRIDE if you have better judgment than these
 *     defaults for a particular resource
 *
 * Required env vars:
 *   API_URL        e.g. https://your-app.example.com/api
 *   INFRA_ID       the InfraResource _id to report against
 *   API_EMAIL      a tech or ceo account's login email
 *   API_PASSWORD   that account's password
 *     — or, instead of API_EMAIL/API_PASSWORD —
 *   API_TOKEN      an existing JWT, if you're managing auth yourself
 *
 * Optional env vars:
 *   TARGET_URL         URL to measure response time against
 *   INTERVAL_SECONDS   if set, runs continuously on this interval
 *                       instead of a single one-shot report (good
 *                       for systemd; omit it and let cron handle
 *                       the schedule instead if you prefer that)
 *
 * Usage:
 *   API_URL=https://app.example.com/api INFRA_ID=... \
 *   API_EMAIL=ict@company.com API_PASSWORD=... \
 *     npx ts-node scripts/ict-heartbeat-agent.ts
 */
import os from "os";
import { execSync } from "child_process";

const API_URL = requireEnv("API_URL");
const INFRA_ID = requireEnv("INFRA_ID");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[ict-heartbeat-agent] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

async function getToken(): Promise<string> {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;

  const email = requireEnv("API_EMAIL");
  const password = requireEnv("API_PASSWORD");

  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok)
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}

function cpuPercent(): number {
  // Snapshot-based CPU usage needs two samples; for a lightweight
  // agent invoked every minute or two, os.loadavg() normalized by
  // core count is a reasonable proxy without blocking the process.
  const load1 = os.loadavg()[0];
  const cores = os.cpus().length || 1;
  return Math.min(100, Math.round((load1 / cores) * 100));
}

function memoryPercent(): number {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

function diskPercent(): number | undefined {
  try {
    if (process.platform === "win32") return undefined; // `df` isn't available; skip rather than fake it
    const out = execSync("df -k / | tail -1").toString().trim();
    const parts = out.split(/\s+/);
    // df -k columns: Filesystem 1K-blocks Used Available Use% Mounted
    const usePctStr = parts[4]?.replace("%", "");
    const usePct = Number(usePctStr);
    return Number.isFinite(usePct) ? usePct : undefined;
  } catch {
    return undefined; // don't fake a number if `df` isn't available/parseable
  }
}

async function measureResponseMs(): Promise<number | undefined> {
  const target = process.env.TARGET_URL;
  if (!target) return undefined;
  const start = Date.now();
  try {
    const res = await fetch(target, { method: "GET" });
    await res.text().catch(() => undefined);
    return Date.now() - start;
  } catch {
    return undefined;
  }
}

function deriveStatus(
  cpu: number,
  mem: number,
  disk: number | undefined,
): "healthy" | "warning" | "critical" {
  if (process.env.STATUS_OVERRIDE) {
    return process.env.STATUS_OVERRIDE as "healthy" | "warning" | "critical";
  }
  const worst = Math.max(cpu, mem, disk ?? 0);
  if (worst >= 90) return "critical";
  if (worst >= 75) return "warning";
  return "healthy";
}

async function reportOnce(token: string): Promise<void> {
  const cpu = cpuPercent();
  const mem = memoryPercent();
  const disk = diskPercent();
  const responseMs = await measureResponseMs();
  const status = deriveStatus(cpu, mem, disk);

  const res = await fetch(`${API_URL}/infrastructure/${INFRA_ID}/heartbeat`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      status,
      cpuPercent: cpu,
      memoryPercent: mem,
      diskPercent: disk,
      responseMs,
    }),
  });

  if (!res.ok) {
    console.error(
      `[ict-heartbeat-agent] heartbeat failed: ${res.status} ${await res.text()}`,
    );
    return;
  }
  console.log(
    `[ict-heartbeat-agent] reported status=${status} cpu=${cpu}% mem=${mem}% disk=${disk ?? "n/a"}%${
      responseMs != null ? ` resp=${responseMs}ms` : ""
    }`,
  );
}

async function main() {
  const token = await getToken();
  const intervalSeconds = process.env.INTERVAL_SECONDS
    ? Number(process.env.INTERVAL_SECONDS)
    : undefined;

  await reportOnce(token);

  if (intervalSeconds && intervalSeconds > 0) {
    console.log(
      `[ict-heartbeat-agent] running continuously every ${intervalSeconds}s (Ctrl+C to stop)`,
    );
    setInterval(() => {
      reportOnce(token).catch((err) =>
        console.error("[ict-heartbeat-agent] report failed:", err),
      );
    }, intervalSeconds * 1000);
  }
}

main().catch((err) => {
  console.error("[ict-heartbeat-agent] fatal:", err);
  process.exit(1);
});
