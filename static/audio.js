// All sounds are synthesized locally. No network/audio library required.
// Thermal preset follows the reference's motor, gear and paper-friction layers.
export class PrinterAudio {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.noiseBuffer = null;
    this.customBuffer = null;
    this.customName = '';
    this.unlocked = false;
  }
  async unlock() {
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      await this.ctx.resume();
      this.unlocked = this.ctx.state === 'running';
      if (!this.noiseBuffer) {
        this.noiseBuffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
        const data = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
    } catch { /* Printing works even if audio is unsupported or blocked. */ }
  }
  get audible() { return this.unlocked && this.ctx?.state === 'running' && !this.settings.muted && this.settings.volume > 0; }
  bus() {
    const gain = this.ctx.createGain();
    gain.gain.value = this.settings.muted ? 0 : this.settings.volume;
    gain.connect(this.ctx.destination);
    return gain;
  }
  // A short mechanical click plus a low-frequency body thump.
  key(volume = 1, pitch = 0) {
    if (!this.audible || !this.settings.typingSound) return;
    const t = this.ctx.currentTime, bus = this.bus();
    this.noise(t, .05, 1200 + Math.random() * 200, 'highpass', .6 * volume, bus, true);
    this.tone(t, .05, 100 + pitch + Math.random() * 10, 50, 'triangle', .3 * volume, bus, true);
    setTimeout(() => bus.disconnect(), 200);
  }
  carriage() {
    if (!this.audible || !this.settings.typingSound) return;
    const t = this.ctx.currentTime, bus = this.bus();
    this.tone(t, .25, 180, 60, 'sawtooth', .2, bus, false, 1000);
    setTimeout(() => this.key(1.5, -20), 180);
    setTimeout(() => bus.disconnect(), 400);
  }
  tone(t, duration, from, to, type, amplitude, output, exponential = false, cutoff = 0) {
    const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (exponential) osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    else osc.frequency.linearRampToValueAtTime(to, t + duration);
    gain.gain.setValueAtTime(amplitude, t);
    if (exponential) gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    else gain.gain.linearRampToValueAtTime(0, t + duration);
    if (cutoff) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = cutoff;
      osc.connect(filter); filter.connect(gain);
    } else osc.connect(gain);
    gain.connect(output); osc.start(t); osc.stop(t + duration);
    return osc;
  }
  noise(t, duration, frequency, type, amplitude, output, fade = false) {
    const source = this.ctx.createBufferSource(), filter = this.ctx.createBiquadFilter(), gain = this.ctx.createGain();
    source.buffer = this.noiseBuffer; source.loop = true;
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = 2;
    if (fade) {
      gain.gain.setValueAtTime(amplitude, t);
      gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    } else this.envelope(gain, t, duration, amplitude);
    source.connect(filter); filter.connect(gain); gain.connect(output);
    source.start(t, Math.random()); source.stop(t + duration);
    return source;
  }
  envelope(gain, t, duration, value) {
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(value, t + .1);
    gain.gain.setValueAtTime(value, t + duration - .1);
    gain.gain.linearRampToValueAtTime(0, t + duration);
  }
  print(ms) {
    if (!this.audible) return () => {};
    const t = this.ctx.currentTime, duration = Math.max(.3, ms / 1000), bus = this.bus(), sources = [];
    if (this.settings.preset === 'custom' && this.customBuffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = this.customBuffer; source.loop = true;
      const gain = this.ctx.createGain(); this.envelope(gain, t, duration, .75);
      source.connect(gain); gain.connect(bus); source.start(t); source.stop(t + duration);
      sources.push(source);
    } else if (this.settings.preset === 'thermal') {
      const motor = this.ctx.createOscillator(), lfo = this.ctx.createOscillator(), lfoGain = this.ctx.createGain();
      motor.type = 'sawtooth'; motor.frequency.value = 500;
      lfo.type = 'square'; lfo.frequency.value = 40; lfoGain.gain.value = 20;
      lfo.connect(lfoGain); lfoGain.connect(motor.frequency);
      const filter = this.ctx.createBiquadFilter(), gain = this.ctx.createGain();
      filter.type = 'lowpass'; filter.frequency.value = 1500;
      this.envelope(gain, t, duration, .08);
      motor.connect(filter); filter.connect(gain); gain.connect(bus);
      motor.start(t); motor.stop(t + duration); lfo.start(t); lfo.stop(t + duration);
      sources.push(motor, lfo);
      const rumble = this.ctx.createOscillator(), rumbleFilter = this.ctx.createBiquadFilter(), rumbleGain = this.ctx.createGain();
      rumble.type = 'square'; rumble.frequency.value = 80;
      rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 200;
      this.envelope(rumbleGain, t, duration, .05);
      rumble.connect(rumbleFilter); rumbleFilter.connect(rumbleGain); rumbleGain.connect(bus);
      rumble.start(t); rumble.stop(t + duration); sources.push(rumble);
      sources.push(this.noise(t, duration, 3000, 'bandpass', .04, bus));
    } else {
      // Soft, rhythmic "噗噗噗": resonant air bursts and tiny roller thumps.
      for (let dt = 0; dt < duration - .08; dt += .125) {
        sources.push(this.noise(t + dt, .09, 470 + Math.random() * 100, 'bandpass', .24, bus, true));
        sources.push(this.tone(t + dt, .075, 145, 48, 'triangle', .17, bus, true));
      }
    }
    sources.push(this.tone(t + duration, .1, 100, 10, 'triangle', .1, bus));
    const timer = setTimeout(() => bus.disconnect(), ms + 300);
    const onSettings = () => { bus.gain.value = this.settings.muted ? 0 : this.settings.volume; };
    window.addEventListener('audio-settings', onSettings);
    const cleanup = setTimeout(() => window.removeEventListener('audio-settings', onSettings), ms + 350);
    return () => {
      clearTimeout(timer); clearTimeout(cleanup);
      window.removeEventListener('audio-settings', onSettings);
      sources.forEach(source => { try { source.stop(); } catch {} });
      bus.disconnect();
    };
  }
  async decode(bytes) {
    // Decoding is allowed before playback is unlocked; do not auto-resume here.
    this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx.decodeAudioData(bytes.slice(0));
  }
  async loadCustom() {
    const stored = await audioStore('get');
    if (stored) { this.customBuffer = await this.decode(stored.bytes); this.customName = stored.name; }
  }
  async setCustom(file) {
    if (file.size > 10 * 1024 * 1024) throw new Error('音频不能超过 10 MB');
    const bytes = await file.arrayBuffer();
    let decoded;
    try { decoded = await this.decode(bytes); } catch { throw new Error('无法解码此音频，请尝试 MP3、WAV 或 OGG'); }
    if (decoded.duration > 30 || decoded.duration < .05) throw new Error('音频长度应为 0.05 至 30 秒');
    await audioStore('put', { bytes, name: file.name });
    this.customBuffer = decoded; this.customName = file.name;
  }
  async removeCustom() {
    await audioStore('delete'); this.customBuffer = null; this.customName = '';
  }
}
function audioStore(action, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('motopager-audio', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('sounds');
    open.onerror = () => reject(new Error('浏览器不允许保存自定义音频'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('sounds', action === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('sounds');
      const request = action === 'get' ? store.get('custom') : action === 'put' ? store.put(value, 'custom') : store.delete('custom');
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = () => { db.close(); reject(new Error('音频存储失败，浏览器存储空间可能不足')); };
    };
  });
}
