/**
 * A small random delay added on top of a fixed polling interval.
 *
 * Every instance of this app that started around the same moment would
 * otherwise probe the same endpoints on the same clock tick forever, a
 * pattern no polled interval needs to be exact about. `spread` widens the
 * interval by up to that many ms; it never shortens it, so this never polls
 * more often than the base interval intends.
 */
export function withJitter(
  delay: number,
  spread: number,
  rand: () => number = Math.random,
): number {
  return delay + Math.floor(rand() * spread);
}
