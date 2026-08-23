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

export interface UseCloudItemsResult<T> {
  /**
   * Parsed value per key. A key mapped to `null` was fetched and does not
   * exist; a key absent from this object has not been fetched yet.
   */
  values: Record<string, T | null>
  /** True only during the initial fetch of `keys`, and during an explicit `refresh()`. */
  loading: boolean
  /** The last read or write failure, or null. Cleared by the next success. */
  error: CloudSyncError | null
  /** Writes through to the store and updates local state optimistically. */
  setValue: (key: string, next: T) => Promise<void>
  remove: (key: string) => Promise<void>
  /** Re-fetches every key currently tracked. */
  refresh: () => Promise<void>
}

export interface UseCloudItemsOptions<T> {
  parse?: (raw: string) => T
  serialize?: (value: T) => string
  /**
   * Re-fetch a key when another device changes it. Default true.
   *
   * An event naming no keys (an account or quota event) re-fetches every
   * tracked key, same as `useCloudItem`.
   */
  watch?: boolean
}

/**
 * Binds a list of keys to component state with one batched `multiGet`.
 *
 * The multi-key sibling of `useCloudItem` - a screen with many cloud-backed
 * records (a list, one key per item) otherwise ends up calling `useCloudItem`
 * once per row: one `getItem` and one `onRemoteChange` subscription each,
 * instead of a single batched read.
 *
 * Only ever fetches keys it does not already hold an answer for. Mount,
 * `refresh()`, and a matching remote-change event all fetch normally, but a
 * key merely joining the tracked list - because a caller like
 * `useCloudCollection` just added it after a local write - is never
 * re-fetched on that account alone, so a slow fetch elsewhere in the list
 * can't land a stale value on top of a write that already resolved locally.
 *
 * ```tsx
 * const { values, setValue } = useCloudItems<Note>(store, noteIds)
 * ```
 */
export function useCloudItems<T = unknown>(
  store: CloudStore,
  keys: string[],
  options: UseCloudItemsOptions<T> = {}
): UseCloudItemsResult<T> {
  const {
    parse = JSON.parse as (raw: string) => T,
    serialize = JSON.stringify as (value: T) => string,
    watch = true,
  } = options

  const [values, setValuesState] = useState<Record<string, T | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<CloudSyncError | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const parseRef = useRef(parse)
  parseRef.current = parse

  const keysRef = useRef(keys)
  keysRef.current = keys
  const keysSignature = JSON.stringify(keys)

  // Latest values alongside the state, so effects can read "do we already
  // have this key" without taking `values` itself as a dependency.
  const valuesRef = useRef<Record<string, T | null>>(values)
  const setValues = useCallback(
    (updater: (prev: Record<string, T | null>) => Record<string, T | null>): void => {
      setValuesState((prev) => {
        const next = updater(prev)
        valuesRef.current = next
        return next
      })
    },
    []
  )

  // Per-key ticket, not one shared counter: two fetches for disjoint keys
  // run concurrently (an initial load still in flight plus a remote event for
  // a key that just appeared), and a shared ticket would let the second
  // invalidate the first's unrelated result.
  const keyTicket = useRef<Map<string, number>>(new Map())
  const bump = (key: string): number => {
    const next = (keyTicket.current.get(key) ?? 0) + 1
    keyTicket.current.set(key, next)
    return next
  }

  const fetchKeys = useCallback(async (toFetch: string[]): Promise<void> => {
    if (toFetch.length === 0) return
    const mine = new Map(toFetch.map(k => [k, bump(k)]))

    try {
      const pairs = await store.multiGet(toFetch)
      if (!mounted.current) return
      setValues((prev) => {
        const next = { ...prev }
        for (const [k, raw] of pairs) {
          // A write or a newer fetch already claimed this key - this answer
          // is no longer the current one.
          if (keyTicket.current.get(k) !== mine.get(k)) continue
          next[k] = raw == null ? null : parseRef.current(raw)
        }
        return next
      })
      setError(null)
    }
    catch (e) {
      if (!mounted.current) return
      // Only surface the failure if at least one of these keys is still
      // uncontested - a fetch overtaken by a write or another fetch failing
      // is not new information.
      const stillCurrent = toFetch.some(k => keyTicket.current.get(k) === mine.get(k))
      if (stillCurrent) setError(normalizeError(e))
    }
  }, [store, setValues])

  // Fetches keys new to the tracked list and drops values for keys no longer
  // in it. Doubles as the initial load: on mount every key is "missing".
  const hasLoadedOnce = useRef(false)
  useEffect(() => {
    const current = keysRef.current
    const missing = current.filter(k => !(k in valuesRef.current))

    const keep = new Set(current)
    setValues((prev) => {
      let changed = false
      const next: Record<string, T | null> = {}
      for (const k of Object.keys(prev))
        if (keep.has(k)) next[k] = prev[k]
        else changed = true

      return changed ? next : prev
    })

    if (!hasLoadedOnce.current) {
      hasLoadedOnce.current = true
      setLoading(true)
      void fetchKeys(missing).finally(() => {
        if (mounted.current) setLoading(false)
      })
    }
    else if (missing.length > 0) {
      void fetchKeys(missing)
    }
  }, [keysSignature, fetchKeys, setValues])

  useEffect(() => {
    if (!watch) return
    return store.onRemoteChange((e) => {
      if (e.keys.length === 0) {
        void fetchKeys(keysRef.current)
        return
      }
      const intersecting = e.keys.filter(k => keysRef.current.includes(k))
      if (intersecting.length > 0) void fetchKeys(intersecting)
    })
  }, [store, watch, fetchKeys])

  const setValue = useCallback(async (key: string, next: T): Promise<void> => {
    bump(key)
    setValues(prev => ({ ...prev, [key]: next }))
    try {
      await store.setItem(key, serialize(next))
      if (mounted.current) setError(null)
    }
    catch (e) {
      if (mounted.current) setError(normalizeError(e))
      throw e
    }
  }, [store, serialize, setValues])

  const remove = useCallback(async (key: string): Promise<void> => {
    bump(key)
    setValues(prev => ({ ...prev, [key]: null }))
    try {
      await store.removeItem(key)
      if (mounted.current) setError(null)
    }
    catch (e) {
      if (mounted.current) setError(normalizeError(e))
      throw e
    }
  }, [store, setValues])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      await fetchKeys(keysRef.current)
    }
    finally {
      if (mounted.current) setLoading(false)
    }
  }, [fetchKeys])

  return { values, loading, error, setValue, remove, refresh }
}

export interface UseCloudCollectionResult<T> extends UseCloudItemsResult<T> {
  /** Keys currently in the collection. */
  keys: string[]
}

/**
 * Live-binds every key starting with `prefix` to component state.
 *
 * Adds the membership index `useCloudItems` needs but does not derive
 * itself: `getAllKeys()` filtered by prefix on mount and after any remote
 * change that could plausibly have added or removed a member, then
 * `useCloudItems` for the values.
 *
 * A `setValue` for a key not seen before joins the collection immediately -
 * a newly created record should appear in its own list without waiting on a
 * round trip to confirm it.
 *
 * ```tsx
 * const { keys, values, setValue, remove } = useCloudCollection<Note>(store, 'note:')
 * ```
 */
export function useCloudCollection<T = unknown>(
  store: CloudStore,
  prefix: string,
  options: UseCloudItemsOptions<T> = {}
): UseCloudCollectionResult<T> {
  const { watch = true } = options

  const [keys, setKeys] = useState<string[]>([])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const listKeys = useCallback(async (): Promise<void> => {
    const all = await store.getAllKeys()
    if (!mounted.current) return
    setKeys(all.filter(k => k.startsWith(prefix)))
  }, [store, prefix])

  useEffect(() => {
    void listKeys()
  }, [listKeys])

  useEffect(() => {
    if (!watch) return
    return store.onRemoteChange((e) => {
      // A prefix collection can gain or lose members on another device, not
      // just change the value of one already in it - re-list on an opaque
      // event too, not only one that names a key under this prefix.
      if (e.keys.length > 0 && !e.keys.some(k => k.startsWith(prefix))) return
      void listKeys()
    })
  }, [store, prefix, watch, listKeys])

  const items = useCloudItems<T>(store, keys, options)

  const setValue = useCallback(async (key: string, next: T): Promise<void> => {
    if (key.startsWith(prefix)) setKeys(prev => (prev.includes(key) ? prev : [...prev, key]))
    await items.setValue(key, next)
  }, [items, prefix])

  const remove = useCallback(async (key: string): Promise<void> => {
    await items.remove(key)
    setKeys(prev => (prev.includes(key) ? prev.filter(k => k !== key) : prev))
  }, [items])

  const refresh = useCallback(async (): Promise<void> => {
    // Concurrent, not sequential: a key that only `listKeys` turns up gets
    // its value shortly after anyway, through the same membership-diff
    // effect that handles a live remote event, so there is nothing to gain
    // from waiting for the listing before starting `items.refresh()`.
    await Promise.all([listKeys(), items.refresh()])
  }, [listKeys, items])

  return { ...items, setValue, remove, refresh, keys }
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
