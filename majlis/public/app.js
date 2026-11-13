import { Capture, SttStream, DemoStt, loadAudio, deleteAudio } from "/audio.js";

const app = document.getElementById("app");
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);
const fmtClock = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtDate = (ms) => new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const fmtDay = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "short" }).format(new Date(`${iso}T12:00:00`)) : iso);

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.3-1.3L14 3h-4l-.3 2.5a7 7 0 0 0-2.3 1.3l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.3 1.3L10 21h4l.3-2.5a7 7 0 0 0 2.3-1.3l2.3 1 2-3.4-2-1.5A7 7 0 0 0 19 12z"/></svg>',
};
const KIND = { risk: ["خطر", "risk"], question: ["اسأل", "q"], opinion: ["رأي", "gold"], opportunity: ["فرصة", "ok"], solution: ["حل", "ok"] };
const PRIORITY = { high: ["عالية", "risk"], medium: ["متوسطة", "gold"], low: ["منخفضة", ""] };
const STATUS = { open: ["مفتوح", "gold"], decided: ["اتحسم", "ok"], parked: ["مؤجل", ""] };

// ───────────── infra ─────────────
let info = null;
let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.innerHTML = `<div>${h(text)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.innerHTML = ""), 4500);
}

async function api(path, { method = "GET", body } = {}) {
  let r;
  try {
    r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error("مفيش اتصال بالسيرفر");
    e.offline = true;
    throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") {
    loginView();
    throw new Error("سجّل الدخول أولًا");
  }
  if (!r.ok) {
    const e = new Error(j.error || `خطأ ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

function dialog(html, onMount) {
  const d = $("#dlg");
  d.innerHTML = html;
  d.showModal();
  d.onclick = (e) => e.target === d && d.close();
  onMount?.(d);
  return d;
}
const confirmDlg = (title, text, okLabel = "تأكيد") =>
  new Promise((resolve) => {
    const d = dialog(
      `<h3>${h(title)}</h3><p class="muted" style="margin:8px 0 18px;white-space:pre-wrap">${h(text)}</p>
       <div class="row"><button class="btn grow" data-ok>${h(okLabel)}</button><button class="btn ghost grow" data-no>إلغاء</button></div>`,
    );
    d.onclose = () => resolve(d.returnValue === "ok");
    $("[data-ok]", d).onclick = () => d.close("ok");
    $("[data-no]", d).onclick = () => d.close();
  });

const nav = (on) => `
  <nav class="nav">
    <a href="#/" class="${on === "home" ? "on" : ""}">${ICON.home}الرئيسية</a>
    <a href="#/follow" class="${on === "follow" ? "on" : ""}">${ICON.check}المتابعة</a>
    <a href="#/settings" class="${on === "settings" ? "on" : ""}">${ICON.gear}الإعدادات</a>
  </nav>`;
const liveBar = () => (live ? `<a class="livebar" href="#/live/${live.id}"><span class="dot" style="background:#fff"></span> اجتماع جاري — ارجع له</a>` : "");
const demoBanner = () =>
  info.demo.stt || info.demo.claude
    ? `<div class="banner">وضع تجريبي: ${[info.demo.stt && "التفريغ الصوتي", info.demo.claude && "Claude"].filter(Boolean).join(" و ")} بيشتغل ببيانات مثال. ضيف المفاتيح من الإعدادات للتشغيل الفعلي.</div>`
    : "";

// ───────────── login ─────────────
function loginView() {
  app.innerHTML = `
    <div class="hero" style="padding-top:20vh">
      <h1>مجلس</h1><p class="muted">مستشارك داخل الاجتماع</p>
      <form class="stack" style="margin-top:24px" id="f">
        <input type="password" name="p" placeholder="كلمة السر" autocomplete="current-password" required>
        <button class="btn" style="width:100%">دخول</button>
      </form>
    </div>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/login", { method: "POST", body: { password: e.target.p.value } });
      info = null;
      router();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ───────────── home ─────────────
async function homeView() {
  const meetings = await api("/api/meetings");
  app.innerHTML = `
    <div class="brand"><b>مجلس</b><span class="chip gold">Claude</span></div>
    ${liveBar()}${demoBanner()}
    <section class="hero">
      <button class="mic" id="start" aria-label="ابدأ التسجيل">${ICON.mic}</button>
      <h1>ابدأ الاجتماع</h1>
      <p class="muted">Claude هيسمع، يعرف مين بيتكلم، ويقترح عليك لحظيًا</p>
    </section>
    <div class="stack">
      <input id="title" placeholder="عنوان الاجتماع (اختياري)" maxlength="200">
      <details class="ctx"><summary>+ أجندة أو سياق يساعد Claude (اختياري)</summary>
        <textarea id="context" maxlength="4000" placeholder="مثال: اجتماع مع المورد لقفل سعر الإضاءة. هدفي خصم 10% وتسليم قبل يوم 15. الحاضرين: أحمد (المورد)، منى (المشتريات)."></textarea>
      </details>
      <p class="small muted">بالضغط على زر التسجيل أنت بتأكد إن الحاضرين عارفين إن الاجتماع بيتسجّل.</p>
    </div>
    <h2>الاجتماعات السابقة</h2>
    <div class="stack mlist">
      ${
        meetings.length
          ? meetings.map((m) => `
        <a href="#/${m.status === "live" ? "live" : "m"}/${m.id}"><div class="card">
          <div class="row between"><h3 class="grow">${h(m.title || "اجتماع بدون عنوان")}</h3>
          ${m.status === "live" ? '<span class="chip risk">لم يُقفل</span>' : m.status === "done" ? `<span class="chip ${m.done === m.tasks && m.tasks ? "ok" : ""}"><span class="num">${m.done}/${m.tasks}</span> مهام</span>` : m.status === "error" ? '<span class="chip risk">خطأ</span>' : '<span class="chip gold">بيتجهّز</span>'}</div>
          <p class="small muted">${fmtDate(m.createdAt)}${m.people.length ? ` · ${h(m.people.join("، "))}` : ""}</p>
        </div></a>`).join("")
          : '<p class="empty">لسه مفيش اجتماعات. دوس على الزر الأحمر وابدأ أول واحد.</p>'
      }
    </div>
    ${nav("home")}`;
  $("#start").onclick = () => startMeeting($("#title").value, $("#context").value);
}

// ───────────── live session ─────────────
let live = null;

function elapsed() {
  return (live.accum + (live.paused ? 0 : Date.now() - live.resumedAt)) / 1000;
}

async function startMeeting(title, context, existing) {
  if (live) return (location.hash = `#/live/${live.id}`);
  const btn = $("#start") || $("#resume");
  if (btn) btn.disabled = true;
  try {
    // Mic first, inside the tap, so iOS keeps the permission gesture.
    const pending = [];
    const cap = info.demo.stt ? null : new Capture({ onPcm: (b) => (live?.stt ? live.stt.send(b) : pending.push(b)), onLevel: (v) => live && (live.level = v) });
    if (cap) await cap.start();
    const m = existing || (await api("/api/meetings", { method: "POST", body: { title, context } }));
    if (cap) cap.meetingId = m.id;
    const lastT = m.segments.at(-1)?.t || 0;
    live = {
      id: m.id, title: m.title, capture: cap, level: 0,
      accum: lastT * 1000, resumedAt: Date.now(), paused: false,
      segments: [...m.segments], sent: m.segments.length, cur: null, interim: "",
      speakers: m.speakers, board: m.board, qa: m.qa, fresh: new Set(),
      questions: [], inflight: false, lastTick: Date.now(), state: "connecting", tab: "advisor",
    };
    const handlers = { onFinal: onFinal, onInterim: (t) => ((live.interim = t), paintInterim()), onState: (s) => ((live.state = s), paintHead()) };
    if (info.demo.stt) {
      live.stt = new DemoStt({ script: await api("/api/demo-script"), ...handlers });
    } else {
      const roster = await api("/api/roster").catch(() => []);
      live.stt = new SttStream({ getToken: () => api("/api/stt-token", { method: "POST" }), terms: roster.map((r) => r.name), ...handlers });
      for (const b of pending) live.stt.send(b);
      cap.onLost = () => toast("الميكروفون اتقطع — تأكد إن مفيش تطبيق تاني بيستخدمه.");
    }
    live.stt.connect();
    live.loop = setInterval(tickLoop, 3000);
    live.clock = setInterval(paintHead, 250);
    if (location.hash === `#/live/${m.id}`) liveView(m.id);
    else location.hash = `#/live/${m.id}`;
  } catch (err) {
    if (btn) btn.disabled = false;
    toast(err.name === "NotAllowedError" ? "لازم تسمح للمتصفح باستخدام الميكروفون." : err.message || "تعذّر بدء التسجيل");
  }
}

function closeSeg() {
  const c = live.cur;
  live.cur = null;
  if (!c || !c.text.trim()) return;
  live.segments.push({ t: c.t, sp: c.sp, text: c.text.trim() });
  paintTranscript();
}
function onFinal({ sp, text, end }) {
  if (!live) return;
  if (end) return closeSeg();
  if (live.cur && live.cur.sp !== sp) closeSeg();
  live.cur ??= { sp, text: "", t: Math.round(elapsed()) };
  live.cur.text += text;
  if (live.cur.text.length > 260 && /[.،؟!?\s]$/.test(text)) closeSeg();
  else paintInterim();
}

async function tickLoop(force) {
  if (!live || live.inflight) return;
  if (live.paused) live.stt.keepAlive();
  const batch = live.segments.slice(live.sent);
  const words = batch.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  const since = Date.now() - live.lastTick;
  const question = live.questions[0];
  if (!(force || question || (words >= 30 && since >= 15000) || (words > 0 && since >= 40000))) return;
  if (!batch.length && !question) return;
  live.inflight = true;
  paintHead();
  const L = live;
  try {
    const r = await api(`/api/meetings/${L.id}/tick`, { method: "POST", body: { segments: batch, offset: L.sent, question } });
    L.sent += batch.length;
    if (question) L.questions.shift();
    const known = new Set(L.board.insights.map((i) => i.id));
    L.fresh = new Set(r.board.insights.filter((i) => !known.has(i.id)).map((i) => i.id));
    Object.assign(L, { speakers: r.speakers, board: r.board, qa: r.qa });
    if (L.fresh.size && navigator.vibrate) navigator.vibrate(30);
    if (live === L) (paintBoard(), paintTranscript(), paintPeople());
  } catch (err) {
    if (!err.offline) L.sent += batch.length; // stored server-side; only the analysis failed
    L.tickError = err.message;
  } finally {
    L.inflight = false;
    L.lastTick = Date.now();
    if (live === L) paintHead();
  }
}

async function stopMeeting() {
  if (!(await confirmDlg("إنهاء الاجتماع؟", "Claude هيجهّز الملخص وخطة المهام والإيميلات.", "إنهاء"))) return;
  const L = live;
  clearInterval(L.loop);
  clearInterval(L.clock);
  app.innerHTML = `<div class="empty" style="padding-top:30vh"><div class="spinner"></div><h3>بقفل التسجيل…</h3></div>`;
  await L.stt.stop().catch(() => {});
  closeSeg();
  await L.capture?.stop().catch(() => {});
  for (let i = 0; i < 3 && L.sent < L.segments.length; i++) {
    L.inflight = false;
    await tickLoop(true);
  }
  live = null;
  try {
    await api(`/api/meetings/${L.id}/finalize`, { method: "POST" });
  } catch (err) {
    toast(err.message);
  }
  location.hash = `#/m/${L.id}`;
}

async function togglePause() {
  const L = live;
  if (L.paused) {
    L.resumedAt = Date.now();
    await L.capture?.resume();
  } else {
    L.accum += Date.now() - L.resumedAt;
    await L.capture?.pause();
  }
  L.paused = !L.paused;
  if (L.stt instanceof DemoStt) L.stt.paused = L.paused;
  $("#pause").innerHTML = L.paused ? ICON.play : ICON.pause;
  paintHead();
}

const spColor = (id) => `c${[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 6}`;
const spChip = (id, speakers) => {
  const s = speakers[id];
  return `<button class="sp ${spColor(id)} ${s?.name ? "" : "unknown"}" data-sp="${h(id)}">${h(s?.name || `متحدث ${id}`)}</button>`;
};

function renameSpeaker(meetingId, id, speakers, done) {
  const s = speakers[id] || {};
  const d = dialog(`
    <h3>مين ده؟</h3><p class="small muted" style="margin:4px 0 14px">${s.evidence ? `استنتاج Claude: ${h(s.evidence)}` : "اكتب الاسم والدور — Claude هيلتزم بيهم."}</p>
    <form class="stack" method="dialog">
      <input name="name" placeholder="الاسم" value="${h(s.name || "")}" maxlength="80" required>
      <input name="role" placeholder="الدور (مثال: مدير المشتريات)" value="${h(s.role || "")}" maxlength="120">
      <div class="row"><button class="btn grow" value="ok">حفظ</button><button class="btn ghost grow" value="" formnovalidate>إلغاء</button></div>
    </form>`);
  d.onclose = async () => {
    if (d.returnValue !== "ok") return;
    const f = $("form", d);
    try {
      const r = await api(`/api/meetings/${meetingId}/speaker`, { method: "POST", body: { id, name: f.name.value, role: f.role.value } });
      done(r.speakers);
    } catch (err) {
      toast(err.message);
    }
  };
}

function boardHtml(board, fresh = new Set()) {
  const insights = [...board.insights].reverse();
  const topicName = (id) => board.topics.find((t) => t.id === id)?.title;
  return `
    ${
      insights.length
        ? insights.map((i) => `
      <div class="card insight ${h(i.kind)} ${fresh.has(i.id) ? "new" : ""}">
        <div class="row between" style="margin-bottom:6px"><span class="chip ${KIND[i.kind]?.[1] || ""}">${KIND[i.kind]?.[0] || "رأي"}</span><span class="small muted num">${fmtClock(i.t || 0).slice(3)}</span></div>
        <p>${h(i.text)}</p>
        ${i.basis || topicName(i.topic_id) ? `<p class="basis">${h([topicName(i.topic_id), i.basis].filter(Boolean).join(" · "))}</p>` : ""}
      </div>`).join("")
        : '<p class="empty">Claude بيسمع… أول رأي هيظهر هنا لما يبقى فيه حاجة تستاهل.</p>'
    }
    ${board.topics.length ? "<h2>المواضيع والأهداف</h2>" : ""}
    ${board.topics.map((t) => `
      <div class="card topic">
        <div class="row between"><h3 class="grow">${h(t.title)}</h3><span class="chip ${STATUS[t.status]?.[1] || ""}">${STATUS[t.status]?.[0] || ""}</span></div>
        <p class="small muted">${h(t.summary)}</p>
        ${t.goal ? `<div class="goal">الهدف: ${h(t.goal)}</div>` : ""}
        ${t.solutions?.length ? `<ul>${t.solutions.map((s) => `<li>${h(s)}</li>`).join("")}</ul>` : ""}
      </div>`).join("")}
    ${board.decisions.length ? `<h2>قرارات</h2><div class="card"><ul class="plain">${board.decisions.map((d) => `<li>${h(d.text)}</li>`).join("")}</ul></div>` : ""}
    ${board.actions.length ? `<h2>التزامات اتقالت</h2><div class="card"><ul class="plain">${board.actions.map((a) => `<li><b>${h(a.owner || "؟")}</b>: ${h(a.text)}${a.due_hint ? ` <span class="muted">(${h(a.due_hint)})</span>` : ""}</li>`).join("")}</ul></div>` : ""}`;
}
const transcriptHtml = (segments, speakers) =>
  segments.map((s) => `<div class="seg"><div class="row">${spChip(s.sp, speakers)}<span class="small muted num">${fmtClock(s.t).slice(3)}</span></div><p>${h(s.text)}</p></div>`).join("");

function liveView(id) {
  if (!live || live.id !== id) return resumeView(id);
  app.innerHTML = `
    <header class="live-head">
      <div class="row between">
        <div class="row"><span class="dot" id="dot"></span><span class="timer num" id="timer">00:00:00</span></div>
        <span class="chip" id="state"></span>
      </div>
      <div class="meter"><i id="meter"></i></div>
      <div class="people" id="people" style="margin-top:10px"></div>
      <div class="tabs"><button data-tab="advisor">المستشار</button><button data-tab="transcript">النص</button></div>
    </header>
    ${demoBanner()}
    <section id="advisor" class="stack" style="margin-top:12px"></section>
    <section id="transcript" hidden><div id="segs"></div><div class="interim" id="interim"></div></section>
    <div class="dock"><form class="in" id="ask">
      <button type="button" class="icon-btn stop" id="stop" aria-label="إنهاء">${ICON.stop}</button>
      <button type="button" class="icon-btn" id="pause" aria-label="إيقاف مؤقت">${live.paused ? ICON.play : ICON.pause}</button>
      <input name="q" placeholder="اسأل Claude عن الاجتماع…" maxlength="1000" autocomplete="off" enterkeyhint="send">
      <button class="icon-btn" aria-label="إرسال">${ICON.send}</button>
    </form></div>`;
  const setTab = (t) => {
    live.tab = t;
    $("#advisor").hidden = t !== "advisor";
    $("#transcript").hidden = t !== "transcript";
    app.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  };
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  setTab(live.tab);
  $("#stop").onclick = stopMeeting;
  $("#pause").onclick = togglePause;
  $("#ask").onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    live.questions.push(q);
    e.target.q.value = "";
    setTab("advisor");
    paintBoard();
    tickLoop();
  };
  app.onclick = (e) => {
    const sp = e.target.closest("[data-sp]");
    if (sp && live) renameSpeaker(live.id, sp.dataset.sp, live.speakers, (s) => ((live.speakers = s), paintPeople(), paintTranscript()));
  };
  paintHead(); paintPeople(); paintBoard(); paintTranscript();
}

function paintHead() {
  if (!live || !$("#timer")) return;
  $("#timer").textContent = fmtClock(elapsed());
  $("#dot").classList.toggle("off", live.paused || live.state !== "live");
  $("#meter").style.width = live.paused ? "0" : `${Math.min(100, Math.sqrt(live.level) * 260)}%`;
  const st = $("#state");
  const [text, cls] = live.paused ? ["متوقف مؤقتًا", ""] : live.state === "reconnecting" ? ["بيعيد الاتصال — الصوت محفوظ", "risk"] : live.state === "connecting" ? ["بيتصل…", ""] : live.inflight ? ["Claude بيحلل…", "gold"] : ["بيسمع", "ok"];
  st.textContent = text;
  st.className = `chip ${cls}`;
}
function paintPeople() {
  const el = $("#people");
  if (!el || !live) return;
  const ids = [...new Set(live.segments.map((s) => s.sp))];
  el.innerHTML = ids.map((id) => spChip(id, live.speakers)).join("") || '<span class="small muted">هيظهر هنا كل متحدث — دوس على الاسم لتصحيحه</span>';
}
function paintBoard() {
  const el = $("#advisor");
  if (!el || !live) return;
  const qa = [...live.qa].reverse().map((x) => `<div class="card qa"><p class="q">${h(x.q)}</p><p class="a">${h(x.a)}</p></div>`).join("");
  const waiting = live.questions.map((q) => `<div class="card qa"><p class="q">${h(q)}</p><p class="a muted">Claude بيفكر…</p></div>`).join("");
  el.innerHTML = waiting + qa + boardHtml(live.board, live.fresh);
}
function paintTranscript() {
  const el = $("#segs");
  if (!el || !live) return;
  el.innerHTML = transcriptHtml(live.segments, live.speakers) || '<p class="empty">الكلام هيظهر هنا أول ما حد يتكلم.</p>';
  paintInterim();
}
function paintInterim() {
  const el = $("#interim");
  if (!el || !live) return;
  el.textContent = (live.cur?.text || "") + live.interim;
  if (live.tab === "transcript" && innerHeight + scrollY > document.body.offsetHeight - 240) scrollTo(0, document.body.scrollHeight);
}

// A live meeting whose page was reloaded / phone restarted.
async function resumeView(id) {
  const m = await api(`/api/meetings/${id}`);
  if (m.status !== "live") return (location.hash = `#/m/${id}`);
  app.innerHTML = `
    <div class="hero" style="padding-top:14vh">
      <h1>${h(m.title || "اجتماع لم يُقفل")}</h1>
      <p class="muted">التسجيل وقف (الصفحة اتقفلت أو الموبايل نام). اللي اتسجّل محفوظ: <span class="num">${m.segments.length}</span> مقطع.</p>
      <div class="stack" style="margin-top:22px">
        <button class="btn" id="resume" style="width:100%">${ICON.mic} كمّل التسجيل</button>
        <button class="btn ghost" id="finish" style="width:100%" ${m.segments.length ? "" : "disabled"}>اقفل الاجتماع وطلّع المخرجات</button>
        <button class="btn ghost" id="del" style="width:100%">احذف الاجتماع</button>
      </div>
    </div>${nav("home")}`;
  $("#resume").onclick = () => startMeeting("", "", m);
  $("#finish").onclick = async () => {
    await api(`/api/meetings/${id}/finalize`, { method: "POST" }).catch((e) => toast(e.message));
    location.hash = `#/m/${id}`;
  };
  $("#del").onclick = () => removeMeeting(id);
}

async function removeMeeting(id) {
  if (!(await confirmDlg("حذف الاجتماع؟", "هيتمسح النص والمخرجات والتسجيل الصوتي من الجهاز. مفيش تراجع.", "احذف"))) return;
  await api(`/api/meetings/${id}`, { method: "DELETE" });
  await deleteAudio(id).catch(() => {});
  location.hash = "#/";
}

// ───────────── meeting result ─────────────
let pollTimer;
async function meetingView(id) {
  clearTimeout(pollTimer);
  const m = await api(`/api/meetings/${id}`);
  if (m.status === "live") return (location.hash = `#/live/${id}`);
  if (m.status === "finalizing") {
    app.innerHTML = `<div class="empty" style="padding-top:26vh"><div class="spinner"></div><h3>Claude بيجهّز المخرجات</h3><p class="small">ملخص · أهداف · خطة مهام بجدول زمني · مسودات إيميلات<br>بياخد حوالي دقيقة. تقدر تقفل الصفحة وترجع.</p></div>${nav("home")}`;
    pollTimer = setTimeout(() => location.hash === `#/m/${id}` && meetingView(id), 2500);
    return;
  }
  if (m.status === "error" || !m.final) {
    app.innerHTML = `<div class="empty" style="padding-top:22vh"><h3>المخرجات ما اتجهزتش</h3><p class="small" style="margin:8px 0 18px">${h(m.error || "")}</p>
      <div class="stack"><button class="btn" id="retry">حاول تاني</button><br><button class="btn ghost" id="del">احذف الاجتماع</button></div></div>${nav("home")}`;
    $("#retry").onclick = async () => {
      await api(`/api/meetings/${id}/finalize`, { method: "POST" }).catch((e) => toast(e.message));
      meetingView(id);
    };
    $("#del").onclick = () => removeMeeting(id);
    return;
  }
  const f = m.final;
  const roster = await api("/api/roster").catch(() => []);
  const g = info.google;
  const people = Object.values(m.speakers).filter((s) => s.name);
  const gbtn = (kind, label, url) =>
    url && kind !== "calendar"
      ? `<a class="btn ghost sm" href="${h(url)}" target="_blank" rel="noopener">فتح ${label} ↗</a>`
      : `<button class="btn ghost sm" data-export="${kind}">${label}${kind === "calendar" && m.exports.calendarCount ? " ✓" : ""}</button>`;

  app.innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">→ الرئيسية</a>
    <h1 style="margin-top:6px">${h(f.title || m.title || "اجتماع")}</h1>
    <p class="small muted">${fmtDate(m.createdAt)}${people.length ? ` · ${h(people.map((p) => p.name).join("، "))}` : ""}</p>

    <h2>الخلاصة</h2>
    <div class="card"><p>${h(f.summary)}</p></div>

    ${f.decisions.length ? `<h2>القرارات</h2><div class="card"><ul class="plain">${f.decisions.map((d) => `<li>${h(d)}</li>`).join("")}</ul></div>` : ""}

    <h2>الأهداف</h2>
    <div class="stack">${f.topics.map((t) => `
      <div class="card topic"><h3>${h(t.title)}</h3><p class="small muted">${h(t.summary)}</p>
      <div class="goal">الهدف: ${h(t.goal)}</div>
      <p class="small" style="margin-top:8px"><b>KPI:</b> ${h(t.kpi)}</p><p class="small"><b>الحل:</b> ${h(t.solution)}</p></div>`).join("")}</div>

    <h2>خطة المهام <span class="num">(${f.tasks.length})</span></h2>
    <div class="card" id="tasks">${f.tasks.map((t) => taskHtml(t, id)).join("") || '<p class="muted">مفيش مهام.</p>'}</div>

    ${f.tasks.length ? `<h2>الجدول الزمني</h2><div class="card">${ganttHtml(f.tasks)}</div>` : ""}

    <h2>Google</h2>
    <div class="card stack">
      ${g.connected ? `<div class="row wrap">${gbtn("sheet", "شيت المهام", m.exports.sheetUrl)}${gbtn("doc", "محضر Docs", m.exports.docUrl)}${gbtn("calendar", "المواعيد على Calendar")}</div><p class="small muted">الملفات بتتعمل على حساب ${h(g.email)}.</p>`
        : `<p class="small muted">اربط حساب Google عشان تعمل شيت المهام والمحضر وتبعت الإيميلات.</p><a class="btn sm" href="#/settings">ربط Google</a>`}
    </div>

    <h2>مسودات الإيميلات — مفيش حاجة بتتبعت غير لما تدوس إرسال</h2>
    <div class="card">${f.emails.map((e, i) => {
      const known = roster.find((r) => r.name === e.to_name)?.email || "";
      return `<details class="fold"><summary><span>${h(e.to_name)} — ${h(e.subject)}</span>${e.sentAt ? '<span class="chip ok">اتبعت</span>' : ""}</summary>
        <form class="body stack" data-mail="${i}">
          <input name="to" type="text" inputmode="email" dir="ltr" placeholder="email@example.com" value="${h(e.sentTo || known)}" required>
          <input name="subject" value="${h(e.subject)}" required>
          <textarea name="body" rows="8" required>${h(e.body)}</textarea>
          <button class="btn sm" ${g.connected ? "" : "disabled"}>${e.sentAt ? "إرسال مرة تانية" : "إرسال"}</button>
        </form></details>`;
    }).join("")}</div>

    ${f.open_questions.length ? `<h2>أسئلة معلّقة</h2><div class="card"><ul class="plain">${f.open_questions.map((q) => `<li>${h(q)}</li>`).join("")}</ul></div>` : ""}

    <h2>الاجتماع القادم</h2>
    <div class="card"><p><b>${h(fmtDay(f.next_meeting.suggested_date))}</b></p><ul class="plain">${f.next_meeting.agenda.map((a) => `<li>${h(a)}</li>`).join("")}</ul></div>

    <h2>السجل</h2>
    <div class="card">
      <details class="fold"><summary>آراء Claude أثناء الاجتماع <span class="chip num">${m.board.insights.length}</span></summary><div class="body stack">${boardHtml({ ...m.board, topics: [], decisions: [], actions: [] })}</div></details>
      <details class="fold"><summary>النص الكامل <span class="chip num">${m.segments.length}</span></summary><div class="body" id="segs">${transcriptHtml(m.segments, m.speakers)}</div></details>
      <details class="fold" id="audiofold"><summary>التسجيل الصوتي (محفوظ على الجهاز ده)</summary><div class="body" id="audio"><p class="small muted">بيتحمّل…</p></div></details>
    </div>
    <p style="margin-top:20px;text-align:center"><button class="small muted" id="del" style="text-decoration:underline">حذف الاجتماع</button></p>
    ${nav("home")}`;

  $("#del").onclick = () => removeMeeting(id);
  $("#audiofold").ontoggle = async (e) => {
    if (!e.target.open) return;
    const blob = await loadAudio(id).catch(() => null);
    $("#audio").innerHTML = blob ? `<audio controls src="${URL.createObjectURL(blob)}"></audio>` : '<p class="small muted">مفيش تسجيل صوتي على الجهاز ده (التسجيل بيتحفظ على الموبايل اللي سجّل فقط).</p>';
  };
  app.onclick = async (e) => {
    const ex = e.target.closest("[data-export]");
    const sp = e.target.closest("[data-sp]");
    if (sp) return renameSpeaker(id, sp.dataset.sp, m.speakers, () => meetingView(id));
    if (!ex) return;
    ex.disabled = true;
    ex.textContent = "بيتجهّز…";
    try {
      const r = await api(`/api/meetings/${id}/export`, { method: "POST", body: { kind: ex.dataset.export } });
      if (ex.dataset.export === "calendar") toast("المواعيد اتضافت على التقويم.");
      const url = ex.dataset.export === "sheet" ? r.exports.sheetUrl : ex.dataset.export === "doc" ? r.exports.docUrl : null;
      if (url) window.open(url, "_blank", "noopener");
    } catch (err) {
      toast(err.message);
    }
    meetingView(id);
  };
  app.onchange = (e) => e.target.matches("[data-task]") && toggleTask(e.target);
  app.onsubmit = async (e) => {
    const form = e.target.closest("[data-mail]");
    if (!form) return;
    e.preventDefault();
    if (!(await confirmDlg("إرسال الإيميل؟", `إلى: ${form.to.value}\nالموضوع: ${form.subject.value}`, "إرسال"))) return;
    const btn = $("button", form);
    btn.disabled = true;
    try {
      await api(`/api/meetings/${id}/email`, { method: "POST", body: { index: Number(form.dataset.mail), to: form.to.value, subject: form.subject.value, body: form.body.value } });
      toast("اتبعت ✓");
      meetingView(id);
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  };
}

function taskHtml(t, meetingId, extra = "") {
  const [pl, pc] = PRIORITY[t.priority] || ["", ""];
  return `<label class="task ${t.done ? "done" : ""}">
    <input type="checkbox" data-task="${h(t.id)}" data-meeting="${h(meetingId)}" ${t.done ? "checked" : ""}>
    <div class="grow"><h3>${h(t.title)}</h3>
      <div class="row wrap small" style="gap:6px;margin-top:4px">
        <span class="chip">${h(t.owner)}</span>
        <span class="chip ${t.overdue ? "risk" : ""}">${h(fmtDay(t.start_date))} ← ${h(fmtDay(t.due_date))}</span>
        ${pl ? `<span class="chip ${pc}">${pl}</span>` : ""}${t.assumed ? '<span class="chip q">مقترح — أكّده</span>' : ""}${extra}
      </div>
      ${t.deliverable ? `<p class="small muted" style="margin-top:4px">المُخرَج: ${h(t.deliverable)}</p>` : ""}
    </div></label>`;
}
async function toggleTask(box) {
  try {
    await api(`/api/meetings/${box.dataset.meeting}/task`, { method: "POST", body: { taskId: box.dataset.task, done: box.checked } });
    box.closest(".task").classList.toggle("done", box.checked);
  } catch (err) {
    box.checked = !box.checked;
    toast(err.message);
  }
}
function ganttHtml(tasks) {
  const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5;
  const valid = tasks.filter((t) => !isNaN(day(t.start_date)) && !isNaN(day(t.due_date)));
  if (!valid.length) return '<p class="muted small">مفيش تواريخ.</p>';
  const min = Math.min(...valid.map((t) => day(t.start_date)));
  const span = Math.max(1, Math.max(...valid.map((t) => day(t.due_date))) - min + 1);
  const iso = (d) => new Date(d * 864e5).toISOString().slice(0, 10);
  return `<div class="gantt">${valid.map((t) => {
    const from = ((day(t.start_date) - min) / span) * 100;
    const width = ((Math.max(day(t.due_date), day(t.start_date)) - day(t.start_date) + 1) / span) * 100;
    return `<div class="g" title="${h(t.title)}"><span class="num muted">${h(t.id)}</span><div class="track"><div class="bar ${t.done ? "done" : t.priority === "high" ? "high" : ""}" style="inset-inline-start:${from}%;width:${width}%"></div></div></div>`;
  }).join("")}<div class="axis"><span>${fmtDay(iso(min))}</span><span>${fmtDay(iso(min + span - 1))}</span></div></div>`;
}

// ───────────── follow-up ─────────────
const chat = [];
async function followView() {
  const { tasks } = await api("/api/followup");
  const late = tasks.filter((t) => t.overdue);
  const open = tasks.filter((t) => !t.done && !t.overdue);
  const done = tasks.filter((t) => t.done);
  const group = (list) => list.map((t) => taskHtml(t, t.meetingId, `<a class="chip" href="#/m/${h(t.meetingId)}">${h(t.meetingTitle)}</a>`)).join("");
  app.innerHTML = `
    <div class="brand"><b>المتابعة</b></div>${liveBar()}
    <div class="stats">
      <div class="card"><b class="num" style="color:var(--risk)">${late.length}</b><span class="small muted">متأخر</span></div>
      <div class="card"><b class="num">${open.length}</b><span class="small muted">مفتوح</span></div>
      <div class="card"><b class="num" style="color:var(--ok)">${done.length}</b><span class="small muted">تم</span></div>
    </div>
    ${late.length ? `<h2>متأخر</h2><div class="card">${group(late)}</div>` : ""}
    ${open.length ? `<h2>الجاي</h2><div class="card">${group(open)}</div>` : ""}
    ${!tasks.length ? '<p class="empty">أول ما تقفل اجتماع، مهامه وأهدافه هتظهر هنا وClaude هيتابعها معاك.</p>' : ""}
    ${done.length ? `<h2>تم</h2><div class="card"><details class="fold"><summary>عرض <span class="num">${done.length}</span> مهمة منتهية</summary><div class="body">${group(done)}</div></details></div>` : ""}
    <h2>اسأل Claude عن التنفيذ</h2>
    <div class="stack" id="chat"></div>
    <form class="row" id="ask" style="margin-top:10px">
      <input name="q" placeholder="مثال: إيه اللي متأخر ومين أكلمه النهارده؟" maxlength="2000" autocomplete="off">
      <button class="icon-btn" style="background:var(--accent);color:var(--on-accent)" aria-label="إرسال">${ICON.send}</button>
    </form>
    ${nav("follow")}`;
  const paint = (busy) => ($("#chat").innerHTML = chat.map((m) => `<div class="msg ${m.role}">${h(m.content)}</div>`).join("") + (busy ? '<div class="msg assistant muted">Claude بيراجع السجل…</div>' : ""));
  paint();
  app.onchange = (e) => e.target.matches("[data-task]") && toggleTask(e.target).then(followView);
  $("#ask").onsubmit = async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    e.target.q.value = "";
    chat.push({ role: "user", content: q });
    paint(true);
    try {
      const r = await api("/api/followup/chat", { method: "POST", body: { messages: chat } });
      chat.push({ role: "assistant", content: r.reply });
    } catch (err) {
      chat.pop();
      toast(err.message);
    }
    if ($("#chat")) paint();
  };
}

// ───────────── settings ─────────────
async function settingsView() {
  info = await api("/api/state");
  const g = info.google;
  const line = (ok, label, hint) => `<div class="row between" style="padding:8px 0"><div><b>${label}</b><p class="small muted">${hint}</p></div><span class="chip ${ok ? "ok" : "risk"}">${ok ? "شغّال" : "تجريبي"}</span></div>`;
  app.innerHTML = `
    <div class="brand"><b>الإعدادات</b></div>${liveBar()}
    <h2>المحركات</h2>
    <div class="card">
      ${line(!info.demo.claude, "Claude", "التحليل الحي، المخرجات، والمتابعة — ANTHROPIC_API_KEY")}
      ${line(!info.demo.stt, "التفريغ الصوتي", "عربي لحظي + فصل المتحدثين — SONIOX_API_KEY")}
    </div>
    <h2>Google</h2>
    <div class="card stack">
      ${g.connected
        ? `<p>مربوط بحساب <b dir="ltr">${h(g.email)}</b></p><p class="small muted">الصلاحيات: إنشاء شيتات ومستندات (ملفات التطبيق فقط)، إرسال إيميلات بموافقتك، وإضافة مواعيد على التقويم. مفيش قراءة للإيميل أو لملفاتك.</p><button class="btn ghost sm" id="gout">فصل الحساب</button>`
        : g.configured
          ? `<p class="small muted">اربط حسابك عشان Claude يعمل شيت المهام والمحضر ويجهّز الإيميلات.</p><a class="btn" href="/auth/google">ربط حساب Google</a>`
          : `<p class="small muted">ضيف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في إعدادات السيرفر (الخطوات في README).</p>`}
    </div>
    <h2>نصايح للتسجيل</h2>
    <div class="card"><ul class="plain">
      <li>حط الموبايل في نص الترابيزة والميكروفون ناحية الحاضرين.</li>
      <li>سيب الشاشة مفتوحة — التطبيق بيمنعها تنام. لو قفلت الشاشة التسجيل بيقف.</li>
      <li>ضيف التطبيق للشاشة الرئيسية (مشاركة ← إضافة إلى الشاشة الرئيسية).</li>
      <li>لو اسم حد طلع غلط، دوس عليه وصحّحه — Claude بيلتزم بتصحيحك.</li>
    </ul></div>
    ${nav("settings")}`;
  if ($("#gout")) $("#gout").onclick = async () => {
    await api("/api/google/disconnect", { method: "POST" });
    settingsView();
  };
}

// ───────────── router ─────────────
async function router() {
  clearTimeout(pollTimer);
  app.onclick = app.onchange = app.onsubmit = null;
  try {
    info ??= await api("/api/state");
    const [, view, id] = location.hash.split("/");
    scrollTo(0, 0);
    if (view === "live" && id) await liveView(id);
    else if (view === "m" && id) await meetingView(id);
    else if (view === "follow") await followView();
    else if (view === "settings") await settingsView();
    else await homeView();
  } catch (err) {
    if (!$("#f")) toast(err.message);
  }
}
addEventListener("hashchange", router);
addEventListener("beforeunload", (e) => live && e.preventDefault());
router();
navigator.serviceWorker?.register("/sw.js").catch(() => {});
