/**
 * Applies the CORS rule that direct-to-S3 uploads need, then reads it back.
 *
 *   npx ts-node scripts/applyS3Cors.ts
 *
 * Browsers upload files straight to the bucket with a presigned POST, and the
 * bucket must explicitly allow POST from the app's origin or every upload fails
 * with a CORS error (the file never leaves the browser).
 *
 * Origins = those in s3-cors-config.json  +  FRONTEND_URL  +  anything in
 * S3_CORS_EXTRA_ORIGINS (comma-separated, e.g. a staging URL).
 *
 * Needs credentials allowed to do s3:PutBucketCORS. The app's own upload key
 * usually can't — run this once with an admin key (S3_ACCESS_KEY / S3_SECRET_KEY
 * in the environment), or paste s3-cors-config.json into
 * S3 console → bucket → Permissions → Cross-origin resource sharing (CORS).
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from "@aws-sdk/client-s3";

dotenv.config();

async function main() {
  const { AWS_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET } = process.env;
  if (!AWS_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET) {
    throw new Error("AWS_REGION, S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET must be set");
  }

  const file = path.resolve(__dirname, "..", "s3-cors-config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as {
    CORSRules: { AllowedOrigins: string[] }[];
  };

  const origins = new Set<string>(config.CORSRules[0].AllowedOrigins);
  const add = (v?: string) => {
    const o = v?.trim().replace(/\/+$/, "");
    if (o) origins.add(o);
  };
  add(process.env.FRONTEND_URL);
  (process.env.S3_CORS_EXTRA_ORIGINS ?? "").split(",").forEach(add);
  config.CORSRules[0].AllowedOrigins = [...origins];

  const s3 = new S3Client({
    region: AWS_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  });

  await s3.send(
    new PutBucketCorsCommand({
      Bucket: S3_BUCKET,
      CORSConfiguration: config as any,
    }),
  );
  const back = await s3.send(new GetBucketCorsCommand({ Bucket: S3_BUCKET }));
  console.log(`CORS applied to ${S3_BUCKET}:`);
  console.log(JSON.stringify(back.CORSRules, null, 2));
}

main().catch((err) => {
  if (err?.name === "AccessDenied") {
    console.error(
      "Access denied: this key can't change bucket CORS. Use an admin key, or paste " +
        "s3-cors-config.json into the S3 console (bucket → Permissions → CORS).",
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});