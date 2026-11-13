// Claude integration: live analysis ticks, post-meeting deliverables, follow-up chat.
import Anthropic from "@anthropic-ai/sdk";
import { LIVE_SYSTEM, LIVE_SCHEMA, FINAL_SYSTEM, FINAL_SCHEMA, FOLLOWUP_SYSTEM } from "./prompts.js";
import { demoLive, demoFinal } from "./demo.js";
import { get } from "./settings.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const TZ = process.env.TIMEZONE || "Africa/Cairo";
export const isDemo = () => !get("ANTHROPIC_API_KEY");

// The key can change from the Settings screen, so the client is rebuilt when it does.
let client = null;
let clientKey = "";
function api() {
  const key = get("ANTHROPIC_API_KEY");
  if (key !== clientKey) {
    client = new Anthropic({ apiKey: key });
    clientKey = key;
  }
  return client;
}

/** Cheap check that a key works (reading model info is not billed). */
export async function verifyKey() {
  try {
    await api().models.retrieve(MODEL);
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "مفتاح Claude غير صحيح." };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "المفتاح مالوش صلاحية على الموديل — راجع الرصيد أو الخطة." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Claude رد بخطأ ${err.status ?? ""}: ${err.message}` };
    return { ok: false, error: "تعذّر الاتصال بـ Claude." };
  }
}

// If a safety classifier declines a request, the API re-runs it on a fallback model
// inside the same call. Turned off automatically if the account rejects the parameter.
let useFallbacks = true;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ClaudeError extends Error {}

async function run(params) {
  const attempt = () =>
    useFallbacks
      ? api().beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" }).finalMessage()
      : api().messages.stream(params).finalMessage();
  let msg;
  try {
    msg = await attempt();
  } catch (err) {
    if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
      console.warn("[claude] fallbacks rejected, continuing without them:", err.message);
      useFallbacks = false;
      msg = await attempt();
    } else if (err instanceof Anthropic.AuthenticationError) {
      throw new ClaudeError("مفتاح Claude غير صحيح (ANTHROPIC_API_KEY).");
    } else if (err instanceof Anthropic.RateLimitError) {
      throw new ClaudeError("Claude وصل لحد الطلبات مؤقتًا — هيتعاد تلقائيًا.");
    } else if (err instanceof Anthropic.APIError) {
      throw new ClaudeError(`خطأ من Claude (${err.status ?? "network"}): ${err.message}`);
    } else {
      throw err;
    }
  }
  if (msg.stop_reason === "refusal") throw new ClaudeError("Claude رفض تحليل الجزء ده.");
  if (msg.stop_reason === "max_tokens") throw new ClaudeError("الرد اتقطع قبل ما يكمل.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function runJSON(params, schema) {
  const text = await run({
    ...params,
    output_config: { ...params.output_config, format: { type: "json_schema", schema } },
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError("رد Claude ما كانش JSON صالح.");
  }
}

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "full" }).format(new Date()) +
  " (" + new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()) + ")";

const speakerLine = (m) =>
  Object.entries(m.speakers).map(([id, s]) => ({ id, name: s.name, role: s.role, locked: !!s.locked }));

function contextBlock(m, carryOver) {
  const owner = get("OWNER_NAME")
    ? `المستخدم (صاحب التطبيق): ${get("OWNER_NAME")}${get("OWNER_ROLE") ? ` — ${get("OWNER_ROLE")}` : ""}`
    : "";
  return [
    `# سياق الاجتماع`,
    `العنوان: ${m.title || "غير محدد"}`,
    `التاريخ: ${new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(m.createdAt))}`,
    owner,
    m.context ? `ملاحظات/أجندة من المستخدم:\n${m.context}` : "",
    carryOver ? `# معلّق من اجتماعات سابقة (للربط فقط)\n${carryOver}` : "",
    `\n# النص المفرّغ (بيتبعت على دفعات)`,
  ].filter(Boolean).join("\n");
}

/**
 * One live analysis pass. The transcript is sent as append-only blocks with a cache
 * breakpoint on the newest one, so every pass re-reads the earlier transcript from cache
 * and only pays full price for the new chunk + the small volatile board state.
 */
export async function liveTick(m, { question, carryOver }) {
  if (isDemo()) return demoLive(m, question);

  const content = [{ type: "text", text: contextBlock(m, carryOver) }];
  m.chunks.forEach((text, i) => {
    const block = { type: "text", text };
    if (i === m.chunks.length - 1) block.cache_control = { type: "ephemeral" };
    content.push(block);
  });
  const board = {
    speakers: speakerLine(m),
    topics: m.board.topics,
    recent_insights: m.board.insights.slice(-12).map((i) => i.text),
    decisions: m.board.decisions.map((d) => d.text),
    actions: m.board.actions.map((a) => `${a.owner || "?"}: ${a.text}`),
  };
  content.push({
    type: "text",
    text:
      `# حالة اللوحة الحالية (JSON)\n${JSON.stringify(board)}\n\n` +
      (question ? `# سؤال مباشر من المستخدم\n${question}\n\n` : "") +
      `حلّل آخر دفعة من النص (آخر بلوك) في ضوء كل اللي فات، ورجّع التحديثات فقط.`,
  });

  return runJSON(
    {
      model: MODEL,
      max_tokens: 8000,
      system: LIVE_SYSTEM,
      output_config: { effort: "low" },
      messages: [{ role: "user", content }],
    },
    LIVE_SCHEMA,
  );
}

export function transcriptText(m) {
  const name = (sp) => m.speakers[sp]?.name || sp;
  const ts = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return m.segments.map((s) => `[${ts(s.t)}] ${name(s.sp)}: ${s.text}`).join("\n");
}

export async function finalize(m, { carryOver, roster }) {
  if (isDemo()) return demoFinal();
  const speakers = Object.entries(m.speakers)
    .map(([id, s]) => `${id} = ${s.name || "غير معروف"}${s.role ? ` (${s.role})` : ""}`)
    .join("\n");
  const prompt = [
    `تاريخ النهارده: ${today()} — المنطقة الزمنية ${TZ}`,
    contextBlock(m, carryOver).replace("\n# النص المفرّغ (بيتبعت على دفعات)", ""),
    `# الحاضرون\n${speakers || "غير محددين"}`,
    roster?.length ? `# جهات اتصال معروفة\n${roster.map((r) => `${r.name}${r.role ? ` — ${r.role}` : ""}`).join("\n")}` : "",
    `# لوحة التحليل الحيّة\n${JSON.stringify(m.board)}`,
    `# النص الكامل\n${transcriptText(m)}`,
  ].filter(Boolean).join("\n\n");

  return runJSON(
    {
      model: MODEL,
      max_tokens: 32000,
      system: FINAL_SYSTEM,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: prompt }],
    },
    FINAL_SCHEMA,
  );
}

/** Compact record of every finished meeting — the memory Claude follows up from. */
export function memoryDigest(meetings) {
  const date = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
  return meetings
    .filter((m) => m.final)
    .map((m) => {
      const f = m.final;
      const tasks = f.tasks
        .map((t) => `  - [${t.done ? "تم" : "مفتوح"}] ${t.id} ${t.title} | ${t.owner} | ${t.start_date}→${t.due_date} | ${t.priority}${t.depends_on?.length ? ` | بعد ${t.depends_on.join(",")}` : ""}`)
        .join("\n");
      const goals = f.topics.map((t) => `  - ${t.title}: ${t.goal} (KPI: ${t.kpi})`).join("\n");
      return `## ${f.title || m.title} — ${date(m.createdAt)}\n${f.summary}\nالأهداف:\n${goals}\nالمهام:\n${tasks}\nأسئلة معلّقة: ${f.open_questions.join(" | ") || "لا يوجد"}`;
    })
    .join("\n\n");
}

export async function followupChat(meetings, messages) {
  if (isDemo()) return "(وضع تجريبي) لما تضيف مفتاح Claude هتابع معاك هنا أهداف ومهام كل اجتماع.";
  const memory = memoryDigest(meetings) || "لا توجد اجتماعات منتهية بعد.";
  return run({
    model: MODEL,
    max_tokens: 8000,
    system: [
      { type: "text", text: FOLLOWUP_SYSTEM },
      { type: "text", text: `تاريخ النهارده: ${today()}\n\n# سجل الاجتماعات\n${memory}`, cache_control: { type: "ephemeral" } },
    ],
    output_config: { effort: "medium" },
    messages: messages.map((x) => ({ role: x.role === "assistant" ? "assistant" : "user", content: String(x.content) })),
  });
}
