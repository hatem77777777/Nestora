// Microphone capture, on-device audio backup, and the live speech-to-text stream.

// ───────────── on-device audio backup (IndexedDB) ─────────────
const dbp = new Promise((resolve, reject) => {
  const r = indexedDB.open("majlis", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("audio", { autoIncrement: true }).createIndex("m", "m");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const tx = async (mode) => (await dbp).transaction("audio", mode).objectStore("audio");

export async function saveAudioChunk(m, blob) {
  (await tx("readwrite")).add({ m, blob, type: blob.type });
}
export async function loadAudio(m) {
  const store = await tx("readonly");
  const rows = await new Promise((res, rej) => {
    const r = store.index("m").getAll(m);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return rows.length ? new Blob(rows.map((x) => x.blob), { type: rows[0].type }) : null;
}
export async function deleteAudio(m) {
  const store = await tx("readwrite");
  store.index("m").openKeyCursor(IDBKeyRange.only(m)).onsuccess = (e) => {
    const c = e.target.result;
    if (c) (store.delete(c.primaryKey), c.continue());
  };
}

// ───────────── microphone ─────────────
export class Capture {
  constructor({ meetingId, onPcm, onLevel }) {
    Object.assign(this, { meetingId, onPcm, onLevel });
  }
  /** Must be called from a tap handler (iOS requires a user gesture for mic + audio context). */
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Room recording: keep far voices — phone-call filters would suppress them.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm");
    this.node.port.onmessage = (e) => {
      this.onPcm?.(e.data.pcm);
      this.onLevel?.(e.data.rms);
    };
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node).connect(mute).connect(this.ctx.destination);
    await this.ctx.resume();

    // Local backup so the meeting can always be replayed (saved every 5 s → crash-safe).
    if (window.MediaRecorder) {
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
      this.rec = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
      this.rec.ondataavailable = (e) => e.data.size && saveAudioChunk(this.meetingId, e.data).catch(() => {});
      this.rec.start(5000);
    }
    this.stream.getAudioTracks()[0].onended = () => this.onLost?.();
    await this.lockScreen();
    this._vis = () => document.visibilityState === "visible" && this.lockScreen();
    document.addEventListener("visibilitychange", this._vis);
  }
  async lockScreen() {
    try {
      this.wake = await navigator.wakeLock?.request("screen");
    } catch {}
  }
  async pause() {
    await this.ctx?.suspend();
    if (this.rec?.state === "recording") this.rec.pause();
  }
  async resume() {
    await this.ctx?.resume();
    if (this.rec?.state === "paused") this.rec.resume();
  }
  async stop() {
    document.removeEventListener("visibilitychange", this._vis);
    if (this.rec && this.rec.state !== "inactive") {
      await new Promise((r) => {
        this.rec.onstop = r;
        this.rec.stop();
      });
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.wake?.release().catch(() => {});
  }
}

// ───────────── live speech-to-text (Soniox real-time WebSocket) ─────────────
const SONIOX_WS = "wss://stt-rt.soniox.com/transcribe-websocket";

export class SttStream {
  /**
   * onFinal({ sp, text, end }) — finalized words for one speaker; `end` marks end of utterance.
   * Speaker ids are prefixed with a letter per connection (A1, A2 … then B1 after a reconnect),
   * because the engine restarts its speaker numbering on every new connection.
   */
  constructor({ getToken, terms, onFinal, onInterim, onState }) {
    Object.assign(this, { getToken, terms, onFinal, onInterim, onState });
    this.queue = [];
    this.session = 0;
    this.retry = 0;
  }
  async connect() {
    if (this.stopped) return;
    this.onState?.("connecting");
    let token;
    try {
      token = await this.getToken();
    } catch {
      return this.scheduleReconnect();
    }
    const letter = String.fromCharCode(65 + (this.session++ % 26));
    const ws = (this.ws = new WebSocket(SONIOX_WS));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          api_key: token.apiKey,
          model: token.model,
          audio_format: "s16le",
          sample_rate: 16000,
          num_channels: 1,
          language_hints: ["ar", "en"],
          enable_speaker_diarization: true,
          enable_language_identification: true,
          enable_endpoint_detection: true,
          ...(this.terms?.length ? { context: { terms: this.terms.slice(0, 100) } } : {}),
        }),
      );
      for (const b of this.queue.splice(0)) ws.send(b);
      this.retry = 0;
      this.onState?.("live");
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.error_code) {
        console.warn("stt error", msg.error_code, msg.error_message);
        return ws.close();
      }
      let interim = "";
      for (const t of msg.tokens || []) {
        if (!t.is_final) interim += t.text;
        else if (t.text === "<end>") this.onFinal?.({ end: true });
        else this.onFinal?.({ sp: `${letter}${t.speaker || "1"}`, text: t.text });
      }
      this.onInterim?.(interim.replace("<end>", ""));
      if (msg.finished) this.finished?.();
    };
    ws.onclose = () => {
      if (this.ws === ws && !this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }
  scheduleReconnect() {
    if (this.stopped) return;
    this.onState?.("reconnecting");
    setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 15000));
  }
  send(pcm) {
    if (this.ws?.readyState === 1) this.ws.send(pcm);
    else if (this.queue.push(pcm) > 600) this.queue.shift(); // keep the last 60 s while offline
  }
  keepAlive() {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: "keepalive" }));
  }
  /** Flush remaining words, then close. */
  async stop() {
    this.stopped = true;
    if (this.ws?.readyState === 1) {
      await new Promise((r) => {
        this.finished = r;
        this.ws.send("");
        setTimeout(r, 4000);
      });
    }
    this.ws?.close();
  }
}

/** Demo mode: plays a scripted meeting instead of listening to the mic. */
export class DemoStt {
  constructor({ script, onFinal, onState }) {
    Object.assign(this, { script, onFinal, onState });
  }
  connect() {
    this.onState?.("live");
    let i = 0;
    this.timer = setInterval(() => {
      if (this.paused) return;
      const s = this.script[i++];
      if (!s) return clearInterval(this.timer);
      this.onFinal({ sp: s.sp, text: s.text });
      this.onFinal({ end: true });
    }, 1800);
  }
  send() {}
  keepAlive() {}
  async stop() {
    clearInterval(this.timer);
  }
}
