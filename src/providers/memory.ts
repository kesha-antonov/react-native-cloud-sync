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
}

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
  /** How many times each operation has been called. */
  readonly calls: Readonly<Record<FaultOp, number>>
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
  let data = new Map<string, string>(Object.entries(options.initial ?? {}))
  let faults: Partial<Record<FaultOp, Fault>> = { ...options.faults }
  let accountStatus: AccountStatus = options.accountStatus ?? 'available'
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

  async function gate(op: FaultOp): Promise<void> {
    calls[op] += 1

    if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs))

    const fault = faults[op]
    if (fault == null) return

    if (fault.times != null) {
      const left = remaining.get(op) ?? fault.times
      if (left <= 0) return
      remaining.set(op, left - 1)
    }

    throw new CloudSyncError(
      fault.code,
      fault.message ?? `[RNCloudSync] Injected ${fault.code} on ${op}`,
      {
        provider: NAME,
        retryAfterMs: fault.retryAfterMs,
        limitBytes: fault.limitBytes,
        actualBytes: fault.actualBytes,
        serverValue: fault.serverValue,
      }
    )
  }

  return {
    name: NAME,

    isAvailable: () => Promise.resolve(true),

    getAccountStatus: async () => {
      await gate('getAccountStatus')
      return accountStatus
    },

    getItem: async (key: string) => {
      await gate('getItem')
      return data.get(key) ?? null
    },

    setItem: async (key: string, value: string) => {
      await gate('setItem')
      data.set(key, value)
    },

    removeItem: async (key: string) => {
      await gate('removeItem')
      data.delete(key)
    },

    getAllKeys: async () => {
      await gate('getAllKeys')
      return [...data.keys()]
    },

    onRemoteChange: (listener): Unsubscribe => {
      remoteListeners.add(listener)
      return () => remoteListeners.delete(listener)
    },

    onAccountChange: (listener): Unsubscribe => {
      accountListeners.add(listener)
      return () => accountListeners.delete(listener)
    },

    dump: () => Object.fromEntries(data),

    seed: (next: Record<string, string>) => {
      data = new Map(Object.entries(next))
    },

    reset: () => {
      data = new Map()
      faults = {}
      remaining.clear()
      remoteListeners.clear()
      accountListeners.clear()
      accountStatus = 'available'
      for (const k of Object.keys(calls) as FaultOp[]) calls[k] = 0
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
        provider: NAME,
      }
      for (const l of remoteListeners) l(event)
    },

    emitAccountChange: (e) => {
      if (e.status != null) accountStatus = e.status
      const event: AccountChangeEvent = {
        status: e.status ?? accountStatus,
        identityChanged: e.identityChanged ?? false,
        provider: NAME,
      }
      for (const l of accountListeners) l(event)
    },

    calls,
  }
}
