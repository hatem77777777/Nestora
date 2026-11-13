// End-to-end API test in demo mode (no API keys needed) + Google request-shape tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const procs = [];

async function boot(env) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "majlis-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: "ignore",
  });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (p, { method = "GET", body, cookie } = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  };
  return { call, dir };
}

let app;
before(async () => (app = await boot({})));
after(() => procs.forEach((p) => p.kill()));

test("full meeting flow: live ticks → speakers → finalize → follow-up", async () => {
  const { call } = app;
  const state = (await call("/api/state")).json;
  assert.deepEqual(state.demo, { stt: true, claude: true });

  const script = (await call("/api/demo-script")).json;
  const m = (await call("/api/meetings", { method: "POST", body: { title: "اختبار" } })).json;
  assert.equal(m.status, "live");

  const segs = script.map((s, i) => ({ ...s, t: i * 5 }));
  let r = (await call(`/api/meetings/${m.id}/tick`, { method: "POST", body: { segments: segs.slice(0, 4), offset: 0 } })).json;
  assert.equal(r.count, 4);
  assert.equal(r.speakers.A1.name, "كريم");
  assert.equal(r.board.insights.length, 1);

  // a retried request (same offset) must not duplicate the transcript
  r = (await call(`/api/meetings/${m.id}/tick`, { method: "POST", body: { segments: segs.slice(0, 4), offset: 0 } })).json;
  assert.equal(r.count, 4);

  // user correction wins over Claude from then on
  await call(`/api/meetings/${m.id}/speaker`, { method: "POST", body: { id: "A2", name: "طارق حسن", role: "مدير التنفيذ" } });
  r = (await call(`/api/meetings/${m.id}/tick`, { method: "POST", body: { segments: segs.slice(4, 9), offset: 4 } })).json;
  assert.equal(r.speakers.A2.name, "طارق حسن");
  assert.equal(r.speakers.A3.name, "سارة");
  assert.equal(r.board.topics.length, 2);

  r = (await call(`/api/meetings/${m.id}/tick`, { method: "POST", body: { segments: segs.slice(9), offset: 9, question: "إيه أكبر خطر؟" } })).json;
  assert.equal(r.count, script.length);
  assert.equal(r.board.topics.find((t) => t.id === "t1").status, "decided");
  assert.equal(r.board.decisions.length, 1);
  assert.equal(r.qa.length, 1);

  assert.equal((await call(`/api/meetings/${m.id}/finalize`, { method: "POST" })).json.status, "finalizing");
  let done;
  for (let i = 0; i < 40 && done?.status !== "done"; i++) {
    await new Promise((res) => setTimeout(res, 50));
    done = (await call(`/api/meetings/${m.id}`)).json;
  }
  assert.equal(done.status, "done");
  assert.ok(done.final.tasks.length >= 3);

  const first = done.final.tasks[0].id;
  await call(`/api/meetings/${m.id}/task`, { method: "POST", body: { taskId: first, done: true } });
  const follow = (await call("/api/followup")).json;
  assert.equal(follow.tasks.filter((t) => t.done).length, 1);
  assert.equal(follow.tasks.at(-1).id, first); // finished tasks sink to the bottom

  const roster = (await call("/api/roster")).json;
  assert.ok(roster.some((p) => p.name === "طارق حسن"));

  // Google not connected → clear error, nothing sent
  const mail = await call(`/api/meetings/${m.id}/email`, { method: "POST", body: { index: 0, to: "a@b.co" } });
  assert.equal(mail.status, 502);

  assert.equal((await call(`/api/meetings/${m.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/meetings/${m.id}`)).status, 404);
});

test("empty meeting cannot be finalized; bad ids are rejected", async () => {
  const { call } = app;
  const m = (await call("/api/meetings", { method: "POST", body: {} })).json;
  assert.equal((await call(`/api/meetings/${m.id}/finalize`, { method: "POST" })).status, 409);
  assert.equal((await call("/api/meetings/..%2F..%2Fetc")).status, 404);
  assert.equal((await call("/%2e%2e/server/index.js")).status, 404); // no path traversal out of public/
  assert.equal((await call("/styles.css")).status, 200);
});

test("password protects the API", async () => {
  const { call } = await boot({ APP_PASSWORD: "s3cret" });
  assert.equal((await call("/api/meetings")).status, 401);
  assert.equal((await call("/api/login", { method: "POST", body: { password: "nope" } })).status, 401);
  const ok = await call("/api/login", { method: "POST", body: { password: "s3cret" } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("/api/meetings", { cookie })).status, 200);
  assert.equal((await call("/api/meetings", { cookie: "majlis=deadbeef" })).status, 401);
});

test("google: request shapes for sheet, doc, gmail, calendar", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "majlis-g-"));
  Object.assign(process.env, { DATA_DIR: dir, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
  const store = await import("../server/store.js");
  await store.init();
  await store.writeKV("google", { refresh_token: "r", access_token: "a", expires_at: Date.now() + 3600e3, email: "me@x.co" });
  const google = await import("../server/google.js");
  const { demoFinal } = await import("../server/demo.js");

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify({ spreadsheetId: "S1", spreadsheetUrl: "https://sheet", id: "F1", webViewLink: "https://doc" }), { status: 200 });
  };
  try {
    const m = { title: "x", createdAt: Date.now(), speakers: { A1: { name: "كريم", role: "" } }, final: demoFinal() };

    assert.equal(await google.createSheet(m), "https://sheet");
    const values = JSON.parse(calls[1].opts.body);
    assert.equal(values.data[0].values.length, m.final.tasks.length + 1);
    assert.equal(values.data[0].values[1][2], "طارق");
    assert.match(calls[2].url, /S1:batchUpdate$/);

    calls.length = 0;
    assert.equal(await google.createDoc(m), "https://doc");
    assert.match(calls[0].opts.headers["content-type"], /^multipart\/related/);
    assert.ok(calls[0].opts.body.includes('dir="rtl"'));

    calls.length = 0;
    await google.sendEmail({ to: "a@b.co", subject: "متابعة", body: "أهلاً" });
    const mime = Buffer.from(JSON.parse(calls[0].opts.body).raw, "base64url").toString();
    assert.match(mime, /^To: a@b\.co\r\nSubject: =\?UTF-8\?B\?/);
    await assert.rejects(google.sendEmail({ to: "not-an-email", subject: "x", body: "y" }));
    // header injection attempt is rejected outright
    await assert.rejects(google.sendEmail({ to: "a@b.co\r\nBcc: evil@x.co", subject: "x", body: "y" }));

    calls.length = 0;
    assert.equal(await google.addDeadlines(m), m.final.tasks.length);
    const ev = JSON.parse(calls[0].opts.body);
    assert.equal(ev.start.date, m.final.tasks[0].due_date);
    assert.equal(await google.addDeadlines(m), 0); // never duplicates events
  } finally {
    globalThis.fetch = realFetch;
  }
});
