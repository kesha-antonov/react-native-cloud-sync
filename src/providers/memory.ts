import { CloudSyncError, ErrorCode } from '../errors'
import type {
  AccountChangeEvent,
  AccountStatus,
  CloudProvider,
  RemoteChangeEvent,
  Unsubscribe,
} from '../types'

const NAME = 'memory' as const

export type FaultOp = 'getItem' | 'setItem' | 'removeItem' | 'getAllKeys' | 'getAccountStatus'

/** Epoch millis stamped on every write, so `getItemWithMeta` has something real to report. */
interface Entry {
  value: string
  modifiedAt: number
}

export interface Fault {
  code: ErrorCode
  message?: string
  retryAfterMs?: number
  limitBytes?: number
  actualBytes?: number
  serverValue?: string | null
  /**
   * Fail only this many times, then succeed. Useful for asserting that retry and
   * outbox logic converges instead of looping.
   */
  times?: number
  /**
   * Fail only for keys this returns true for. Defaults to every key.
   *
   * Real backends fail per record, not per operation - one oversized or
   * conflicting key while the rest of a batch goes through. Scoping a fault to
   * a key is also what makes interleaving tests deterministic, since two
   * operations in flight no longer compete for the same `times` budget.
   */
  only?: (key: string) => boolean
}

export interface MemoryProviderOptions {
  /** Seed data the provider starts with. */
  initial?: Record<string, string>
  /** Per-operation failures to inject. */
  faults?: Partial<Record<FaultOp, Fault>>
  /** Account status reported by `getAccountStatus`. Defaults to `available`. */
  accountStatus?: AccountStatus
  /** Artificial delay in ms applied to every operation. */
  latencyMs?: number
  /**
   * What `isAvailable()` reports. Defaults to true.
   *
   * Set false to reproduce the signed-out fleet - the case where the store must
   * refuse to answer a read rather than resolving `null`, because `null` there
   * reads as "no backup exists" and the documented first-launch recipe seeds
   * empty state over the user's real data.
   */
  available?: boolean
  /** A name other than `'memory'`, for tests that need two distinct doubles. */
  name?: string
  /** Quota reported by `getQuota()`. Omitted means the provider reports none. */
  quota?: { usedBytes?: number; totalBytes?: number }
}

/** A provider name other than the four built in. Used to type custom doubles. */
export type MemoryProviderName = string

export interface MemoryProvider extends CloudProvider {
  /** Direct read of the backing map, bypassing fault injection. */
  dump: () => Record<string, string>
  /** Replace the backing data without going through `setItem`. */
  seed: (data: Record<string, string>) => void
  /** Clear data, faults and listeners. */
  reset: () => void
  /** Install or replace a fault at runtime. */
  setFault: (op: FaultOp, fault: Fault | null) => void
  /** Fire a remote-change event, as if another device had written. */
  emitRemoteChange: (e: Partial<RemoteChangeEvent>) => void
  /** Fire an account-change event, including the identity-switch case. */
  emitAccountChange: (e: Partial<AccountChangeEvent>) => void
  /** Flip what `isAvailable()` reports, to simulate signing out mid-session. */
  setAvailable: (value: boolean) => void
  /** How many times each operation has been called. */
  readonly calls: Readonly<Record<FaultOp, number>>
  /** How many times the store asked this provider to drop cached state. */
  readonly cacheClears: number
}

/**
 * An in-memory provider with fault injection.
 *
 * This exists because cloud storage is the hardest thing in a mobile app to test
 * honestly. iCloud on the simulator is unreliable enough that the most-used
 * library in this space gave up on it publicly - "We've therefore stopped
 * testing the library on the simulator and test on a real device only and would
 * encourage users to do the same." Real-device-only testing means the failure
 * paths that matter most (signed out, offline, quota exceeded, rate limited,
 * account switched mid-session) are effectively never exercised.
 *
 * So they are exercised here instead, deterministically, in Jest. This is
 * exported from the package entry (`react-native-cloud-sync/testing`)
 * rather than buried in source, so it is usable without reaching into internals.
 */
export function createMemoryProvider(options: MemoryProviderOptions = {}): MemoryProvider {
  const NAME_FOR_THIS = options.name ?? NAME

  function seedEntries(record: Record<string, string>): Map<string, Entry> {
    const now = Date.now()
    return new Map(Object.entries(record).map(([k, v]) => [k, { value: v, modifiedAt: now }]))
  }

  let data = seedEntries(options.initial ?? {})
  let faults: Partial<Record<FaultOp, Fault>> = { ...options.faults }
  let accountStatus: AccountStatus = options.accountStatus ?? 'available'
  let available = options.available ?? true
  let cacheClears = 0
  const latencyMs = options.latencyMs ?? 0

  const remoteListeners = new Set<(e: RemoteChangeEvent) => void>()
  const accountListeners = new Set<(e: AccountChangeEvent) => void>()

  const calls: Record<FaultOp, number> = {
    getItem: 0,
    setItem: 0,
    removeItem: 0,
    getAllKeys: 0,
    getAccountStatus: 0,
  }

  const remaining = new Map<FaultOp, number>()

  /**
   * `keys` is what the operation touches, so a fault can be scoped to one of
   * them. A batch fails if the fault matches any key in it, matching how a real
   * backend rejects a whole atomic batch for one bad record.
   */
  async function gate(op: FaultOp, keys: string[] = []): Promise<void> {
    calls[op] += 1

    if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs))

    const fault = faults[op]
    if (fault == null) return
    if (fault.only != null && !keys.some(k => fault.only!(k))) return

    if (fault.times != null) {
      const left = remaining.get(op) ?? fault.times
      if (left <= 0) return
      remaining.set(op, left - 1)
    }

    throw new CloudSyncError(
      fault.code,
      fault.message ?? `[RNCloudSync] Injected ${fault.code} on ${op}`,
      {
        provider: NAME_FOR_THIS,
        retryAfterMs: fault.retryAfterMs,
        limitBytes: fault.limitBytes,
        actualBytes: fault.actualBytes,
        serverValue: fault.serverValue,
      }
    )
  }

  return {
    name: NAME_FOR_THIS,

    isAvailable: () => Promise.resolve(available),

    getAccountStatus: async () => {
      await gate('getAccountStatus')
      return accountStatus
    },

    getItem: async (key: string) => {
      await gate('getItem', [key])
      return data.get(key)?.value ?? null
    },

    // Implemented so the store's metadata-aware read path, and the resolver
    // that orders on server time rather than on a timestamp the app embedded,
    // are exercised by something other than a network provider.
    getItemWithMeta: async (key: string) => {
      await gate('getItem', [key])
      const entry = data.get(key)
      return entry == null ? null : { value: entry.value, modifiedAt: entry.modifiedAt }
    },

    setItem: async (key: string, value: string) => {
      await gate('setItem', [key])
      data.set(key, { value, modifiedAt: Date.now() })
    },

    removeItem: async (key: string) => {
      await gate('removeItem', [key])
      data.delete(key)
    },

    getAllKeys: async () => {
      await gate('getAllKeys')
      return [...data.keys()]
    },

    // One `gate` call per batch, not per key - so a test can assert that the
    // store really batched instead of looping.
    multiGet: async (keys: string[]) => {
      await gate('getItem', keys)
      return keys.map(k => data.get(k)?.value ?? null)
    },

    multiSet: async (entries: [string, string][]) => {
      await gate('setItem', entries.map(([k]) => k))
      const now = Date.now()
      for (const [key, value] of entries) data.set(key, { value, modifiedAt: now })
    },

    multiRemove: async (keys: string[]) => {
      await gate('removeItem', keys)
      for (const key of keys) data.delete(key)
    },

    getQuota: () =>
      Promise.resolve(
        options.quota == null
          ? null
          : { ...options.quota, provider: NAME_FOR_THIS }
      ),

    clearCaches: () => {
      cacheClears += 1
    },

    onRemoteChange: (listener): Unsubscribe => {
      remoteListeners.add(listener)
      return () => remoteListeners.delete(listener)
    },

    onAccountChange: (listener): Unsubscribe => {
      accountListeners.add(listener)
      return () => accountListeners.delete(listener)
    },

    dump: () => Object.fromEntries([...data].map(([k, e]) => [k, e.value])),

    seed: (next: Record<string, string>) => {
      data = seedEntries(next)
    },

    reset: () => {
      data = new Map()
      faults = {}
      remaining.clear()
      remoteListeners.clear()
      accountListeners.clear()
      accountStatus = 'available'
      available = options.available ?? true
      cacheClears = 0
      for (const k of Object.keys(calls) as FaultOp[]) calls[k] = 0
    },

    setAvailable: (value: boolean) => {
      available = value
    },

    setFault: (op: FaultOp, fault: Fault | null) => {
      if (fault == null) {
        delete faults[op]
        remaining.delete(op)
        return
      }
      faults[op] = fault
      remaining.delete(op)
    },

    emitRemoteChange: (e) => {
      const event: RemoteChangeEvent = {
        keys: e.keys ?? [],
        reason: e.reason ?? 'serverChange',
        provider: NAME_FOR_THIS,
      }
      for (const l of remoteListeners) l(event)
    },

    emitAccountChange: (e) => {
      if (e.status != null) accountStatus = e.status
      const event: AccountChangeEvent = {
        status: e.status ?? accountStatus,
        identityChanged: e.identityChanged ?? false,
        provider: NAME_FOR_THIS,
      }
      for (const l of accountListeners) l(event)
    },

    calls,

    get cacheClears() {
      return cacheClears
    },
  }
}
