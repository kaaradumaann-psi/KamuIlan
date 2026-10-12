/** Zaman kaynağı — testlerde sahte saat enjekte edilebilir. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function nowIso(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

export function isoFrom(value: Date | string): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

export function addMilliseconds(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return addMilliseconds(iso, minutes * 60_000);
}

export function addHours(iso: string, hours: number): string {
  return addMilliseconds(iso, hours * 3_600_000);
}

/** Basit deterministik sahte saat. */
export function fixedClock(start: Date = new Date('2026-10-12T09:00:00.000Z')): Clock & { advance(ms: number): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
