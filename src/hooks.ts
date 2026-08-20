import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CloudStore } from './store'
import { normalizeError, type CloudSyncError } from './errors'
import type {
  AccountChangeEvent,
  AccountStatus,
  CloudProvider,
  OutboxEntry,
  RemoteChangeEvent,
} from './types'

/**
 * React bindings.
 *
 * A separate entry point (`react-native-cloud-sync/hooks`) so the main one
 * stays free of a React import - the store is usable from a saga, a background
 * task or a plain module, and none of those should pull in a renderer.
 *
 * These exist because every app was writing the same three of them, and each
 * one has the same two bugs: a response that arrives after the key changed
 * overwrites the newer one, and a `setState` after unmount. Both are handled
 * here once.
 */

export interface UseCloudItemResult<T> {
  value: T | null
  /** True until the first read settles, and during an explicit `refresh()`. */
  loading: boolean
  /** The last read or write failure, or null. Cleared by the next success. */
  error: CloudSyncError | null
  /** Writes through to the store and updates local state optimistically. */
  setValue: (next: T) => Promise<void>
  remove: () => Promise<void>
  /** Re-reads from the store. */
  refresh: () => Promise<void>
}

export interface UseCloudItemOptions<T> {
  /** Returned while loading, and when the key does not exist. Default null. */
  initialValue?: T | null
  /**
   * How the stored string becomes a `T`. Defaults to `JSON.parse`.
   *
   * Pass identity functions for a plain string value.
   */
  parse?: (raw: string) => T
  serialize?: (value: T) => string
  /**
   * Re-read when another device changes this key. Default true.
   *
   * This is the whole reason the store exposes `onRemoteChange`: without it a
   * screen shows whatever it read when it mounted, and the second device's edit
   * appears only after a manual pull-to-refresh.
   */
  watch?: boolean
}

/**
 * Binds one key to component state.
 *
 * ```tsx
 * const { value, setValue, loading } = useCloudItem<Settings>(store, 'settings')
 * ```
 */
export function useCloudItem<T = unknown>(
  store: CloudStore,
  key: string,
  options: UseCloudItemOptions<T> = {}
): UseCloudItemResult<T> {
  const {
    initialValue = null,
    parse = JSON.parse as (raw: string) => T,
    serialize = JSON.stringify as (value: T) => string,
    watch = true,
  } = options

  const [value, setLocalValue] = useState<T | null>(initialValue)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<CloudSyncError | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Increments on every read. A response whose ticket is stale - because the
   * key changed, or a refresh overtook it - is dropped instead of being written
   * into state, which is how these hooks usually end up showing another key's
   * value.
   */
  const ticket = useRef(0)

  // Held in a ref so `read` does not change identity every render and restart
  // the effect below on each one.
  const parseRef = useRef(parse)
  parseRef.current = parse

  const read = useCallback(async (): Promise<void> => {
    const mine = ticket.current + 1
    ticket.current = mine
    setLoading(true)

    try {
      const raw = await store.getItem(key)
      if (!mounted.current || ticket.current !== mine) return
      setLocalValue(raw == null ? null : parseRef.current(raw))
      setError(null)
    }
    catch (e) {
      if (!mounted.current || ticket.current !== mine) return
      // The value is deliberately left as-is rather than cleared: a failed read
      // is not evidence the key is gone, and blanking the screen on a network
      // blip is worse than showing what was last known alongside the error.
      setError(normalizeError(e))
    }
    finally {
      if (mounted.current && ticket.current === mine) setLoading(false)
    }
  }, [store, key])

  useEffect(() => {
    void read()
  }, [read])

  useEffect(() => {
    if (!watch) return
    return store.onRemoteChange((e) => {
      // An empty `keys` list means "something changed but the provider could
      // not say what" - an account or quota event. Re-read rather than assume
      // it was not us.
      if (e.keys.length > 0 && !e.keys.includes(key)) return
      void read()
    })
  }, [store, key, watch, read])

  const setValue = useCallback(async (next: T): Promise<void> => {
    // Optimistic: the store queues retryable failures, so the write usually
    // lands eventually even when this call rejects. Reverting on error would
    // discard a value the outbox is still going to deliver.
    setLocalValue(next)
    // Invalidate any read in flight, so its older answer cannot land on top.
    ticket.current += 1
    try {
      await store.setItem(key, serialize(next))
      if (mounted.current) setError(null)
    }
    catch (e) {
      if (mounted.current) setError(normalizeError(e))
      throw e
    }
  }, [store, key, serialize])

  const remove = useCallback(async (): Promise<void> => {
    setLocalValue(null)
    ticket.current += 1
    try {
      await store.removeItem(key)
      if (mounted.current) setError(null)
    }
    catch (e) {
      if (mounted.current) setError(normalizeError(e))
      throw e
    }
  }, [store, key])

  return { value, loading, error, setValue, remove, refresh: read }
}

export interface UseAccountStatusResult {
  status: AccountStatus | null
  /**
   * True once a *different* identity has signed in since this hook mounted.
   *
   * The signal to drop user-scoped caches. Latched rather than momentary, so a
   * screen that mounts just after the event still sees it.
   */
  identityChanged: boolean
  error: CloudSyncError | null
  refresh: () => Promise<void>
}

/**
 * Tracks a provider's account state, including the identity-switch event.
 *
 * ```tsx
 * const { status, identityChanged } = useAccountStatus(icloudKV)
 * if (status === 'noAccount') return <SignInPrompt />
 * ```
 */
export function useAccountStatus(provider: CloudProvider): UseAccountStatusResult {
  const [status, setStatus] = useState<AccountStatus | null>(null)
  const [identityChanged, setIdentityChanged] = useState(false)
  const [error, setError] = useState<CloudSyncError | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await provider.getAccountStatus()
      if (!mounted.current) return
      setStatus(next)
      setError(null)
    }
    catch (e) {
      if (mounted.current) setError(normalizeError(e))
    }
  }, [provider])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (provider.onAccountChange == null) return
    return provider.onAccountChange((e: AccountChangeEvent) => {
      setStatus(e.status)
      if (e.identityChanged) setIdentityChanged(true)
    })
  }, [provider])

  return { status, identityChanged, error, refresh }
}

export interface UsePendingWritesResult {
  pending: OutboxEntry[]
  /** Runs a flush now and refreshes the list. */
  flush: () => Promise<void>
  /** Abandons queued writes, then refreshes the list. */
  discard: (filter?: (e: OutboxEntry) => boolean) => void
}

/**
 * Drives a "pending sync" indicator.
 *
 * `pendingWrites()` is a synchronous read of a small JSON blob, so polling it
 * is cheap - and there is no event to subscribe to, because entries are added
 * from whichever call site failed rather than from one place that could emit.
 */
export function usePendingWrites(
  store: CloudStore,
  pollIntervalMs = 2000
): UsePendingWritesResult {
  const [pending, setPending] = useState<OutboxEntry[]>(() => store.pendingWrites())

  const sync = useCallback(() => {
    setPending(store.pendingWrites())
  }, [store])

  useEffect(() => {
    sync()
    if (pollIntervalMs <= 0) return
    const timer = setInterval(sync, pollIntervalMs)
    return () => clearInterval(timer)
  }, [sync, pollIntervalMs])

  const flush = useCallback(async (): Promise<void> => {
    try {
      await store.flushOutbox()
    }
    finally {
      // Refresh either way: a flush that partially failed still changed the
      // queue, and the indicator should show what is actually left.
      sync()
    }
  }, [store, sync])

  const discard = useCallback((filter?: (e: OutboxEntry) => boolean): void => {
    store.discardPendingWrites(filter)
    sync()
  }, [store, sync])

  return { pending, flush, discard }
}

/**
 * Subscribes to remote-change events for the life of the component.
 *
 * The listener is held in a ref, so passing an inline arrow function does not
 * tear down and rebuild the subscription on every render.
 */
export function useRemoteChange(
  store: CloudStore,
  listener: (e: RemoteChangeEvent) => void
): void {
  const ref = useRef(listener)
  ref.current = listener

  useEffect(() => store.onRemoteChange(e => ref.current(e)), [store])
}

/**
 * Per-provider storage usage, refreshed on demand.
 *
 * Not polled: `getQuota` is a network round trip per provider, and a number
 * that moves this slowly does not need watching.
 */
export function useQuota(store: CloudStore): {
  quota: Awaited<ReturnType<CloudStore['getQuota']>>
  loading: boolean
  refresh: () => Promise<void>
} {
  type Quota = Awaited<ReturnType<CloudStore['getQuota']>>
  const [quota, setQuota] = useState<Quota>([])
  const [loading, setLoading] = useState(false)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await store.getQuota()
      if (mounted.current) setQuota(next)
    }
    finally {
      if (mounted.current) setLoading(false)
    }
  }, [store])

  return useMemo(() => ({ quota, loading, refresh }), [quota, loading, refresh])
}
