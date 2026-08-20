import { AppState } from 'react-native'

import type { Unsubscribe } from '../types'

/**
 * When the store should try to drain its outbox by itself.
 *
 * A durable queue with no trigger is only half a feature: every retryable
 * failure is captured correctly and then sits there until the app remembers to
 * call `flushOutbox()`. Most apps wire that to the same two moments, so the
 * store can do it for them.
 *
 * Deliberately *not* network-aware. Detecting a reconnect needs
 * `@react-native-community/netinfo`, and taking a dependency on it to save one
 * line in the host app is a bad trade - it would be installed for every user of
 * this package whether or not they wanted it. Call `flushOutbox()` from your
 * own NetInfo listener for that; foreground plus a slow interval already covers
 * the common case, since an app that regained connectivity is nearly always
 * about to be foregrounded anyway.
 */
export interface AutoFlushConfig {
  /**
   * Flush when the app returns to the foreground. Default true.
   *
   * The single highest-value trigger: a write queued offline is most likely to
   * succeed the next time the user opens the app.
   */
  onForeground?: boolean
  /**
   * Also flush on this interval while the app is in the foreground. Default
   * 60000. Set 0 to disable.
   *
   * Backoff already governs *whether* an individual entry is retried, so this
   * only decides how often the queue is looked at; a tick with nothing due is
   * a synchronous read of a small JSON blob and no network at all.
   */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * Wires `flush` to app foreground and to a timer. Returns an unsubscribe.
 *
 * Failures are swallowed on purpose: this is a background retry nobody is
 * waiting on, and the store already reports every failure through `onError`
 * and `onDropped`. Letting a rejection escape a timer callback would surface as
 * an unhandled rejection warning for something the app deliberately deferred.
 */
export function attachAutoFlush(
  flush: () => Promise<unknown>,
  config: AutoFlushConfig = {}
): Unsubscribe {
  const onForeground = config.onForeground ?? true
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS

  const safeFlush = (): void => {
    void flush().catch(() => undefined)
  }

  let timer: ReturnType<typeof setInterval> | null = null
  let appStateSub: { remove: () => void } | null = null

  if (intervalMs > 0) {
    timer = setInterval(safeFlush, intervalMs)
    // A pending retry must never be the reason a process stays alive.
    timer.unref?.()
  }

  if (onForeground) {
    let previous = AppState.currentState
    appStateSub = AppState.addEventListener('change', (next) => {
      // Only the transition *into* active, not every state event - iOS emits
      // `inactive` on the way through, and flushing twice per foreground would
      // double the request rate for no benefit.
      if (next === 'active' && previous !== 'active') safeFlush()
      previous = next
    })
  }

  return () => {
    if (timer != null) clearInterval(timer)
    timer = null
    appStateSub?.remove()
    appStateSub = null
  }
}
