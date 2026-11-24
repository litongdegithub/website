// Pitch detector: McLeod Pitch Method (normalised square difference function).
// The same file runs as an AudioWorklet in the browser and is loaded by the node tests
// (test/mpm.test.mjs), so `mpm` has no dependencies.

/**
 * @param {Float32Array} buf  samples, length >= W + maxTau + 2
 * @param {number} sr         sample rate
 * @param {number} W          window length
 * @returns {{hz:number, clarity:number}}  hz = 0 when no clear pitch
 */
function mpm(buf, sr, W, minHz = 65, maxHz = 1100) {
  const minTau = Math.max(2, Math.floor(sr / maxHz));
  const maxTau = Math.min(buf.length - W - 2, Math.ceil(sr / minHz));
  const nsdf = new Float32Array(maxTau + 2);
  let e0 = 0;
  for (let j = 0; j < W; j++) e0 += buf[j] * buf[j];
  let et = e0; // energy of buf[tau .. tau+W)
  for (let tau = 0; tau <= maxTau + 1; tau++) {
    if (tau > 0) et += buf[tau + W - 1] * buf[tau + W - 1] - buf[tau - 1] * buf[tau - 1];
    let r = 0;
    for (let j = 0; j < W; j++) r += buf[j] * buf[j + tau];
    const m = e0 + et;
    nsdf[tau] = m > 1e-12 ? (2 * r) / m : 0;
  }
  // skip the lobe around lag 0, then take the highest point of every positive lobe
  let tau = 1;
  while (tau <= maxTau && nsdf[tau] > 0) tau++;
  const peaks = [];
  let best = -1, bestIdx = -1, inLobe = false;
  for (; tau <= maxTau; tau++) {
    if (nsdf[tau] > 0) {
      inLobe = true;
      if (nsdf[tau] > best) { best = nsdf[tau]; bestIdx = tau; }
    } else if (inLobe) {
      peaks.push(bestIdx); inLobe = false; best = -1;
    }
  }
  if (inLobe && bestIdx > 0) peaks.push(bestIdx);
  if (!peaks.length) return { hz: 0, clarity: 0 };
  let top = 0;
  for (const p of peaks) top = Math.max(top, nsdf[p]);
  const pick = peaks.find((p) => p >= minTau && nsdf[p] >= 0.88 * top);
  if (!pick) return { hz: 0, clarity: 0 };
  const a = nsdf[pick - 1], b = nsdf[pick], c = nsdf[pick + 1];
  const den = a - 2 * b + c;
  const shift = Math.abs(den) > 1e-12 ? (a - c) / (2 * den) : 0;
  const clarity = b - ((a - c) * shift) / 4;
  return { hz: sr / (pick + shift), clarity: Math.min(1, clarity) };
}

if (typeof registerProcessor === 'function') {
  class PitchDetector extends AudioWorkletProcessor {
    constructor() {
      super();
      this.W = 1024;
      this.N = 2048;
      this.hop = 1024; // ~47 results a second at 48 kHz
      this.buf = new Float32Array(this.N);
      this.filled = 0;
      this.since = 0;
    }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (!ch) return true;
      const n = ch.length;
      this.buf.copyWithin(0, n);
      this.buf.set(ch, this.N - n);
      this.filled = Math.min(this.N, this.filled + n);
      this.since += n;
      if (this.since >= this.hop && this.filled === this.N) {
        this.since = 0;
        let s = 0;
        for (let i = this.N - this.W; i < this.N; i++) s += this.buf[i] * this.buf[i];
        const rms = Math.sqrt(s / this.W);
        const r = rms > 0.003 ? mpm(this.buf, sampleRate, this.W) : { hz: 0, clarity: 0 };
        // t = end of the analysed audio, on the AudioContext clock
        this.port.postMessage({ t: currentTime + n / sampleRate, hz: r.hz, clarity: r.clarity, rms });
      }
      return true;
    }
  }
  registerProcessor('pitch-detector', PitchDetector);
}
