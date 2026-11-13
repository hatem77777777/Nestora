// Google Workspace: OAuth + Sheets / Docs / Gmail / Calendar over plain REST.
// Scopes are deliberately narrow: drive.file only reaches files this app creates,
// gmail.send can send but never read the mailbox.
import crypto from "node:crypto";
import { readKV, writeKV, removeKV } from "./store.js";

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, "");
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT = `${BASE_URL}/auth/google/callback`;
const TZ = process.env.TIMEZONE || "Africa/Cairo";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

export const googleConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);
export class GoogleError extends Error {}

const states = new Map();

export function authUrl() {
  const state = crypto.randomBytes(16).toString("hex");
  states.set(state, Date.now() + 10 * 60e3);
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(body) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new GoogleError(j.error_description || j.error || "Google token error");
  return j;
}

export async function handleCallback(code, state) {
  const exp = states.get(state);
  states.delete(state);
  if (!exp || exp < Date.now()) throw new GoogleError("جلسة الربط انتهت — جرّب تاني.");
  const t = await tokenRequest({ code, redirect_uri: REDIRECT, grant_type: "authorization_code" });
  if (!t.refresh_token) throw new GoogleError("Google ما رجّعش refresh token — افصل التطبيق من حسابك وجرّب تاني.");
  const tokens = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, email: "" };
  const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${t.access_token}` } });
  if (u.ok) tokens.email = (await u.json()).email || "";
  await writeKV("google", tokens);
}

export async function status() {
  const t = await readKV("google", null);
  return { configured: googleConfigured(), connected: !!t, email: t?.email || "" };
}
export const disconnect = () => removeKV("google");

async function accessToken() {
  const t = await readKV("google", null);
  if (!t) throw new GoogleError("حساب Google مش مربوط.");
  if (t.access_token && t.expires_at > Date.now() + 60e3) return t.access_token;
  const r = await tokenRequest({ refresh_token: t.refresh_token, grant_type: "refresh_token" });
  t.access_token = r.access_token;
  t.expires_at = Date.now() + r.expires_in * 1000;
  await writeKV("google", t);
  return t.access_token;
}

async function api(url, { method = "POST", body, headers = {}, raw } = {}) {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, ...(raw ? {} : { "content-type": "application/json" }), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(j.error?.message || `Google API ${r.status}`);
  return j;
}

// ───────────── Sheets: task plan + decisions/goals ─────────────
const PRIORITY = { high: "عالية", medium: "متوسطة", low: "منخفضة" };

export async function createSheet(m) {
  const f = m.final;
  const title = `${f.title || m.title || "اجتماع"} — خطة المهام`;
  const sheet = await api("https://sheets.googleapis.com/v4/spreadsheets", {
    body: {
      properties: { title, timeZone: TZ },
      sheets: [
        { properties: { sheetId: 0, title: "المهام", rightToLeft: true, gridProperties: { frozenRowCount: 1 } } },
        { properties: { sheetId: 1, title: "الأهداف والقرارات", rightToLeft: true, gridProperties: { frozenRowCount: 1 } } },
      ],
    },
  });
  const id = sheet.spreadsheetId;
  const taskRows = [
    ["#", "المهمة", "المسؤول", "البداية", "الاستحقاق", "الأولوية", "المُخرَج", "يعتمد على", "الموضوع", "الحالة", "ملاحظات"],
    ...f.tasks.map((t) => [
      t.id, t.title, t.owner, t.start_date, t.due_date, PRIORITY[t.priority] || t.priority, t.deliverable,
      (t.depends_on || []).join(", "), t.topic, t.done ? "تم" : "لم يبدأ", t.assumed ? "تاريخ/مسؤول مقترح — يحتاج تأكيد" : "",
    ]),
  ];
  const goalRows = [
    ["الموضوع", "الهدف", "KPI", "الحل"],
    ...f.topics.map((t) => [t.title, t.goal, t.kpi, t.solution]),
    [],
    ["القرارات"],
    ...f.decisions.map((d) => [d]),
    [],
    ["أسئلة معلّقة"],
    ...f.open_questions.map((q) => [q]),
  ];
  await api(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    body: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: "'المهام'!A1", values: taskRows },
        { range: "'الأهداف والقرارات'!A1", values: goalRows },
      ],
    },
  });
  const header = (sheetId, cols) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols },
      cell: { userEnteredFormat: { backgroundColor: { red: 0.07, green: 0.1, blue: 0.16 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
      fields: "userEnteredFormat(backgroundColor,textFormat)",
    },
  });
  await api(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
    body: {
      requests: [
        header(0, 11),
        header(1, 4),
        {
          setDataValidation: {
            range: { sheetId: 0, startRowIndex: 1, endRowIndex: taskRows.length, startColumnIndex: 9, endColumnIndex: 10 },
            rule: { condition: { type: "ONE_OF_LIST", values: ["لم يبدأ", "جاري", "متأخر", "تم"].map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false },
          },
        },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 11 } } },
        { autoResizeDimensions: { dimensions: { sheetId: 1, dimension: "COLUMNS", startIndex: 0, endIndex: 4 } } },
      ],
    },
  });
  return sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}`;
}

// ───────────── Docs: minutes, uploaded as HTML and converted ─────────────
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function minutesHtml(m, dateStr) {
  const f = m.final;
  const li = (a) => a.map((x) => `<li>${esc(x)}</li>`).join("");
  const people = Object.values(m.speakers).filter((s) => s.name).map((s) => `${s.name}${s.role ? ` (${s.role})` : ""}`);
  return `<html><body dir="rtl" style="font-family:Arial">
<h1>${esc(f.title || m.title || "محضر اجتماع")}</h1>
<p><b>التاريخ:</b> ${esc(dateStr)}${people.length ? ` &nbsp;|&nbsp; <b>الحاضرون:</b> ${esc(people.join("، "))}` : ""}</p>
<h2>الخلاصة</h2><p>${esc(f.summary)}</p>
<h2>القرارات</h2><ul>${li(f.decisions)}</ul>
<h2>الأهداف</h2>
<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>الموضوع</th><th>الهدف</th><th>KPI</th><th>الحل</th></tr>
${f.topics.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.goal)}</td><td>${esc(t.kpi)}</td><td>${esc(t.solution)}</td></tr>`).join("")}</table>
<h2>خطة المهام</h2>
<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>#</th><th>المهمة</th><th>المسؤول</th><th>البداية</th><th>الاستحقاق</th><th>الأولوية</th><th>المُخرَج</th></tr>
${f.tasks.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.owner)}</td><td>${esc(t.start_date)}</td><td>${esc(t.due_date)}</td><td>${esc(PRIORITY[t.priority] || t.priority)}</td><td>${esc(t.deliverable)}</td></tr>`).join("")}</table>
<h2>أسئلة معلّقة</h2><ul>${li(f.open_questions)}</ul>
<h2>الاجتماع القادم</h2><p>${esc(f.next_meeting.suggested_date)}</p><ul>${li(f.next_meeting.agenda)}</ul>
</body></html>`;
}

export async function createDoc(m) {
  const dateStr = new Intl.DateTimeFormat("ar-EG", { timeZone: TZ, dateStyle: "full" }).format(new Date(m.createdAt));
  const boundary = `majlis${crypto.randomBytes(8).toString("hex")}`;
  const meta = { name: `${m.final.title || m.title || "اجتماع"} — المحضر`, mimeType: "application/vnd.google-apps.document" };
  const raw =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\ncontent-type: text/html; charset=UTF-8\r\n\r\n${minutesHtml(m, dateStr)}\r\n--${boundary}--`;
  const file = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    raw,
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
  });
  return file.webViewLink || `https://docs.google.com/document/d/${file.id}`;
}

// ───────────── Gmail ─────────────
const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const isEmail = (s) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);

export function buildMime({ to, subject, body }) {
  const recipients = String(to).split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length || !recipients.every(isEmail)) throw new GoogleError("عنوان الإيميل غير صحيح.");
  return [
    `To: ${recipients.join(", ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(String(subject).replace(/[\r\n]+/g, " "), "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(String(body), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].join("\r\n");
}

export async function sendEmail(mail) {
  await api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { body: { raw: b64url(buildMime(mail)) } });
}

// ───────────── Calendar: one all-day deadline per open task ─────────────
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

export async function addDeadlines(m) {
  let n = 0;
  for (const t of m.final.tasks) {
    if (t.done || t.calendarEventId || !/^\d{4}-\d{2}-\d{2}$/.test(t.due_date)) continue;
    const ev = await api("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      body: {
        summary: `⏰ ${t.title} — ${t.owner}`,
        description: `من اجتماع: ${m.final.title || m.title}\nالمُخرَج: ${t.deliverable}`,
        start: { date: t.due_date },
        end: { date: nextDay(t.due_date) },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 9 * 60 }] },
      },
    });
    t.calendarEventId = ev.id;
    n++;
  }
  return n;
}
