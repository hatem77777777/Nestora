// Majlis server: static PWA + JSON API. No framework — node:http is enough here.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile?.(".env");
} catch {}

const store = await import("./store.js");
const claude = await import("./claude.js");
const google = await import("./google.js");
const { applyDelta, carryOver, openTasks } = await import("./board.js");
const { DEMO_SCRIPT } = await import("./demo.js");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const PASSWORD = process.env.APP_PASSWORD || "";
const SONIOX_KEY = process.env.SONIOX_API_KEY || "";
const TZ = process.env.TIMEZONE || "Africa/Cairo";
const SECURE = (process.env.BASE_URL || "").startsWith("https://");
const todayIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ───────────── auth: one shared password → signed cookie ─────────────
const sessionToken = () => crypto.createHmac("sha256", PASSWORD).update("majlis-session").digest("hex");
const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
const authed = (req) => {
  if (!PASSWORD) return true;
  const c = /(?:^|;\s*)majlis=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return !!c && safeEq(c[1], sessionToken());
};
let loginFails = 0;

// ───────────── helpers ─────────────
const send = (res, status, body, headers = {}) => {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(data);
};
async function readJSON(req) {
  let size = 0;
  const parts = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, "الطلب كبير جدًا");
    parts.push(c);
  }
  if (!parts.length) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON غير صالح");
  }
}
const clip = (s, n) => String(s ?? "").slice(0, n);
const mustMeeting = async (id) => (await store.getMeeting(id)) || Promise.reject(new HttpError(404, "الاجتماع غير موجود"));
const mustFinal = (m) => m.final || Promise.reject(new HttpError(409, "الاجتماع لسه ما اتقفلش"));
const summary = (m) => ({
  id: m.id,
  title: m.final?.title || m.title,
  createdAt: m.createdAt,
  endedAt: m.endedAt,
  status: m.status,
  tasks: m.final?.tasks.length || 0,
  done: m.final?.tasks.filter((t) => t.done).length || 0,
  people: Object.values(m.speakers).filter((s) => s.name).map((s) => s.name),
});

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, "not found");
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch {
    throw new HttpError(404, "not found");
  }
}

// ───────────── finalize job (runs in background; the phone polls) ─────────────
const finalizing = new Set();
async function runFinalize(id) {
  if (finalizing.has(id)) return;
  finalizing.add(id);
  try {
    const m = await store.getMeeting(id);
    const all = await store.listMeetings();
    const roster = await store.readKV("roster", []);
    const final = await claude.finalize(m, { carryOver: carryOver(all, id), roster });
    final.tasks.forEach((t) => (t.done = false));
    await store.withLock(id, async () => {
      m.final = final;
      m.status = "done";
      m.error = null;
      await store.saveMeeting(m);
    });
    // remember who was in the room for next time
    for (const s of Object.values(m.speakers)) {
      if (s.name && !roster.some((r) => r.name === s.name)) roster.push({ name: s.name, role: s.role || "", email: "" });
    }
    await store.writeKV("roster", roster);
  } catch (err) {
    console.error("[finalize]", err);
    const m = await store.getMeeting(id);
    if (m) {
      m.status = "error";
      m.error = err instanceof claude.ClaudeError ? err.message : "حصل خطأ أثناء تجهيز المخرجات.";
      await store.saveMeeting(m);
    }
  } finally {
    finalizing.delete(id);
  }
}

// ───────────── routes ─────────────
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), fn });

route("GET", "/api/state", async () => ({
  demo: { stt: !SONIOX_KEY, claude: claude.claudeDemo },
  google: await google.status(),
  owner: process.env.OWNER_NAME || "",
}));

route("GET", "/api/meetings", async () => (await store.listMeetings()).map(summary));

route("POST", "/api/meetings", async ({ body }) => {
  const m = store.newMeeting({ title: clip(body.title, 200), context: clip(body.context, 4000) });
  await store.saveMeeting(m);
  return m;
});

route("GET", "/api/meetings/:id", async ({ params }) => mustMeeting(params.id));

route("DELETE", "/api/meetings/:id", async ({ params }) => {
  await store.deleteMeeting(params.id);
  return { ok: true };
});

// A live analysis pass: append new transcript, ask Claude, merge its answer into the board.
route("POST", "/api/meetings/:id/tick", ({ params, body }) =>
  store.withLock(params.id, async () => {
    const m = await mustMeeting(params.id);
    let segs = (Array.isArray(body.segments) ? body.segments : [])
      .slice(0, 400)
      .map((s) => ({ t: Math.max(0, Number(s.t) || 0), sp: clip(s.sp, 8).replace(/[^A-Z0-9]/gi, "") || "A1", text: clip(s.text, 2000).trim() }))
      .filter((s) => s.text);
    // `offset` = index of the first segment in the phone's own list. A retried request
    // (flaky mobile network) re-sends segments we already stored; drop those.
    const offset = Number.isInteger(body.offset) ? body.offset : m.segments.length;
    segs = segs.slice(Math.max(0, m.segments.length - offset));
    const question = clip(body.question, 1000).trim();
    const state = () => ({ speakers: m.speakers, board: m.board, qa: m.qa, count: m.segments.length });
    if (!segs.length && !question && (m.analyzed || 0) >= m.chunks.length) return { ...state(), added: {} };

    if (segs.length || !m.chunks.length) {
      m.segments.push(...segs);
      const ts = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
      m.chunks.push(segs.length ? segs.map((s) => `[${ts(s.t)}] ${s.sp}: ${s.text}`).join("\n") : "(لا يوجد كلام بعد)");
      await store.saveMeeting(m); // transcript is safe on disk even if Claude fails
    }

    const t = m.segments.at(-1)?.t || 0;
    let delta;
    try {
      delta = await claude.liveTick(m, { question, carryOver: carryOver(await store.listMeetings(), m.id) });
    } catch (err) {
      if (err instanceof claude.ClaudeError) throw new HttpError(502, err.message);
      throw err;
    }
    const added = applyDelta(m, delta, t);
    m.analyzed = m.chunks.length;
    if (question) m.qa.push({ q: question, a: delta.reply || "—", t });
    await store.saveMeeting(m);
    return { ...state(), added };
  }),
);

// The user corrects who a speaker is — this always wins over Claude's guess.
route("POST", "/api/meetings/:id/speaker", ({ params, body }) =>
  store.withLock(params.id, async () => {
    const m = await mustMeeting(params.id);
    const id = clip(body.id, 8);
    m.speakers[id] = { name: clip(body.name, 80).trim(), role: clip(body.role, 120).trim(), confidence: "high", locked: true };
    await store.saveMeeting(m);
    return { speakers: m.speakers };
  }),
);

route("POST", "/api/meetings/:id/finalize", async ({ params }) => {
  const m = await mustMeeting(params.id);
  if (!m.segments.length) throw new HttpError(409, "مفيش كلام متسجّل في الاجتماع ده.");
  m.status = "finalizing";
  m.endedAt ??= Date.now();
  await store.saveMeeting(m);
  runFinalize(m.id);
  return { status: m.status };
});

route("POST", "/api/meetings/:id/task", ({ params, body }) =>
  store.withLock(params.id, async () => {
    const m = await mustMeeting(params.id);
    const t = (await mustFinal(m)).tasks.find((x) => x.id === body.taskId);
    if (!t) throw new HttpError(404, "المهمة غير موجودة");
    t.done = !!body.done;
    await store.saveMeeting(m);
    return { ok: true };
  }),
);

route("POST", "/api/meetings/:id/export", ({ params, body }) =>
  store.withLock(params.id, async () => {
    const m = await mustMeeting(params.id);
    await mustFinal(m);
    if (body.kind === "sheet") m.exports.sheetUrl = await google.createSheet(m);
    else if (body.kind === "doc") m.exports.docUrl = await google.createDoc(m);
    else if (body.kind === "calendar") m.exports.calendarCount = (m.exports.calendarCount || 0) + (await google.addDeadlines(m));
    else throw new HttpError(400, "نوع غير معروف");
    await store.saveMeeting(m);
    return { exports: m.exports };
  }),
);

// Emails are never sent automatically: this only runs when the user presses "send" on a draft.
route("POST", "/api/meetings/:id/email", ({ params, body }) =>
  store.withLock(params.id, async () => {
    const m = await mustMeeting(params.id);
    const draft = (await mustFinal(m)).emails[Number(body.index)];
    if (!draft) throw new HttpError(404, "المسودة غير موجودة");
    const mail = { to: clip(body.to, 500), subject: clip(body.subject ?? draft.subject, 300), body: clip(body.body ?? draft.body, 20000) };
    await google.sendEmail(mail);
    draft.sentTo = mail.to;
    draft.sentAt = Date.now();
    draft.subject = mail.subject;
    draft.body = mail.body;
    await store.saveMeeting(m);
    const roster = await store.readKV("roster", []);
    const person = roster.find((r) => r.name === draft.to_name);
    if (person && !mail.to.includes(",")) {
      person.email = mail.to.trim();
      await store.writeKV("roster", roster);
    }
    return { ok: true };
  }),
);

route("GET", "/api/roster", async () => store.readKV("roster", []));

route("GET", "/api/followup", async () => ({ today: todayIso(), tasks: openTasks(await store.listMeetings(), todayIso()) }));

route("POST", "/api/followup/chat", async ({ body }) => {
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-20).map((x) => ({ role: x.role, content: clip(x.content, 4000) }));
  if (!messages.length || messages.at(-1).role !== "user") throw new HttpError(400, "رسالة فاضية");
  try {
    return { reply: await claude.followupChat(await store.listMeetings(), messages) };
  } catch (err) {
    if (err instanceof claude.ClaudeError) throw new HttpError(502, err.message);
    throw err;
  }
});

// Short-lived speech-to-text key so the real key never reaches the phone.
route("POST", "/api/stt-token", async () => {
  if (!SONIOX_KEY) return { demo: true };
  const r = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
    method: "POST",
    headers: { authorization: `Bearer ${SONIOX_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ usage_type: "transcribe_websocket", expires_in_seconds: 300 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.api_key) throw new HttpError(502, `تعذّر تشغيل التفريغ الصوتي (${j.message || r.status}).`);
  return { apiKey: j.api_key, model: process.env.SONIOX_MODEL || "stt-rt-preview" };
});

route("GET", "/api/demo-script", async () => DEMO_SCRIPT);

route("POST", "/api/google/disconnect", async () => {
  await google.disconnect();
  return { ok: true };
});

// ───────────── server ─────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/login" && req.method === "POST") {
      const { password } = await readJSON(req);
      await new Promise((r) => setTimeout(r, Math.min(loginFails, 10) * 500)); // slow down guessing
      if (PASSWORD && !safeEq(String(password || ""), PASSWORD)) {
        loginFails++;
        throw new HttpError(401, "كلمة السر غلط");
      }
      loginFails = 0;
      return send(res, 200, { ok: true }, { "set-cookie": `majlis=${PASSWORD ? sessionToken() : "0"}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${90 * 86400}${SECURE ? "; Secure" : ""}` });
    }
    if (p === "/healthz") return send(res, 200, { ok: true });

    if (p.startsWith("/api/") || p.startsWith("/auth/")) {
      if (!authed(req)) throw new HttpError(401, "login");

      if (p === "/auth/google" && req.method === "GET") {
        if (!google.googleConfigured()) throw new HttpError(400, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET مش متضافين.");
        res.writeHead(302, { location: google.authUrl() });
        return res.end();
      }
      if (p === "/auth/google/callback" && req.method === "GET") {
        if (url.searchParams.get("error")) throw new HttpError(400, "تم إلغاء الربط مع Google.");
        await google.handleCallback(url.searchParams.get("code"), url.searchParams.get("state"));
        res.writeHead(302, { location: "/#/settings" });
        return res.end();
      }

      for (const r of routes) {
        const match = r.method === req.method && r.re.exec(p);
        if (!match) continue;
        const body = req.method === "GET" ? {} : await readJSON(req);
        return send(res, 200, await r.fn({ params: match.groups || {}, body, url }));
      }
      throw new HttpError(404, "not found");
    }

    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    await serveStatic(req, res, p);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : err instanceof google.GoogleError ? 502 : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    send(res, status, { error: status === 500 ? "خطأ داخلي في السيرفر" : err.message });
  }
});

// ───────────── daily follow-up email (opt-in) ─────────────
async function digestTick() {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
    const today = todayIso();
    const state = await store.readKV("digest", {});
    const g = await google.status();
    if (hour < Number(process.env.DIGEST_HOUR || 9) || state.last === today || !g.connected || !g.email) return;
    const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const due = openTasks(await store.listMeetings(), today).filter((t) => !t.done && t.due_date <= soon);
    await store.writeKV("digest", { last: today });
    if (!due.length) return;
    const line = (t) => `• ${t.title} — ${t.owner} — ${t.due_date} (${t.meetingTitle})`;
    const late = due.filter((t) => t.overdue);
    const next = due.filter((t) => !t.overdue);
    await google.sendEmail({
      to: g.email,
      subject: `مجلس — متابعة ${today}: ${late.length} متأخر، ${next.length} مستحق قريبًا`,
      body: [late.length ? `متأخر:\n${late.map(line).join("\n")}` : "", next.length ? `مستحق خلال يومين:\n${next.map(line).join("\n")}` : ""].filter(Boolean).join("\n\n"),
    });
  } catch (err) {
    console.error("[digest]", err.message);
  }
}

await store.init();
server.listen(PORT, () => {
  console.log(`مجلس شغّال على http://localhost:${PORT}`);
  if (!PASSWORD) console.warn("⚠ APP_PASSWORD مش متحدد — التطبيق مفتوح لأي حد يوصل للرابط.");
  if (claude.claudeDemo) console.warn("⚠ ANTHROPIC_API_KEY مش موجود — Claude في الوضع التجريبي.");
  if (!SONIOX_KEY) console.warn("⚠ SONIOX_API_KEY مش موجود — التفريغ الصوتي في الوضع التجريبي.");
});
if (process.env.DIGEST === "1") setInterval(digestTick, 15 * 60e3).unref();
