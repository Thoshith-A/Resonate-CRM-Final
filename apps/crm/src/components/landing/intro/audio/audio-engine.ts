/**
 * Procedural score for "Stellar Genesis" — 100% Web Audio synthesis, no
 * sample files (same "everything is generated" rule as the visuals). One
 * engine, beat-driven so it can join the film mid-flight if the listener
 * enables sound late. All voices route dry to a master limiter and wet to a
 * convolution reverb built from a decaying-noise impulse.
 *
 * Browser autoplay policy forbids audio before a user gesture, so the engine
 * stays silent until enable() is called from a click/keypress (the sound
 * toggle). Muted by default — exactly as the brief requires.
 */

export type IntroBeat =
  | "void"
  | "system"
  | "omen"
  | "impact"
  | "genesis"
  | "handoff";

const MASTER_LEVEL = 0.62;
const BED_LEVEL = 0.13;
const REVERB_SECONDS = 2.8;

/** Minimal AudioContext constructor type (covers the webkit-prefixed path). */
type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class IntroAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: GainNode | null = null;
  private bed: GainNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private bedVoices: OscillatorNode[] = [];
  private shimmer: GainNode | null = null;
  private padEnv: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sources: AudioScheduledSourceNode[] = [];
  private lfos: OscillatorNode[] = [];
  private enabled = false;
  private started = false;
  private disposed = false;

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Resume/build the graph from a user gesture and fade the score in. */
  async enable(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.ctx) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) {
        return;
      }
      this.ctx = new Ctor();
      this.buildGraph(this.ctx);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.enabled = true;
    if (!this.started) {
      this.startBed();
      this.started = true;
    }
    const now = this.ctx.currentTime;
    const master = this.master;
    if (master) {
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
      master.gain.linearRampToValueAtTime(MASTER_LEVEL, now + 0.5);
    }
  }

  /** Fade to silence but keep the graph alive for instant re-enable. */
  disable(): void {
    this.enabled = false;
    if (!this.ctx || !this.master) {
      return;
    }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.3);
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === "running") {
      void this.ctx.suspend();
    }
  }

  resumeIfEnabled(): void {
    if (this.enabled && this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    for (const lfo of this.lfos) {
      try {
        lfo.stop();
      } catch {
        // Already stopped.
      }
    }
    if (this.ctx) {
      void this.ctx.close();
    }
    this.ctx = null;
  }

  /** Trigger the voice(s) for a timeline beat. No-op while muted. */
  beat(label: IntroBeat): void {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) {
      return;
    }
    const now = ctx.currentTime;
    switch (label) {
      case "void":
        this.rampBed(now, 240, BED_LEVEL * 0.7, 0.8);
        break;
      case "system":
        this.rampBed(now, 760, BED_LEVEL, 1.4);
        this.swellShimmer(now, 1.4);
        this.chime(now, 0.9);
        break;
      case "omen":
        this.riser(now, 0.78);
        this.bendBed(now, -16, 0.7);
        break;
      case "impact":
        this.impact(now);
        this.bendBed(now, 0, 0.5);
        break;
      case "genesis":
        this.pad(now, 1.7);
        this.swellShimmer(now, 1.5);
        this.rampBed(now, 520, BED_LEVEL * 0.8, 1.2);
        break;
      case "handoff":
        this.resolve(now);
        break;
    }
  }

  // ---- graph construction -------------------------------------------------

  private buildGraph(ctx: AudioContext): void {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 6;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(limiter);
    this.master = master;

    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(ctx);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;
    convolver.connect(reverbReturn);
    reverbReturn.connect(master);
    // Expose the convolver via a send gain so voices can dial their own wet.
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    reverbSend.connect(convolver);
    this.reverb = reverbSend;

    this.noiseBuffer = this.makeNoise(ctx);
  }

  private makeImpulse(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const decay = Math.pow(1 - i / length, 2.6);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    return impulse;
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    this.track(source);
    return source;
  }

  private track(source: AudioScheduledSourceNode): void {
    this.sources.push(source);
  }

  // ---- the bed (continuous drone + shimmer) -------------------------------

  private startBed(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) {
      return;
    }

    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = "lowpass";
    bedFilter.frequency.value = 200;
    bedFilter.Q.value = 0.8;

    const bedGain = ctx.createGain();
    bedGain.gain.value = BED_LEVEL * 0.7;
    bedFilter.connect(bedGain);
    bedGain.connect(master);
    if (this.reverb) {
      const wet = ctx.createGain();
      wet.gain.value = 0.25;
      bedGain.connect(wet);
      wet.connect(this.reverb);
    }

    const freqs = [55, 55.2, 110];
    const types: OscillatorType[] = ["triangle", "triangle", "sine"];
    for (let i = 0; i < freqs.length; i += 1) {
      const osc = ctx.createOscillator();
      osc.type = types[i] ?? "sine";
      osc.frequency.value = freqs[i] ?? 55;
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = i === 2 ? 0.5 : 0.8;
      osc.connect(voiceGain);
      voiceGain.connect(bedFilter);
      osc.start();
      this.bedVoices.push(osc);
      this.track(osc);
    }

    // Slow "breathing" of the bed level.
    const breath = ctx.createOscillator();
    breath.type = "sine";
    breath.frequency.value = 0.06;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = BED_LEVEL * 0.25;
    breath.connect(breathDepth);
    breathDepth.connect(bedGain.gain);
    breath.start();
    this.lfos.push(breath);

    this.bed = bedGain;
    this.bedFilter = bedFilter;

    // Faint high shimmer — the starfield.
    const shimmerSource = this.noiseSource(ctx);
    const shimmerHp = ctx.createBiquadFilter();
    shimmerHp.type = "highpass";
    shimmerHp.frequency.value = 6500;
    const shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0.0;
    shimmerSource.connect(shimmerHp);
    shimmerHp.connect(shimmerGain);
    shimmerGain.connect(master);
    shimmerSource.start();
    this.shimmer = shimmerGain;
  }

  private rampBed(now: number, cutoff: number, level: number, time: number): void {
    if (this.bedFilter) {
      this.bedFilter.frequency.cancelScheduledValues(now);
      this.bedFilter.frequency.setValueAtTime(this.bedFilter.frequency.value, now);
      this.bedFilter.frequency.linearRampToValueAtTime(cutoff, now + time);
    }
    if (this.bed) {
      this.bed.gain.cancelScheduledValues(now);
      this.bed.gain.setValueAtTime(this.bed.gain.value, now);
      this.bed.gain.linearRampToValueAtTime(level, now + time);
    }
  }

  private bendBed(now: number, cents: number, time: number): void {
    for (const osc of this.bedVoices) {
      osc.detune.cancelScheduledValues(now);
      osc.detune.setValueAtTime(osc.detune.value, now);
      osc.detune.linearRampToValueAtTime(cents, now + time);
    }
  }

  private swellShimmer(now: number, time: number): void {
    if (!this.shimmer) {
      return;
    }
    this.shimmer.gain.cancelScheduledValues(now);
    this.shimmer.gain.setValueAtTime(this.shimmer.gain.value, now);
    this.shimmer.gain.linearRampToValueAtTime(0.05, now + time);
  }

  // ---- one-shot voices ----------------------------------------------------

  private chime(now: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) {
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 880;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain * 0.08, now + 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
    osc.connect(env);
    env.connect(master);
    if (this.reverb) {
      env.connect(this.reverb);
    }
    osc.start(now);
    osc.stop(now + 2.8);
    this.track(osc);
  }

  private riser(now: number, duration: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) {
      return;
    }
    // Pitched riser.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(360, now + duration);
    const oscFilter = ctx.createBiquadFilter();
    oscFilter.type = "lowpass";
    oscFilter.frequency.setValueAtTime(400, now);
    oscFilter.frequency.exponentialRampToValueAtTime(3200, now + duration);
    const oscEnv = ctx.createGain();
    oscEnv.gain.setValueAtTime(0.0001, now);
    oscEnv.gain.exponentialRampToValueAtTime(0.16, now + duration);
    oscEnv.gain.linearRampToValueAtTime(0, now + duration + 0.06);
    osc.connect(oscFilter);
    oscFilter.connect(oscEnv);
    oscEnv.connect(master);
    osc.start(now);
    osc.stop(now + duration + 0.1);
    this.track(osc);

    // Air-rushing noise sweep (the meteor's doppler).
    const noise = this.noiseSource(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(300, now);
    band.frequency.exponentialRampToValueAtTime(4200, now + duration);
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.0001, now);
    noiseEnv.gain.exponentialRampToValueAtTime(0.12, now + duration * 0.9);
    noiseEnv.gain.linearRampToValueAtTime(0, now + duration + 0.05);
    noise.connect(band);
    band.connect(noiseEnv);
    noiseEnv.connect(master);
    if (this.reverb) {
      noiseEnv.connect(this.reverb);
    }
    noise.start(now);
    noise.stop(now + duration + 0.1);
  }

  private impact(now: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) {
      return;
    }

    // Sub-bass thump: a fast downward pitch drop is the body of the hit.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(120, now);
    sub.frequency.exponentialRampToValueAtTime(38, now + 0.22);
    const subEnv = ctx.createGain();
    subEnv.gain.setValueAtTime(0.0001, now);
    subEnv.gain.linearRampToValueAtTime(1.0, now + 0.006);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    sub.connect(subEnv);
    subEnv.connect(master);
    if (this.reverb) {
      subEnv.connect(this.reverb);
    }
    sub.start(now);
    sub.stop(now + 0.75);
    this.track(sub);

    // Explosion body: noise through a lowpass that slams open then shuts.
    const noise = this.noiseSource(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1800, now);
    lp.frequency.exponentialRampToValueAtTime(150, now + 0.32);
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.0001, now);
    noiseEnv.gain.linearRampToValueAtTime(0.85, now + 0.008);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    noise.connect(lp);
    lp.connect(noiseEnv);
    noiseEnv.connect(master);
    if (this.reverb) {
      const wet = ctx.createGain();
      wet.gain.value = 0.8;
      noiseEnv.connect(wet);
      wet.connect(this.reverb);
    }
    noise.start(now);
    noise.stop(now + 0.45);

    // Bright transient crack for the white-flash frame.
    const crack = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4000;
    const crackEnv = ctx.createGain();
    crackEnv.gain.setValueAtTime(0.5, now);
    crackEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    crack.connect(hp);
    hp.connect(crackEnv);
    crackEnv.connect(master);
    crack.start(now);
    crack.stop(now + 0.12);

    // Duck the bed for a beat so the hit punches a hole, then let it return.
    if (this.bed) {
      const current = this.bed.gain.value;
      this.bed.gain.cancelScheduledValues(now);
      this.bed.gain.setValueAtTime(current, now);
      this.bed.gain.linearRampToValueAtTime(current * 0.2, now + 0.04);
      this.bed.gain.linearRampToValueAtTime(current, now + 1.1);
    }
  }

  private pad(now: number, duration: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) {
      return;
    }
    // Warm A-major-ish stack — the "rebirth" chord.
    const notes = [110, 164.81, 220, 277.18];
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(280, now);
    filter.frequency.linearRampToValueAtTime(2600, now + duration);
    filter.Q.value = 0.7;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(0.42, now + duration);
    filter.connect(env);
    env.connect(master);
    if (this.reverb) {
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      env.connect(wet);
      wet.connect(this.reverb);
    }

    for (const note of notes) {
      for (const detune of [-5, 5]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = note;
        osc.detune.value = detune;
        const voice = ctx.createGain();
        voice.gain.value = 0.16;
        osc.connect(voice);
        voice.connect(filter);
        osc.start(now);
        osc.stop(now + duration + 4);
        this.track(osc);
      }
    }
    this.padEnv = env;
  }

  private resolve(now: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    // Settle the pad to a sustained glow, then fade the whole score out as
    // the page takes over.
    if (this.padEnv) {
      this.padEnv.gain.cancelScheduledValues(now);
      this.padEnv.gain.setValueAtTime(this.padEnv.gain.value, now);
      this.padEnv.gain.linearRampToValueAtTime(0.28, now + 0.6);
      this.padEnv.gain.linearRampToValueAtTime(0.0001, now + 3.2);
    }
    if (this.shimmer) {
      this.shimmer.gain.linearRampToValueAtTime(0.0, now + 3.0);
    }
    if (this.master) {
      this.master.gain.cancelScheduledValues(now + 1.2);
      this.master.gain.setValueAtTime(MASTER_LEVEL, now + 1.2);
      this.master.gain.linearRampToValueAtTime(0.0001, now + 3.4);
    }
  }
}
