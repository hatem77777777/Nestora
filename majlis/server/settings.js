// Runtime settings: keys and preferences entered from the app's Settings screen.
// Stored on the server disk (data/settings.json); environment variables are a fallback.
import crypto from "node:crypto";
import { readKV, writeKV } from "./store.js";

const EDITABLE = [
  "ANTHROPIC_API_KEY",
  "SONIOX_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OWNER_NAME",
  "OWNER_ROLE",
  "DIGEST",
];
let cache = {};

export async function loadSettings() {
  cache = await readKV("settings", {});
}

export const get = (k) => cache[k] || process.env[k] || "";

export async function update(patch) {
  for (const k of EDITABLE) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k]).trim().slice(0, 500);
    if (v) cache[k] = v;
    else delete cache[k];
  }
  await writeKV("settings", cache);
}

// ───────────── password (set on first visit, or APP_PASSWORD env) ─────────────
export const hasPassword = () => !!(process.env.APP_PASSWORD || cache.passwordHash);

export async function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  cache.passwordHash = `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
  await writeKV("settings", cache);
}

export function checkPassword(pw) {
  if (process.env.APP_PASSWORD) {
    const a = crypto.createHash("sha256").update(pw).digest();
    const b = crypto.createHash("sha256").update(process.env.APP_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }
  if (!cache.passwordHash) return false;
  const [salt, hash] = cache.passwordHash.split(":");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), crypto.scryptSync(pw, salt, 32));
}

/** Changes whenever the password changes, so old sessions die with it. */
export const sessionSecret = () => process.env.APP_PASSWORD || cache.passwordHash || "";

/** Public base URL: explicit setting → Render's own URL → the address the browser used. */
export function baseUrl(req) {
  const fixed = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (fixed) return fixed.replace(/\/$/, "");
  const proto = String(req?.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req?.headers.host || `localhost:${process.env.PORT || 8787}`}`;
}
