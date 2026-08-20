import { cancelled, timedOut } from '../errors'

/**
 * Rejects with {@link ErrorCode.TIMEOUT} if `promise` has not settled in time.
 *
 * React Native's `fetch` has no default timeout, and neither does CloudKit's
 * native stack, so an unanswered socket hangs an operation forever. That is
 * worse than an error: the store calls `isAvailable()` before every operation,
 * so one hung probe stalls reads and writes that would otherwise have fallen
 * through to a working provider.
 *
 * The underlying work is *not* cancelled - a promise cannot be. This only stops
 * the caller waiting on it, which is why the timeout error is classified as
 * retryable rather than as a failure.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, provider?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timedOut(ms, provider)), ms)

    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * The subset of `AbortSignal` this package needs.
 *
 * Typed structurally rather than as the DOM `AbortSignal` so a caller can pass
 * one from any polyfill, and so the package does not require `lib.dom` to be in
 * a consumer's `tsconfig`.
 */
export interface AbortLike {
  readonly aborted: boolean
  addEventListener: (type: 'abort', listener: () => void) => void
  removeEventListener: (type: 'abort', listener: () => void) => void
}

/** Throws {@link ErrorCode.CANCELLED} if the signal is already aborted. */
export function throwIfAborted(signal: AbortLike | undefined, provider?: string): void {
  if (signal?.aborted === true) throw cancelled(provider)
}

/**
 * Races `promise` against an abort signal.
 *
 * Used by the chunked transfer paths, where "cancel" has to take effect between
 * chunks rather than only once the whole multi-hundred-megabyte file has moved.
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortLike | undefined,
  provider?: string
): Promise<T> {
  if (signal == null) return promise
  if (signal.aborted) return Promise.reject(cancelled(provider))

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled(provider))
    signal.addEventListener('abort', onAbort)

    const done = (): void => signal.removeEventListener('abort', onAbort)
    promise.then(
      (value) => {
        done()
        resolve(value)
      },
      (error: Error) => {
        done()
        reject(error)
      }
    )
  })
}
