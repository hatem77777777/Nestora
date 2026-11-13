// Flat-file store: one JSON file per meeting. Single-user app, so this is enough
// and keeps deployment to "a folder on a disk".
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const MEETINGS = path.join(DATA_DIR, "meetings");
const cache = new Map();
const locks = new Map();

export async function init() {
  await fs.mkdir(MEETINGS, { recursive: true });
}

const isId = (id) => /^[a-z0-9]{8,32}$/.test(id);
const fileOf = (id) => path.join(MEETINGS, `${id}.json`);

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

export function newMeeting({ title, context }) {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    title: (title || "").trim(),
    context: (context || "").trim(),
    createdAt: Date.now(),
    endedAt: null,
    status: "live", // live | finalizing | done | error
    error: null,
    segments: [], // { t: seconds, sp: "A1", text }
    chunks: [], // transcript text per analysis tick (append-only → prompt-cache friendly)
    speakers: {}, // id → { name, role, confidence, locked }
    board: { topics: [], insights: [], decisions: [], actions: [] },
    qa: [], // direct questions to Claude during the meeting
    final: null,
    exports: {},
    emailsSent: [],
  };
}

export async function getMeeting(id) {
  if (!isId(id)) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const m = JSON.parse(await fs.readFile(fileOf(id), "utf8"));
    cache.set(id, m);
    return m;
  } catch {
    return null;
  }
}

export async function saveMeeting(m) {
  cache.set(m.id, m);
  await writeAtomic(fileOf(m.id), m);
}

export async function deleteMeeting(id) {
  if (!isId(id)) return;
  cache.delete(id);
  await fs.rm(fileOf(id), { force: true });
}

export async function listMeetings() {
  const files = (await fs.readdir(MEETINGS)).filter((f) => f.endsWith(".json"));
  const all = [];
  for (const f of files) {
    const m = await getMeeting(f.slice(0, -5));
    if (m) all.push(m);
  }
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** Serialise work per meeting so overlapping requests can't clobber each other. */
export function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  next.finally(() => locks.get(id) === next && locks.delete(id)).catch(() => {});
  return next;
}

// ── small key/value files (google tokens, roster, digest state) ──
export async function readKV(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, `${name}.json`), "utf8"));
  } catch {
    return fallback;
  }
}
export async function writeKV(name, value) {
  await writeAtomic(path.join(DATA_DIR, `${name}.json`), value);
}
export async function removeKV(name) {
  await fs.rm(path.join(DATA_DIR, `${name}.json`), { force: true });
}
