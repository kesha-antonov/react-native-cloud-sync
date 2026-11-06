/**
 * Writes `key` as an own, enumerable data property of `target`.
 *
 * A plain `target[key] = value` goes through the `__proto__` accessor when the
 * key is literally `"__proto__"`: an object value silently becomes the
 * record's prototype (so every other lookup on it starts answering from data a
 * remote device wrote) and a string value is dropped. Keys here come from
 * listings and from app-supplied key lists, so neither outcome is acceptable.
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** `Object.hasOwn`, which Hermes and older JSC do not all ship. */
export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/**
 * Upper bound on any server-supplied retry delay.
 *
 * `Retry-After` and CloudKit's `retryAfter` are honoured, but not blindly: a
 * huge value (or a hostile/broken proxy in front of the API) would otherwise
 * park a queued write until it expired, and a negative one would retry in a
 * tight loop.
 */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000

/** A server retry hint in ms, clamped to `[0, MAX_RETRY_AFTER_MS]`, or undefined. */
export function clampRetryAfterMs(ms: number | undefined): number | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS)
}
