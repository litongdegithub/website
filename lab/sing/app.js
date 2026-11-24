'use strict';
// Singing prototype: measures how well the phone hears a singer.
// Audio → AudioWorklet (pitch-worklet.js, McLeod pitch method, ~47 results/s) → frames on the AudioContext clock.
// "Simulated singer" mode feeds a synthetic voice straight into the detector, so everything can be checked without a mic.

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sg_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sg_' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ notes
const NAMES = {
  solfa: ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'],
  en: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  de: ['C', 'Cis', 'D', 'Dis', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'B', 'H'], // German: B = B flat, H = B natural
};
let naming = store.get('naming', 'solfa');
const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
const hzOf = (m) => 440 * 2 ** ((m - 69) / 12);
const noteName = (m) => { const r = Math.round(m); return NAMES[naming][((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const VOICED = 0.8; // clarity needed to count a frame as sung

// ------------------------------------------------------------------ in-app browsers + errors
const UA = navigator.userAgent;
const IN_APP = /MicroMessenger|WeChat|QQ\/|Weibo|FBAN|FBAV|Instagram|Line\/|TikTok|musical_ly|Bytedance|aweme/i.test(UA);
const errText = (e) => String((e && (e.name ? e.name + ': ' : '') + (e.message || '')) || e).slice(0, 200);
function errBox(e) {
  const msg = errText(e), mic = /NotAllowed|Permission|NotFound|getUserMedia|undefined is not an object|mediaDevices/i.test(msg);
  return '<p class="badc" style="margin-top:10px">出错了：' + msg.replace(/</g, '&lt;') + '</p><p class="muted">' +
    (IN_APP ? '你是在微信等 App 里打开的，它们常常不让网页用麦克风。请点右上角「···」，选「在 Safari 中打开」，再测一次。' :
      mic ? '麦克风没有打开。请在系统设置里允许浏览器使用麦克风，或者用 Safari 打开。' : '请把这段文字截图发给我。') + '</p>';
}

// ------------------------------------------------------------------ results log
const log = store.get('log', []);
function record(kind, data) { log.push({ kind, at: new Date().toISOString(), source: A.source, ...data }); store.set('log', log.slice(-60)); }

// ------------------------------------------------------------------ audio
const ENGINE = new URLSearchParams(location.search).get('engine') === 'analyser' ? 'analyser' : 'worklet';
const MAX_LAG = 2.0; // longest delay the self-test looks for (seconds)
const A = { states: [], ctx: null, node: null, input: null, master: null, mic: null, micSrc: null, source: 'mic', frames: [], subs: new Set() };
async function ensureAudio() {
  if (!A.ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    A.ctx = new C({ latencyHint: 'interactive' });
    A.input = A.ctx.createGain();
    const push = (f) => { A.frames.push(f); if (A.frames.length > 8000) A.frames.splice(0, 2000); A.subs.forEach((fn) => fn(f)); };
    if (ENGINE === 'worklet') {
      await A.ctx.audioWorklet.addModule('pitch-worklet.js?v=5');
      A.node = new AudioWorkletNode(A.ctx, 'pitch-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const sink = A.ctx.createGain(); sink.gain.value = 0; A.node.connect(sink).connect(A.ctx.destination);
      A.input.connect(A.node);
      A.node.port.onmessage = (e) => push(e.data);
    } else {
      // no AudioWorklet at all (WebKit has bugs with worklets plus the mic): read the newest 2048 samples ~47 times a second
      const an = A.ctx.createAnalyser(); an.fftSize = 2048; A.input.connect(an);
      const sink = A.ctx.createGain(); sink.gain.value = 0; an.connect(sink).connect(A.ctx.destination);
      const buf = new Float32Array(2048), W = 1024;
      setInterval(() => {
        if (A.ctx.state !== 'running') return;
        an.getFloatTimeDomainData(buf);
        let q = 0; for (let i = 2048 - W; i < 2048; i++) q += buf[i] * buf[i];
        const rms = Math.sqrt(q / W);
        const r = rms > 0.003 ? mpm(buf, A.ctx.sampleRate, W) : { hz: 0, clarity: 0 };
        push({ t: A.ctx.currentTime, hz: r.hz, clarity: r.clarity, rms });
      }, 21);
    }
    A.bg = A.ctx.createGain(); A.bg.connect(A.input); // background singer (sim mode), muted while a test runs
    A.master = A.ctx.createGain(); A.master.gain.value = 0.9; A.master.connect(A.ctx.destination);
  }
  if (A.ctx.state !== 'running') await A.ctx.resume();
  if (!A.watch) { // iOS may suspend or interrupt the context (mic start, calls, other apps): note it and resume on the next tap
    A.watch = true;
    A.ctx.onstatechange = () => { A.states.push(A.ctx.state + '@' + A.ctx.currentTime.toFixed(1)); showDevice(); };
    document.addEventListener('pointerdown', () => { if (A.ctx.state !== 'running') A.ctx.resume().catch(() => {}); }, true);
  }
}
async function setSource(s) {
  A.source = s; $('#source').value = s;
  if (A.micSrc) { try { A.micSrc.disconnect(); } catch { /* not connected */ } }
  await ensureAudio();
  if (s === 'mic') {
    if (!A.mic) {
      A.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      A.micSrc = A.ctx.createMediaStreamSource(A.mic);
    }
    A.micSrc.connect(A.input);
    if (A.ctx.state !== 'running') { try { await A.ctx.resume(); } catch { /* resumed on next tap */ } }
  }
  sim.restart();
  showDevice();
}
async function waitUntil(end) {
  const c = A.ctx; let lastT = c.currentTime, lastWall = Date.now(), n0 = A.frames.length;
  while (c.currentTime < end) {
    await sleep(100);
    if (c.currentTime !== lastT) { lastT = c.currentTime; lastWall = Date.now(); }
    else if (Date.now() - lastWall > 2500) throw new Error('音频时钟停住了（状态 ' + c.state + '）。请点一下屏幕再试，或者重新打开页面。');
  }
  if (A.frames.length === n0) throw new Error('识别器没有收到任何声音数据（AudioWorklet 没在运行）。');
}
function framesSince(t) { const out = []; for (let i = A.frames.length - 1; i >= 0 && A.frames[i].t >= t; i--) out.push(A.frames[i]); return out.reverse(); }

// piano-ish reference tone
function tone(dest, hz, t0, dur, vol = 0.32) {
  const c = A.ctx, g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(vol * 0.45, t0 + 0.3);
  g.gain.setValueAtTime(vol * 0.45, Math.max(t0 + 0.3, t0 + dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  for (const [k, type, a] of [[1, 'triangle', 1], [2, 'sine', 0.3], [3, 'sine', 0.12]]) {
    const o = c.createOscillator(), og = c.createGain();
    o.type = type; o.frequency.value = hz * k; og.gain.value = a;
    o.connect(og).connect(g); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  g.connect(dest);
}
function pad(dest, midis, t0, dur, vol = 0.07) {
  const c = A.ctx, g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.4);
  g.gain.setValueAtTime(vol, t0 + dur - 0.5); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  for (const m of midis) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hzOf(m); const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; o.connect(lp).connect(g); o.start(t0); o.stop(t0 + dur + 0.05); }
  g.connect(dest);
}

// synthetic singer: sawtooth + vowel-ish filter + vibrato + small random detuning, sung straight into the detector
function singer(notes, { err = 18, vibrato = 22, dest = null } = {}) {
  const c = A.ctx, o = c.createOscillator(), f1 = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
  o.type = 'sawtooth'; f1.type = 'lowpass'; f1.frequency.value = 2400; g.gain.value = 0;
  lfo.frequency.value = 5.4; lg.gain.value = vibrato; lfo.connect(lg).connect(o.detune);
  const offs = [];
  for (const n of notes) {
    const off = (Math.random() * 2 - 1) * err; offs.push(off);
    o.frequency.setTargetAtTime(n.hz * 2 ** (off / 1200), n.t0 - 0.02, 0.03); // short slide into the note, like a real singer
    g.gain.setTargetAtTime(0.22, n.t0, 0.03);
    g.gain.setTargetAtTime(0, n.t1 - 0.05, 0.025);
  }
  o.frequency.setValueAtTime(notes[0].hz, notes[0].t0 - 0.1);
  o.connect(f1).connect(g).connect(dest || A.input);
  const start = Math.max(c.currentTime, notes[0].t0 - 0.12), end = notes[notes.length - 1].t1 + 0.3;
  o.start(start); lfo.start(start); o.stop(end); lfo.stop(end);
  return offs;
}
// background singer for the tuner/range pages in sim mode: slow scale, loops
const sim = {
  timer: null,
  restart() {
    clearInterval(this.timer); this.timer = null;
    if (A.source !== 'sim') return;
    const run = () => {
      if (busy) return;
      const t0 = A.ctx.currentTime + 0.3, seq = [57, 59, 60, 62, 64, 65, 64, 62, 60, 52, 48, 45, 72, 76];
      singer(seq.map((m, i) => ({ hz: hzOf(m), t0: t0 + i * 0.9, t1: t0 + i * 0.9 + 0.75 })), { err: 25, vibrato: 25, dest: A.bg });
    };
    run(); this.timer = setInterval(run, 14 * 900);
  },
};
let busy = false; // self-test / exercise running: background singer is muted
function setBusy(on) { busy = on; if (A.bg) A.bg.gain.setTargetAtTime(on ? 0 : 1, A.ctx.currentTime, 0.01); }

// ------------------------------------------------------------------ plot
function plot(canvas, { targets = [], from, to, lo, hi, lat = 0 }) {
  const x = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  x.fillStyle = '#0c0c10'; x.fillRect(0, 0, W, H);
  const X = (t) => ((t - from) / (to - from)) * W, Y = (m) => H - ((m - lo) / (hi - lo)) * H;
  x.font = '22px -apple-system, sans-serif'; x.textBaseline = 'middle';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const isC = ((m % 12) + 12) % 12 === 0;
    x.strokeStyle = isC ? '#2e2e38' : '#1a1a21'; x.lineWidth = 1; x.beginPath(); x.moveTo(0, Y(m)); x.lineTo(W, Y(m)); x.stroke();
    if (isC || hi - lo < 16) { x.fillStyle = '#55555f'; x.fillText(noteName(m), 8, Y(m)); }
  }
  for (const n of targets) {
    if (n.t1 < from || n.t0 > to) continue;
    const band = (Y(n.m - 0.5) - Y(n.m + 0.5));
    x.fillStyle = 'rgba(255,181,71,.22)'; x.fillRect(X(n.t0), Y(n.m + 0.5), X(n.t1) - X(n.t0), band);
    x.fillStyle = 'rgba(255,181,71,.9)'; x.fillRect(X(n.t0), Y(n.m) - 2, X(n.t1) - X(n.t0), 4);
  }
  const fr = framesSince(from + lat);
  let prev = null;
  for (const f of fr) {
    const t = f.t - lat;
    if (f.hz <= 0 || f.clarity < VOICED) { prev = null; continue; }
    const m = midiOf(f.hz), tgt = targets.find((n) => t >= n.t0 && t <= n.t1);
    x.strokeStyle = x.fillStyle = !tgt ? '#cfcac0' : Math.abs(m - tgt.m) <= 0.5 ? '#5fd38d' : '#ff7a59';
    x.lineWidth = 4;
    if (prev && t - prev.t < 0.08) { x.beginPath(); x.moveTo(X(prev.t), Y(prev.m)); x.lineTo(X(t), Y(m)); x.stroke(); }
    else { x.beginPath(); x.arc(X(t), Y(m), 2.5, 0, 7); x.fill(); }
    prev = { t, m };
  }
  if (A.ctx) { const nx = X(A.ctx.currentTime); x.strokeStyle = 'rgba(255,255,255,.35)'; x.beginPath(); x.moveTo(nx, 0); x.lineTo(nx, H); x.stroke(); }
}

// ------------------------------------------------------------------ tuner
let lastShown = 0;
function onFrame(f) {
  range.feed(f);
  if (f.t - lastShown < 0.06) return; lastShown = f.t;
  if (f.hz > 0 && f.clarity >= VOICED) {
    const m = midiOf(f.hz), c = Math.round((m - Math.round(m)) * 100);
    $('#tNote').textContent = noteName(m);
    $('#tCents').textContent = (c > 0 ? '+' : '') + c + ' 音分 · ' + f.hz.toFixed(1) + ' Hz';
    const d = $('#tDot'); d.style.left = (50 + c) + '%'; d.style.background = Math.abs(c) <= 15 ? 'var(--ok)' : Math.abs(c) <= 35 ? 'var(--accent)' : 'var(--bad)';
    $('#rNow').textContent = noteName(m);
  }
  $('#tInfo').textContent = '清晰度 ' + f.clarity.toFixed(2) + ' · 音量 ' + (20 * Math.log10(f.rms + 1e-9)).toFixed(0) + ' dB';
}

// ------------------------------------------------------------------ self test
async function selfTest() {
  if (busy) return; setBusy(true); $('#selfRun').disabled = true;
  try {
    await setSource(A.source);
    const c = A.ctx, seq = [60, 62, 64, 65, 67, 69, 71, 72], dur = 0.75, gap = 0.3, t0 = c.currentTime + 0.5;
    const notes = seq.map((m, i) => ({ m, hz: hzOf(m), t0: t0 + i * (dur + gap), t1: t0 + i * (dur + gap) + dur }));
    const dest = A.source === 'mic' ? A.master : A.input;
    notes.forEach((n) => tone(dest, n.hz, n.t0, n.t1 - n.t0));
    $('#selfOut').innerHTML = '<p class="muted" style="margin-top:10px">正在播放和识别…</p>';
    const end = notes[notes.length - 1].t1 + MAX_LAG + 0.3; // keep listening long enough to catch a late signal
    await waitUntil(end);
    const cents = (f, n) => 1200 * Math.log2(f.hz / n.hz);
    const voiced = (f) => f.hz > 0 && f.clarity >= VOICED;
    // Try every delay from 0 to MAX_LAG and keep the one where the most frames match their note.
    // This separates "how late the sound arrives" from "how accurately it is heard".
    const scoreAt = (L) => notes.reduce((acc, n) => {
      const fr = A.frames.filter((f) => f.t - L >= n.t0 + 0.15 && f.t - L <= n.t1);
      return acc + (fr.length ? fr.filter((f) => voiced(f) && Math.abs(cents(f, n)) <= 50).length / fr.length : 0);
    }, 0) / notes.length;
    const tries = [];
    for (let L = 0; L <= MAX_LAG + 1e-9; L += 0.01) tries.push([L, scoreAt(L)]);
    const best = Math.max(...tries.map((x) => x[1]));
    const plateau = tries.filter((x) => x[1] >= best - 0.01).map((x) => x[0]); // many delays score the same: take the middle
    const lat = plateau[Math.floor(plateau.length / 2)];
    const rows = notes.map((n) => {
      const fr = A.frames.filter((f) => f.t - lat >= n.t0 + 0.15 && f.t - lat <= n.t1);
      const vc = fr.filter(voiced).map((f) => cents(f, n));
      const inTune = vc.filter((x) => Math.abs(x) <= 50);
      const med = inTune.length ? [...inTune].sort((a, b) => a - b)[Math.floor(inTune.length / 2)] : NaN;
      return { note: noteName(n.m), frames: fr.length, rate: fr.length ? inTune.length / fr.length : 0, cents: med, octave: vc.filter((x) => Math.abs(x) > 600).length };
    });
    const ok = rows.filter((r) => Number.isFinite(r.cents));
    const rate = rows.reduce((a, r) => a + r.rate, 0) / rows.length;
    const err = ok.length ? ok.reduce((a, r) => a + Math.abs(r.cents), 0) / ok.length : NaN;
    const raw = Math.round(scoreAt(0) * 100);
    if (rate > 0.3) store.set('latency_' + A.source + '_' + ENGINE, lat);
    const score = Math.round(rate * 100);
    $('#selfOut').innerHTML = `
      <div class="summary">得分 <b class="${score >= 90 ? 'good' : score >= 70 ? 'warn' : 'badc'}">${score}</b> / 100
        · 平均误差 ${Number.isFinite(err) ? err.toFixed(1) : '–'} 音分 · 延迟 <b>${Math.round(lat * 1000)}</b> 毫秒</div>
      <p class="muted">得分 = 按测出的延迟对齐后，识别成功且在 ±50 音分内的比例。不对齐时的得分是 ${raw}。识别方式：${ENGINE === 'worklet' ? 'AudioWorklet' : 'Analyser'}。</p>
      <table><tr><th>音</th><th>识别率</th><th>误差</th><th>八度错</th></tr>
      ${rows.map((r) => `<tr><td>${r.note}</td><td class="${r.rate >= 0.9 ? 'good' : r.rate >= 0.6 ? 'warn' : 'badc'}">${Math.round(r.rate * 100)}%</td><td>${Number.isFinite(r.cents) ? r.cents.toFixed(1) : '–'}</td><td>${r.octave}</td></tr>`).join('')}
      </table>`;
    record('selftest', { engine: ENGINE, score, raw, avgCents: +(+err).toFixed(2), latencyMs: Math.round(lat * 1000), rows: rows.map((r) => ({ ...r, rate: +r.rate.toFixed(2), cents: +(+r.cents).toFixed(1) })) });
  } catch (e) { $('#selfOut').innerHTML = errBox(e); record('error', { where: 'selftest', msg: errText(e) }); }
  finally { setBusy(false); $('#selfRun').disabled = false; }
}

// ------------------------------------------------------------------ exercise
let exState = null;
async function exercise() {
  if (busy) return; setBusy(true); $('#exRun').disabled = true;
  try {
    await setSource(A.source);
    const c = A.ctx, root = +$('#exRoot').value, dur = +$('#exDur').value, step = dur + 0.08;
    const degrees = [0, 2, 4, 5, 7, 5, 4, 2, 0], t0 = c.currentTime + 1.4;
    const notes = degrees.map((d, i) => ({ m: root + d, hz: hzOf(root + d), t0: t0 + i * step, t1: t0 + i * step + dur }));
    for (let i = 0; i < 3; i++) tone(A.master, 1760, t0 - 1.2 + i * 0.4, 0.05, 0.12); // count-in clicks
    if ($('#exGuide').checked) notes.forEach((n) => tone(A.master, n.hz, n.t0, dur, 0.22));
    if ($('#exPad').checked) pad(A.master, [root - 12, root - 5, root + 4 - 12], t0, notes[notes.length - 1].t1 - t0);
    let simOffs = null;
    if (A.source === 'sim') simOffs = singer(notes, { err: 20, vibrato: 20 });
    const lat = A.source === 'mic' ? store.get('latency_mic_' + ENGINE, 0.12) : store.get('latency_sim_' + ENGINE, 0.03);
    exState = { notes, lat, from: t0 - 1, to: notes[notes.length - 1].t1 + 0.5 };
    $('#exOut').innerHTML = '<p class="muted">唱吧…</p>';
    const end = exState.to + 1.5;
    await waitUntil(end);
    // Men often sing an octave below the guide tone (and children above): judge the note, not the octave.
    const raw = (f, n) => 1200 * Math.log2(f.hz / n.hz);
    const fold = (x) => x - 1200 * Math.round(x / 1200);
    const voicedF = (f) => f.hz > 0 && f.clarity >= VOICED;
    const framesAt = (n, L) => A.frames.filter((f) => f.t - L >= n.t0 + 0.12 && f.t - L <= n.t1);
    // the singer's delay (device + reaction) is unknown on phones: search 0–1.5 s like the self-test, keep the middle of the best plateau
    const scoreAt = (L) => notes.reduce((acc, n) => { const fr = framesAt(n, L); return acc + (fr.length ? fr.filter((f) => voicedF(f) && Math.abs(fold(raw(f, n))) <= 50).length / fr.length : 0); }, 0) / notes.length;
    let used = lat;
    {
      const tries = []; for (let L = 0; L <= 1.5 + 1e-9; L += 0.01) tries.push([L, scoreAt(L)]);
      const best = Math.max(...tries.map((x) => x[1]));
      if (best > 0) { const pl = tries.filter((x) => x[1] >= best - 0.01).map((x) => x[0]); used = pl[Math.floor(pl.length / 2)]; }
    }
    const rows = notes.map((n, i) => {
      const fr = framesAt(n, used);
      const v = fr.filter(voicedF).map((f) => raw(f, n));
      const folded = v.map(fold);
      const hit = folded.filter((x) => Math.abs(x) <= 50).length;
      const mean = folded.length ? folded.reduce((p, q) => p + q, 0) / folded.length : NaN;
      const oct = v.length ? Math.round((v.reduce((p, q) => p + q, 0) / v.length - (Number.isFinite(mean) ? mean : 0)) / 1200) : 0;
      return { note: noteName(n.m), hit: fr.length ? hit / fr.length : 0, mean, oct, sim: simOffs ? simOffs[i] : undefined };
    });
    const octs = rows.filter((r) => Number.isFinite(r.mean)).map((r) => r.oct).sort((p, q) => p - q);
    const octave = octs.length ? octs[Math.floor(octs.length / 2)] : 0;
    const score = Math.round((rows.reduce((p, r) => p + r.hit, 0) / rows.length) * 100);
    const octNote = octave < 0 ? '你比引导音低 ' + -octave + ' 个八度在唱（男声很常见），按同一个音来算。' : octave > 0 ? '你比引导音高 ' + octave + ' 个八度在唱，按同一个音来算。' : '';
    $('#exOut').innerHTML = `<div class="card"><div class="summary">准确度 <b class="${score >= 80 ? 'good' : score >= 50 ? 'warn' : 'badc'}">${score}</b> / 100 <span class="muted">（按 ${Math.round(used * 1000)} 毫秒延迟对齐）</span></div>
      ${octNote ? '<p class="muted">' + octNote + '</p>' : ''}
      <table><tr><th>音</th><th>唱准的比例</th><th>平均偏差</th>${simOffs ? '<th>模拟歌手实际偏差</th>' : ''}</tr>
      ${rows.map((r) => `<tr><td>${r.note}</td><td class="${r.hit >= 0.8 ? 'good' : r.hit >= 0.5 ? 'warn' : 'badc'}">${Math.round(r.hit * 100)}%</td><td>${Number.isFinite(r.mean) ? (r.mean > 0 ? '+' : '') + r.mean.toFixed(0) + ' 音分' : '没听到'}</td>${simOffs ? `<td>${(r.sim > 0 ? '+' : '') + r.sim.toFixed(0)} 音分</td>` : ''}</tr>`).join('')}</table></div>`;
    record('exercise', { engine: ENGINE, score, octave, root: noteName(root), dur, guide: $('#exGuide').checked, pad: $('#exPad').checked, latencyMs: Math.round(used * 1000), rows: rows.map((r) => ({ note: r.note, hit: +r.hit.toFixed(2), mean: +(+r.mean).toFixed(1), oct: r.oct, sim: r.sim === undefined ? undefined : +r.sim.toFixed(1) })) });
  } catch (e) { $('#exOut').innerHTML = errBox(e); record('error', { where: 'exercise', msg: errText(e) }); }
  finally { setBusy(false); $('#exRun').disabled = false; }
}

// ------------------------------------------------------------------ range
const range = {
  low: store.get('low', null), high: store.get('high', null), run: [],
  feed(f) {
    if (!$('#tab-range').classList.contains('on')) return;
    if (f.hz <= 0 || f.clarity < 0.85) { this.run = []; return; }
    const m = midiOf(f.hz);
    this.run.push({ t: f.t, m });
    this.run = this.run.filter((x) => f.t - x.t <= 0.5);
    if (this.run.length < 8 || f.t - this.run[0].t < 0.45) return;
    const ms = this.run.map((x) => x.m).sort((a, b) => a - b), med = ms[Math.floor(ms.length / 2)];
    if (ms[ms.length - 1] - ms[0] > 0.8) return; // not held
    const n = Math.round(med);
    if (this.low === null || n < this.low) this.low = n;
    if (this.high === null || n > this.high) this.high = n;
    store.set('low', this.low); store.set('high', this.high); this.show();
  },
  show() {
    if (this.low === null) { $('#rOut').textContent = '还没有记录'; return; }
    const span = this.high - this.low;
    $('#rOut').innerHTML = `你的音域：<b>${noteName(this.low)} – ${noteName(this.high)}</b>（${Math.floor(span / 12)} 个八度 ${span % 12} 个半音）`;
  },
};

// ------------------------------------------------------------------ device + export
function showDevice() {
  if (!A.ctx) return;
  const voiced = A.frames.filter((f) => f.hz > 0 && f.clarity >= VOICED).length;
  const parts = [`识别 ${ENGINE === 'worklet' ? 'AudioWorklet' : 'Analyser'}`, `音频 ${A.ctx.state}`, `已收到 ${A.frames.length} 帧`, `听到音 ${voiced} 帧`, `采样率 ${A.ctx.sampleRate} Hz`, `基础延迟 ${Math.round((A.ctx.baseLatency || 0) * 1000)} ms`, `输出延迟 ${Math.round((A.ctx.outputLatency || 0) * 1000)} ms`, `来源 ${A.source === 'mic' ? '麦克风' : '模拟歌声'}`];
  $('#dev').innerHTML = parts.map((p) => `<span class="pill">${p}</span>`).join('');
}
function diag() {
  const tr = A.mic && A.mic.getAudioTracks()[0];
  const last = A.frames[A.frames.length - 1];
  return { state: A.ctx && A.ctx.state, states: A.states.slice(-10), now: A.ctx && +A.ctx.currentTime.toFixed(2), frames: A.frames.length,
    voiced: A.frames.filter((f) => f.hz > 0 && f.clarity >= VOICED).length, maxRms: A.frames.reduce((m, f) => Math.max(m, f.rms), 0),
    lastFrame: last, mic: tr ? { state: tr.readyState, muted: tr.muted, settings: tr.getSettings ? tr.getSettings() : null } : null, source: A.source };
}
function exportText() {
  return JSON.stringify({ ua: navigator.userAgent, inApp: IN_APP, engine: ENGINE, page: 'v5', diag: diag(), sampleRate: A.ctx && A.ctx.sampleRate, baseLatency: A.ctx && A.ctx.baseLatency, outputLatency: A.ctx && A.ctx.outputLatency, range: { low: range.low, high: range.high }, log }, null, 1);
}

// ------------------------------------------------------------------ wiring
function draw() {
  if (A.ctx) {
    const now = A.ctx.currentTime;
    if ($('#tab-tuner').classList.contains('on')) {
      const recent = framesSince(now - 6).filter((f) => f.hz > 0 && f.clarity >= VOICED).map((f) => midiOf(f.hz)).sort((a, b) => a - b);
      const mid = recent.length ? recent[Math.floor(recent.length / 2)] : 60;
      plot($('#tPlot'), { from: now - 6, to: now + 0.3, lo: mid - 9, hi: mid + 9 });
    } else if ($('#tab-ex').classList.contains('on') && exState) {
      const done = now > exState.to, span = done ? exState.to - exState.from : 5;
      const from = done ? exState.from : Math.max(exState.from, now - span * 0.7); // finished: show the whole run
      const r = +$('#exRoot').value;
      plot($('#exPlot'), { targets: exState.notes, from, to: from + span, lo: r - 4, hi: r + 11, lat: exState.lat });
    }
  }
  requestAnimationFrame(draw);
}
async function start(src) {
  try { await setSource(src); $('#start').classList.add('off'); }
  catch (e) { record('error', { where: 'start', msg: errText(e) }); $('#startErr').innerHTML = errBox(e); }
}
function init() {
  if (IN_APP) $('#inApp').style.display = 'block';
  const rs = $('#exRoot');
  for (let m = 43; m <= 69; m++) { const o = document.createElement('option'); o.value = m; o.textContent = noteName(m); rs.appendChild(o); }
  rs.value = store.get('root', 57);
  rs.addEventListener('change', () => store.set('root', +rs.value));
  $('#engine').value = ENGINE;
  $('#engine').addEventListener('change', (e) => { const u = new URL(location.href); u.searchParams.set('engine', e.target.value); location.href = u.toString(); });
  $('#naming').value = naming;
  $('#naming').addEventListener('change', (e) => { naming = e.target.value; store.set('naming', naming); [...rs.options].forEach((o) => { o.textContent = noteName(+o.value); }); range.show(); });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + b.dataset.tab));
  });
  $('#startMic').addEventListener('click', () => start('mic'));
  $('#startSim').addEventListener('click', () => start('sim'));
  $('#source').addEventListener('change', (e) => setSource(e.target.value).catch((err) => { alert('打不开麦克风：' + err.message); setSource('sim'); }));
  $('#selfRun').addEventListener('click', selfTest);
  $('#exRun').addEventListener('click', exercise);
  $('#rReset').addEventListener('click', () => { range.low = range.high = null; store.set('low', null); store.set('high', null); range.show(); });
  $('#rUse').addEventListener('click', () => { if (range.low !== null) { const r = Math.min(69, Math.max(43, range.low + 2)); rs.value = r; store.set('root', r); $('#tabs button[data-tab=ex]').click(); } });
  $('#copy').addEventListener('click', async () => {
    const txt = exportText(), box = $('#copyBox');
    try { await navigator.clipboard.writeText(txt); $('#copy').textContent = '已复制'; setTimeout(() => { $('#copy').textContent = '复制结果'; }, 1500); }
    catch { box.style.display = 'block'; box.value = txt; box.select(); }
  });
  $('#clear').addEventListener('click', () => { log.length = 0; store.set('log', []); $('#copyBox').style.display = 'none'; });
  A.subs.add(onFrame);
  setInterval(showDevice, 1000);
  range.show();
  requestAnimationFrame(draw);
}
init();
window.__sing = { A, selfTest, exercise, range, exportText, setSource }; // for testing
