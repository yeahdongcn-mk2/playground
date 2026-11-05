import type { StorageService } from './storage';

export type SoundEvent = 'start' | 'blip' | 'reset';

interface Tone {
  readonly frequencies: readonly number[];
  readonly duration: number;
  readonly type: OscillatorType;
  readonly gain: number;
}

const TONES: Readonly<Record<SoundEvent, Tone>> = {
  start: { frequencies: [392, 523], duration: 0.12, type: 'triangle', gain: 0.06 },
  blip: { frequencies: [660], duration: 0.06, type: 'sine', gain: 0.04 },
  reset: { frequencies: [523, 392], duration: 0.1, type: 'triangle', gain: 0.05 },
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
    // `settings.sound=off` is stored as the string "off" by older clients.
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
      const envelope = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(frequency, at);
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(tone.gain, at + 0.01);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + tone.duration);
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.duration + 0.02);
      oscillator.addEventListener('ended', () => {
        oscillator.disconnect();
        envelope.disconnect();
      });
    });
  }

  private ensureContext(): AudioContext | null {
    if (this.context && this.context.state !== 'closed') {
      return this.context;
    }
    try {
      const Ctor = window.AudioContext;
      if (!Ctor) {
        return null;
      }
      this.context = new Ctor();
      return this.context;
    } catch {
      return null;
    }
  }
}
