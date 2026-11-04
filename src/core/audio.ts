import type { StorageService } from './storage';

export type SoundEvent = 'start' | 'eat' | 'die' | 'win' | 'pause';

interface Tone {
  readonly frequencies: readonly number[];
  readonly duration: number;
  readonly type: OscillatorType;
  readonly gain: number;
}

const TONES: Readonly<Record<SoundEvent, Tone>> = {
  start: { frequencies: [392, 523], duration: 0.12, type: 'triangle', gain: 0.06 },
  eat: { frequencies: [660, 990], duration: 0.09, type: 'square', gain: 0.05 },
  die: { frequencies: [220, 165, 110], duration: 0.16, type: 'sawtooth', gain: 0.06 },
  win: { frequencies: [523, 659, 784, 1047], duration: 0.11, type: 'triangle', gain: 0.06 },
  pause: { frequencies: [330, 262], duration: 0.08, type: 'sine', gain: 0.04 },
};

const SOUND_KEY = 'settings.sound';

/**
 * Tiny synthesised sound bus. No audio assets are downloaded: short WebAudio
 * blips keep the package small and the game playable offline.
 */
export class AudioService {
  private readonly storage: StorageService;
  private context: AudioContext | null = null;
  private enabledState: boolean;

  constructor(storage: StorageService) {
    this.storage = storage;
    this.enabledState = storage.getString(SOUND_KEY, 'on') !== 'off';
  }

  get enabled(): boolean {
    return this.enabledState;
  }

  setEnabled(enabled: boolean): void {
    this.enabledState = enabled;
    this.storage.set(SOUND_KEY, enabled ? 'on' : 'off');
    if (enabled) {
      this.unlock();
    }
  }

  toggle(): boolean {
    this.setEnabled(!this.enabledState);
    return this.enabledState;
  }

  /** Browsers only allow audio after a user gesture; call from a real event. */
  unlock(): void {
    if (!this.enabledState) {
      return;
    }
    const context = this.ensureContext();
    if (context && context.state === 'suspended') {
      void context.resume().catch(() => undefined);
    }
  }

  play(event: SoundEvent): void {
    if (!this.enabledState) {
      return;
    }
    const context = this.ensureContext();
    if (!context || context.state === 'closed') {
      return;
    }
    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined);
    }

    const tone = TONES[event];
    const start = context.currentTime;
    tone.frequencies.forEach((frequency, index) => {
      const at = start + index * tone.duration;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(tone.gain, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.duration + 0.02);
    });
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      return this.context;
    }
    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    try {
      this.context = new AudioContextCtor();
      return this.context;
    } catch {
      return null;
    }
  }
}
