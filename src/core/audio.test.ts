// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioService, type SoundEvent } from './audio';
import { StorageService, type KeyValueStore } from './storage';

// The service is driven through its public API with a fake WebAudio graph. An
// implementation that still only knows start/blip/reset fails at
// play('reveal'), so these cases genuinely cover the new events.
class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface ParamEvent {
  readonly kind: 'set' | 'ramp';
  readonly value: number;
  readonly at: number;
}

class FakeParam {
  readonly events: ParamEvent[] = [];

  setValueAtTime(value: number, at: number): void {
    this.events.push({ kind: 'set', value, at });
  }

  exponentialRampToValueAtTime(value: number, at: number): void {
    this.events.push({ kind: 'ramp', value, at });
  }
}

class FakeOscillator {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam();

  connect(): void {}

  disconnect(): void {}

  addEventListener(): void {}

  start(): void {}

  stop(): void {}
}

class FakeGain {
  readonly gain = new FakeParam();

  connect(): void {}

  disconnect(): void {}
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];

  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly destination: unknown = {};
  state: AudioContextState = 'running';
  currentTime = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
}

const originalAudioContext = window.AudioContext;

beforeEach(() => {
  FakeAudioContext.instances.length = 0;
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: FakeAudioContext,
  });
});

afterEach(() => {
  if (originalAudioContext) {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: originalAudioContext,
    });
  } else {
    Reflect.deleteProperty(window, 'AudioContext');
  }
});

function createService(sound: 'on' | 'off' = 'on'): AudioService {
  const store = new MemoryStore();
  if (sound === 'off') {
    store.setItem('playground:v1:settings.sound', 'off');
  }
  return new AudioService(new StorageService(store));
}

function requireFirst<T>(values: readonly T[]): T {
  const [first] = values;
  if (first === undefined) {
    throw new Error('Expected at least one value');
  }
  return first;
}

function requireLast<T>(values: readonly T[]): T {
  const last = values.at(-1);
  if (last === undefined) {
    throw new Error('Expected at least one value');
  }
  return last;
}

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Expected a value at index ${index}`);
  }
  return value;
}

interface ToneSignature {
  readonly frequencies: readonly number[];
  readonly types: readonly OscillatorType[];
  readonly durations: readonly number[];
  readonly peakGains: readonly number[];
}

/** Play one event and read back the scheduled oscillators and envelopes. */
function capture(event: SoundEvent): ToneSignature {
  createService('on').play(event);
  const context = requireLast(FakeAudioContext.instances);
  return {
    frequencies: context.oscillators.map(
      (oscillator) => requireFirst(oscillator.frequency.events).value,
    ),
    types: context.oscillators.map((oscillator) => oscillator.type),
    durations: context.gains.map((gain) => {
      const events = gain.gain.events;
      return requireLast(events).at - requireFirst(events).at;
    }),
    peakGains: context.gains.map((gain) =>
      Math.max(...gain.gain.events.map((event) => event.value)),
    ),
  };
}

function durationOf(signature: ToneSignature): number {
  return requireFirst(signature.durations);
}

function peakGainOf(signature: ToneSignature): number {
  return Math.max(...signature.peakGains);
}

describe('AudioService mute gate', () => {
  it('does not create an AudioContext when sound is persisted off', () => {
    const audio = createService('off');

    expect(() => {
      audio.play('reveal');
      audio.play('mine');
    }).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('does not create nodes when disabled before the first sound', () => {
    const audio = createService();
    audio.setEnabled(false);

    expect(() => audio.play('flag')).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('stops scheduling nodes after setEnabled(false)', () => {
    const audio = createService();
    audio.play('blip');
    const context = requireLast(FakeAudioContext.instances);
    const oscillators = context.oscillators.length;
    const gains = context.gains.length;
    expect(oscillators).toBe(1);

    audio.setEnabled(false);

    expect(() => {
      audio.play('reveal');
      audio.play('win');
    }).not.toThrow();
    expect(context.oscillators).toHaveLength(oscillators);
    expect(context.gains).toHaveLength(gains);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});

describe('Minesweeper sound events', () => {
  it('schedules four distinct tones', () => {
    const signatures = (['reveal', 'flag', 'win', 'mine'] as const).map((event) => capture(event));
    const unique = new Set(signatures.map((signature) => JSON.stringify(signature)));

    expect(unique.size).toBe(4);
  });

  it('keeps the reveal light and the flag very short', () => {
    const reveal = capture('reveal');
    const flag = capture('flag');

    expect(reveal.frequencies).toHaveLength(1);
    expect(durationOf(flag)).toBeLessThan(durationOf(reveal));
    expect(peakGainOf(reveal)).toBeLessThan(peakGainOf(capture('win')));
    expect(peakGainOf(reveal)).toBeLessThan(peakGainOf(capture('mine')));
  });

  it('runs the win tone upwards', () => {
    const { frequencies } = capture('win');

    expect(frequencies.length).toBeGreaterThan(1);
    for (let index = 1; index < frequencies.length; index += 1) {
      expect(valueAt(frequencies, index)).toBeGreaterThan(valueAt(frequencies, index - 1));
    }
  });

  it('runs the mine tone downwards', () => {
    const { frequencies } = capture('mine');

    expect(frequencies.length).toBeGreaterThan(1);
    for (let index = 1; index < frequencies.length; index += 1) {
      expect(valueAt(frequencies, index)).toBeLessThan(valueAt(frequencies, index - 1));
    }
  });
});

describe('Existing sound events', () => {
  it('keeps start, blip and reset unchanged', () => {
    expect(capture('start')).toEqual({
      frequencies: [392, 523],
      types: ['triangle', 'triangle'],
      durations: [0.12, 0.12],
      peakGains: [0.06, 0.06],
    });
    expect(capture('blip')).toEqual({
      frequencies: [660],
      types: ['sine'],
      durations: [0.06],
      peakGains: [0.04],
    });
    expect(capture('reset')).toEqual({
      frequencies: [523, 392],
      types: ['triangle', 'triangle'],
      durations: [0.1, 0.1],
      peakGains: [0.05, 0.05],
    });
  });
});
