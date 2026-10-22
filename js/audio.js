// Sonido sintetizado con Web Audio: motor con marchas, chirrido de neumáticos y efectos.
export class Sound {
  init() {
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    this.engineGain.connect(lp).connect(this.master);
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    this.osc1.connect(this.engineGain);
    this.osc2.connect(g2).connect(this.engineGain);
    this.osc1.start(); this.osc2.start();

    const len = ctx.sampleRate;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = ctx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 6;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    noise.connect(bp).connect(this.squealGain).connect(this.master);
    noise.start();
  }

  // speed en m/s, throttle 0/1, slip = intensidad del derrape 0..1
  engine(speed, throttle, slip, boost) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const gears = [0, 9, 16, 23, 29, 40];
    let g = 1;
    while (g < gears.length - 1 && speed > gears[g]) g++;
    const frac = (speed - gears[g - 1]) / (gears[g] - gears[g - 1]);
    const rpm = 0.25 + 0.75 * Math.min(1, Math.max(0, frac));
    const f = 55 + rpm * 120 + (boost ? 25 : 0);
    this.osc1.frequency.setTargetAtTime(f, t, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.12 + (throttle ? 0.14 : 0.04), t, 0.08);
    this.squealGain.gain.setTargetAtTime(Math.min(0.18, slip * 0.25), t, 0.05);
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0, t, 0.1);
    this.squealGain.gain.setTargetAtTime(0, t, 0.1);
  }

  beep(freq = 660, dur = 0.15, type = 'square', vol = 0.25) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur);
  }

  sfx(name) {
    if (!this.ctx) return;
    const seq = {
      pickup: [[880, 0.06], [1320, 0.08]],
      item: [[520, 0.08], [780, 0.1]],
      boost: [[300, 0.25, 'sawtooth']],
      hit: [[180, 0.35, 'sawtooth'], [120, 0.3, 'sawtooth']],
      lap: [[660, 0.1], [880, 0.1], [1100, 0.18]],
    }[name];
    if (name === 'boom') { this.noise(0.6, 0.5, 500); return; }
    if (!seq) return;
    seq.forEach(([f, d, type], i) => setTimeout(() => this.beep(f, d, type || 'square', 0.2), i * 90));
  }

  noise(dur, vol, cutoff) {
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    s.buffer = this.noiseBuf;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t); s.stop(t + dur);
  }
}
