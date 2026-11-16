// DUSTLINE audio — every sound is synthesized with WebAudio. No network,
// no audio files. The context is created lazily on the first user gesture
// (browsers block audio before interaction) and every helper no-ops until then.
let ctx = null;
let master = null;
let noiseBuf = null;

export function ensureAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return true;
  } catch {
    return false;
  }
}

function tone(freq, dur, type, vol, slideTo) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(dur, vol, filterFreq, type = 'lowpass') {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = filterFreq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// kind: 'jackal' | 'hornet' | 'longshot' | 'sidewinder' | 'distant'
export function playShot(kind, distant = false) {
  if (!ctx) return;
  const vol = distant ? 0.12 : 0.5;
  if (kind === 'longshot') {
    noise(0.28, vol, 900);
    tone(140, 0.22, 'sawtooth', vol * 0.5, 45);
  } else if (kind === 'hornet') {
    noise(0.09, vol * 0.8, 2400, 'bandpass');
    tone(210, 0.07, 'square', vol * 0.35, 90);
  } else if (kind === 'sidewinder') {
    noise(0.12, vol * 0.9, 1800, 'bandpass');
    tone(180, 0.09, 'square', vol * 0.4, 70);
  } else {
    noise(0.14, vol, 1600, 'bandpass');
    tone(160, 0.1, 'sawtooth', vol * 0.45, 60);
  }
}

export function playDryFire() {
  tone(1200, 0.04, 'square', 0.12);
}

export function playReload() {
  tone(500, 0.05, 'square', 0.14, 300);
  setTimeout(() => tone(700, 0.05, 'square', 0.14, 420), 180);
  setTimeout(() => tone(900, 0.06, 'square', 0.16, 500), 420);
}

export function playHitmarker(kill) {
  tone(kill ? 1400 : 1000, kill ? 0.12 : 0.06, 'sine', 0.22);
  if (kill) setTimeout(() => tone(1800, 0.1, 'sine', 0.2), 90);
}

export function playHurt() {
  tone(110, 0.18, 'sawtooth', 0.3, 55);
  noise(0.12, 0.18, 500);
}

// Short plant beep; the planted charge beeps faster as the timer runs out.
export function playBeep(urgent = false) {
  tone(urgent ? 1500 : 1050, 0.09, 'sine', 0.25);
}

export function playPlantStart() {
  tone(660, 0.12, 'sine', 0.22);
  setTimeout(() => tone(880, 0.12, 'sine', 0.22), 130);
}

export function playExplosion() {
  noise(1.4, 0.9, 320);
  tone(70, 1.1, 'sine', 0.6, 28);
  setTimeout(() => noise(0.8, 0.4, 180), 150);
}

export function playFootstep() {
  // Slight random detune so repeated steps do not sound mechanical.
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.85 + Math.random() * 0.3;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 700;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.07, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
  src.stop(t + 0.07);
}

export function playBuy() {
  tone(880, 0.07, 'sine', 0.18);
  setTimeout(() => tone(1320, 0.09, 'sine', 0.18), 70);
}

export function playRoundWin() {
  [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.22, 'sine', 0.2), i * 110));
}

export function playRoundLose() {
  [392, 330, 262].forEach((f, i) => setTimeout(() => tone(f, 0.25, 'sine', 0.18), i * 120));
}

export function playDefuse() {
  tone(1200, 0.08, 'sine', 0.2);
  setTimeout(() => tone(1200, 0.08, 'sine', 0.2), 200);
}
