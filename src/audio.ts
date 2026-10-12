export type SoundKind =
  | 'pickup' | 'deposit' | 'deliver' | 'buy' | 'dock' | 'undock' | 'takeoff' | 'land'
  | 'hop' | 'oxygen' | 'rescue' | 'block' | 'clean' | 'win' | 'lose' | 'ui' | 'scrape' | 'thrust'

export interface Audio {
  unlock(): void
  play(kind: SoundKind, strength?: number): void
  setMuted(muted: boolean): void
  isMuted(): boolean
  setLoop(kind: 'vacuum' | 'thruster', intensity: number): void
  stop(): void
}

type Wave = OscillatorType

interface Tone {
  wave: Wave
  from: number
  to: number
  duration: number
  gain: number
  noise?: boolean
  delay?: number
}

const TONES: Record<string, Tone[]> = {
  pickup: [{ wave: 'triangle', from: 640, to: 1020, duration: 0.09, gain: 0.085 }],
  deposit: [
    { wave: 'square', from: 300, to: 520, duration: 0.12, gain: 0.075 },
    { wave: 'triangle', from: 480, to: 760, duration: 0.14, gain: 0.07, delay: 0.08 },
  ],
  deliver: [
    { wave: 'triangle', from: 520, to: 880, duration: 0.14, gain: 0.1 },
    { wave: 'triangle', from: 660, to: 1180, duration: 0.16, gain: 0.09, delay: 0.1 },
    { wave: 'triangle', from: 880, to: 1560, duration: 0.24, gain: 0.09, delay: 0.2 },
  ],
  buy: [
    { wave: 'square', from: 880, to: 1240, duration: 0.09, gain: 0.075 },
    { wave: 'square', from: 1240, to: 1760, duration: 0.14, gain: 0.075, delay: 0.08 },
  ],
  dock: [
    { wave: 'sawtooth', from: 200, to: 80, duration: 0.3, gain: 0.16, noise: true },
    { wave: 'sine', from: 150, to: 62, duration: 0.42, gain: 0.14, delay: 0.06 },
  ],
  undock: [
    { wave: 'sine', from: 200, to: 420, duration: 0.22, gain: 0.1 },
    { wave: 'sawtooth', from: 320, to: 120, duration: 0.24, gain: 0.09, delay: 0.14, noise: true },
  ],
  takeoff: [
    { wave: 'sawtooth', from: 120, to: 360, duration: 0.75, gain: 0.16, noise: true },
    { wave: 'sine', from: 160, to: 640, duration: 0.7, gain: 0.1, delay: 0.05 },
  ],
  land: [
    { wave: 'sawtooth', from: 220, to: 70, duration: 0.34, gain: 0.17, noise: true },
    { wave: 'sine', from: 130, to: 60, duration: 0.3, gain: 0.12, delay: 0.04 },
  ],
  hop: [{ wave: 'sine', from: 420, to: 780, duration: 0.13, gain: 0.09 }],
  oxygen: [{ wave: 'sine', from: 900, to: 300, duration: 0.42, gain: 0.15 }],
  rescue: [
    { wave: 'triangle', from: 260, to: 1500, duration: 0.5, gain: 0.16 },
    { wave: 'sine', from: 520, to: 1980, duration: 0.45, gain: 0.12, delay: 0.16 },
  ],
  block: [{ wave: 'square', from: 300, to: 190, duration: 0.13, gain: 0.075 }],
  scrape: [{ wave: 'sawtooth', from: 300, to: 110, duration: 0.2, gain: 0.11, noise: true }],
  clean: [
    { wave: 'triangle', from: 440, to: 880, duration: 0.18, gain: 0.1 },
    { wave: 'triangle', from: 660, to: 1320, duration: 0.2, gain: 0.1, delay: 0.14 },
    { wave: 'triangle', from: 880, to: 1760, duration: 0.42, gain: 0.12, delay: 0.3 },
  ],
  win: [
    { wave: 'triangle', from: 520, to: 780, duration: 0.2, gain: 0.11 },
    { wave: 'triangle', from: 660, to: 990, duration: 0.2, gain: 0.11, delay: 0.18 },
    { wave: 'triangle', from: 780, to: 1560, duration: 0.7, gain: 0.13, delay: 0.36 },
  ],
  lose: [
    { wave: 'sawtooth', from: 420, to: 90, duration: 1.1, gain: 0.18 },
    { wave: 'sine', from: 220, to: 55, duration: 1.3, gain: 0.12, delay: 0.1 },
  ],
  ui: [{ wave: 'triangle', from: 440, to: 660, duration: 0.08, gain: 0.07 }],
  thrust: [{ wave: 'sine', from: 240, to: 760, duration: 0.16, gain: 0.1 }],
}

export function createAudio(): Audio {
  let context: AudioContext | undefined
  let master: GainNode | undefined
  let noiseBuffer: AudioBuffer | undefined
  let muted = false

  interface Loop {
    kind: 'vacuum' | 'thruster'
    gain: GainNode
    filter: BiquadFilterNode
    source: AudioBufferSourceNode
  }

  const loops: Loop[] = []
  const loopTargets: Record<'vacuum' | 'thruster', number> = { vacuum: 0, thruster: 0 }
  const loopFor = (kind: 'vacuum' | 'thruster') => loops.find(loop => loop.kind === kind)

  function ensure(): AudioContext | undefined {
    if (context) return context
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return undefined
    context = new Ctor()
    master = context.createGain()
    master.gain.value = muted ? 0 : 0.85
    master.connect(context.destination)

    const length = Math.floor(context.sampleRate * 2)
    noiseBuffer = context.createBuffer(1, length, context.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    let state = 12345
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      data[i] = (state / 2147483648 - 1) * 0.6
    }

    // vacuum: a soft filtered hiss; thruster: a low rumble
    const specs: { kind: 'vacuum' | 'thruster'; type: BiquadFilterType; frequency: number; q: number }[] = [
      { kind: 'vacuum', type: 'bandpass', frequency: 520, q: 0.9 },
      { kind: 'thruster', type: 'lowpass', frequency: 420, q: 0.6 },
    ]
    for (const spec of specs) {
      const source = context.createBufferSource()
      source.buffer = noiseBuffer
      source.loop = true
      const filter = context.createBiquadFilter()
      filter.type = spec.type
      filter.frequency.value = spec.frequency
      filter.Q.value = spec.q
      const gain = context.createGain()
      gain.gain.value = 0
      source.connect(filter).connect(gain).connect(master)
      source.start()
      loops.push({ kind: spec.kind, gain, filter, source })
    }
    return context
  }

  function playTone(ctx: AudioContext, tone: Tone, strength: number) {
    if (!master) return
    const start = ctx.currentTime + (tone.delay ?? 0)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.002, tone.gain * strength), start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration)
    gain.connect(master)

    const oscillator = ctx.createOscillator()
    oscillator.type = tone.wave
    oscillator.frequency.setValueAtTime(Math.max(20, tone.from), start)
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, tone.to), start + tone.duration)
    oscillator.connect(gain)
    oscillator.start(start)
    oscillator.stop(start + tone.duration + 0.04)

    if (tone.noise && noiseBuffer) {
      const source = ctx.createBufferSource()
      source.buffer = noiseBuffer
      source.loop = true
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 900
      const noiseGain = ctx.createGain()
      noiseGain.gain.setValueAtTime(tone.gain * 0.7 * strength, start)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration)
      source.connect(filter).connect(noiseGain).connect(master)
      source.start(start)
      source.stop(start + tone.duration)
    }
  }

  return {
    unlock() {
      const ctx = ensure()
      if (ctx && ctx.state === 'suspended') void ctx.resume()
    },

    play(kind, strength = 1) {
      if (muted) return
      const ctx = ensure()
      if (!ctx) return
      const tones = TONES[kind]
      if (!tones) return
      for (const tone of tones) playTone(ctx, tone, strength)
    },

    setMuted(value) {
      muted = value
      if (master && context) master.gain.setTargetAtTime(value ? 0 : 0.85, context.currentTime, 0.05)
    },

    isMuted() {
      return muted
    },

    setLoop(kind, intensity) {
      const clamped = Math.max(0, Math.min(1.4, intensity))
      if (Math.abs(loopTargets[kind] - clamped) < 0.02) return
      loopTargets[kind] = clamped
      const loop = loopFor(kind)
      const ctx = context
      if (!loop || !ctx) return
      const target = kind === 'vacuum' ? clamped * 0.055 : clamped * 0.11
      loop.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.14)
      loop.filter.frequency.setTargetAtTime(
        kind === 'vacuum' ? 420 + clamped * 380 : 300 + clamped * 320,
        ctx.currentTime,
        0.2,
      )
    },

    stop() {
      for (const loop of loops) {
        try {
          loop.source.stop()
        } catch {
          /* already stopped */
        }
      }
      loops.length = 0
      if (context) void context.close()
      context = undefined
      master = undefined
      noiseBuffer = undefined
    },
  }
}
