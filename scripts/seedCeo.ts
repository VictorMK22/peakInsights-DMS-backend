/**
 * seedCeo.ts
 *
 * Creates (or repairs) a CEO account. The CEO is the only role that can
 * create other accounts (supervisor, sales person, accountant, tech) in
 * PeakInsights Hub.
 *
 * Uses the app's own User model, so the password is hashed by the same
 * pre-save hook as every other account and the schema rules are enforced.
 *
 * The password is NOT stored in this file. Pass it via an env var.
 *
 * Usage (backend project root, MONGODB_URI in .env):
 *
 *   PowerShell:
 *     $env:SEED_CEO_PASSWORD='YourPasswordHere'
 *     npx ts-node scripts/seedCeo.ts
 *
 *   macOS / Linux:
 *     SEED_CEO_PASSWORD='YourPasswordHere' npx ts-node scripts/seedCeo.ts
 *
 * Options:
 *   --email=<address>   default nkyebei@peak-insights.com
 *   --name=<full name>  default "PeakInsights CEO"
 *   --force             if the email already exists, promote it to an active
 *                       CEO and reset its password to SEED_CEO_PASSWORD
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import { User } from "../src/models/User";

dotenv.config();

const argv = process.argv.slice(2);
const getOpt = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};

const EMAIL = (getOpt("--email") ?? "nkyebei@peak-insights.com")
  .trim()
  .toLowerCase();
const NAME = getOpt("--name") ?? "PeakInsights CEO";
const FORCE = argv.includes("--force");
const DEFAULT_SEEDED_EMAIL = "ceo@peakinsights.com"; // seedCEO()'s fallback

async function main(): Promise<void> {
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI is missing (set it in .env)");

  const password = process.env["SEED_CEO_PASSWORD"];
  if (!password) {
    throw new Error(
      "SEED_CEO_PASSWORD is not set. Set it in your shell first " +
        "(see usage at the top of this file).",
    );
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters (schema rule).");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const dbName = mongoose.connection.db?.databaseName;
  console.log(`Connected to database: ${dbName}`);

  // password is select:false in the schema, so request it explicitly
  // only when we need to modify an existing doc (save() works either way).
  const existing = await User.findOne({ email: EMAIL });

  if (existing && !FORCE) {
    console.log(
      `A user with email ${EMAIL} already exists ` +
        `(role: ${existing.role}, status: ${existing.accountStatus}, ` +
        `active: ${existing.isActive}).`,
    );
    console.log("Nothing changed. Re-run with --force to promote it to an");
    console.log("active CEO and reset its password.");
    return;
  }

  if (existing) {
    existing.name = existing.name || NAME;
    existing.role = "ceo";
    existing.isActive = true;
    existing.accountStatus = "active";
    existing.supervisorId = undefined; // schema forbids a CEO with a supervisor
    existing.password = password; // re-hashed by the pre-save hook
    await existing.save();
    console.log(`✅ Updated ${EMAIL}: now an active CEO with a new password.`);
  } else {
    await User.create({
      name: NAME,
      email: EMAIL,
      password, // hashed by the pre-save hook
      role: "ceo",
      department: "Executive",
      isActive: true,
      accountStatus: "active",
    });
    console.log(`✅ CEO created: ${EMAIL}`);
  }

  // The backend's startup seeder creates a default CEO with a publicly
  // known password if no CEO exists. Flag it if one slipped in.
  if (EMAIL !== DEFAULT_SEEDED_EMAIL) {
    const defaultCeo = await User.findOne({ email: DEFAULT_SEEDED_EMAIL });
    if (defaultCeo) {
      console.log(
        `\n⚠️  A default seeded CEO (${DEFAULT_SEEDED_EMAIL}) exists in this ` +
          `database. Its password is the app's well-known default. Log in as ` +
          `${EMAIL} and delete that account.`,
      );
    }
  }

  console.log("\nNext: log in with this account, then change the password");
  console.log("from the profile/security settings.");
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
