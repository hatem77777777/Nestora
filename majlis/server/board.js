// Merges Claude's incremental answers into the meeting board.
import crypto from "node:crypto";

const uid = () => crypto.randomBytes(4).toString("hex");
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

export function applyDelta(m, d, t) {
  const added = { insights: 0, decisions: 0, actions: 0 };

  for (const s of d.speakers || []) {
    if (!s.id || !m.segments.some((x) => x.sp === s.id)) continue; // ignore invented ids
    const cur = m.speakers[s.id];
    if (cur?.locked) continue; // confirmed by the user — Claude can't overwrite
    if (s.confidence === "low" && cur?.name) continue; // don't downgrade a confident name
    m.speakers[s.id] = { name: norm(s.name), role: norm(s.role), confidence: s.confidence, evidence: norm(s.evidence) };
  }

  for (const tpc of d.topics || []) {
    if (!tpc.id || !norm(tpc.title)) continue;
    const i = m.board.topics.findIndex((x) => x.id === tpc.id);
    if (i >= 0) m.board.topics[i] = tpc;
    else m.board.topics.push(tpc);
  }

  const seen = new Set(m.board.insights.map((i) => norm(i.text)));
  for (const ins of d.insights || []) {
    const text = norm(ins.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    m.board.insights.push({ ...ins, text, id: uid(), t });
    added.insights++;
  }

  const dec = new Set(m.board.decisions.map((x) => norm(x.text)));
  for (const x of d.decisions || []) {
    const text = norm(x.text);
    if (!text || dec.has(text)) continue;
    dec.add(text);
    m.board.decisions.push({ ...x, text, t });
    added.decisions++;
  }

  const act = new Set(m.board.actions.map((x) => norm(x.text)));
  for (const x of d.actions || []) {
    const text = norm(x.text);
    if (!text || act.has(text)) continue;
    act.add(text);
    m.board.actions.push({ ...x, text, t });
    added.actions++;
  }
  return added;
}

/** What is still open from earlier meetings — gives Claude memory across meetings. */
export function carryOver(meetings, excludeId) {
  const lines = [];
  for (const m of meetings) {
    if (m.id === excludeId || !m.final) continue;
    const open = m.final.tasks.filter((t) => !t.done);
    if (!open.length && !m.final.open_questions.length) continue;
    lines.push(`- ${m.final.title || m.title}:`);
    for (const t of open.slice(0, 8)) lines.push(`  · مهمة مفتوحة: ${t.title} (${t.owner}، ${t.due_date})`);
    for (const q of m.final.open_questions.slice(0, 4)) lines.push(`  · سؤال معلّق: ${q}`);
    if (lines.length > 40) break;
  }
  return lines.join("\n");
}

export function openTasks(meetings, todayIso) {
  const out = [];
  for (const m of meetings) {
    if (!m.final) continue;
    for (const t of m.final.tasks) {
      out.push({
        ...t,
        meetingId: m.id,
        meetingTitle: m.final.title || m.title,
        overdue: !t.done && t.due_date < todayIso,
      });
    }
  }
  return out.sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.due_date.localeCompare(b.due_date));
}
