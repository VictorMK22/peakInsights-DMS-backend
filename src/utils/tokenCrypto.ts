import crypto from "crypto";

// ═════════════════════════════════════════════════════════════════
// Encrypts OAuth access/refresh tokens before they touch the database.
// These tokens grant read access to a staff member's real mailbox, so
// they must never sit in plaintext in Mongo.
//
// Requires TOKEN_ENCRYPTION_KEY in .env — a 32-byte key, hex-encoded
// (64 hex characters). Generate one with:
//   openssl rand -hex 32
// ═════════════════════════════════════════════════════════════════

const ALGORITHM = "aes-256-gcm";

const getKey = (): Buffer => {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is missing or not a 64-char hex string (32 bytes). Generate one with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
};

/** Returns "iv:authTag:ciphertext", all hex-encoded, joined with ':'. */
export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

export function decryptToken(payload: string): string {
  const [ivHex, authTagHex, dataHex] = payload.split(":");
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Malformed encrypted token payload");
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
