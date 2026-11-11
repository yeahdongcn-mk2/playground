export interface BlankReadoutSample {
  x: number;
  y: number;
  trail: number;
}

export interface BlankPointerTarget {
  x: number;
  y: number;
}

export const BLANK_TARGET_TOLERANCE: number;
export const BLANK_STABLE_SAMPLES: number;

export function isBlankAtTarget(
  sample: BlankReadoutSample,
  target: BlankPointerTarget,
  tolerance?: number,
): boolean;

export function nextBlankStableStreak(
  streak: number,
  sample: BlankReadoutSample,
  target: BlankPointerTarget,
  options?: { required?: number; tolerance?: number },
): number;
