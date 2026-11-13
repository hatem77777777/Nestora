// Downsamples the mic to 16 kHz mono 16-bit PCM and posts ~100 ms frames.
// Raw PCM (instead of MediaRecorder containers) behaves identically on iOS and Android.
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.energy = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.count++;
      this.pos++;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.energy += v * v;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.out.length) {
          const pcm = this.out.buffer.slice(0);
          this.port.postMessage({ pcm, rms: Math.sqrt(this.energy / this.n) }, [pcm]);
          this.n = 0;
          this.energy = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm", PcmProcessor);
