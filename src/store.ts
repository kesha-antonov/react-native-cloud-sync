import { icloudKV } from './providers/icloudKV'
import { cloudKit } from './providers/cloudKit'
import { googleDrive } from './providers/googleDrive'
import { byteLength } from './internal/cloudKitRest'
import { CloudStorageError, ErrorCode, isRetryable, normalizeError } from './errors'
import {
  DEFAULT_TIERING,
  type CloudProvider,
  type CloudStoreOptions,
  type OutboxEntry,
  type ProviderName,
  type TieringConfig,
} from './types'

/**
 * A durable place to park failed writes.
 *
 * Defaults to memory, which is honest but loses the queue on app restart. Pass
 * an MMKV- or AsyncStorage-backed adapter in production so an offline write
 * survives being killed - that is the whole point of the outbox.
 */
export interface OutboxStorage {
  getString: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
}

const OUTBOX_KEY = 'rncs.outbox.v1'

const BUILT_IN: Record<Exclude<ProviderName, 'memory'>, CloudProvider> = {
  icloudKV,
  cloudKit,
  googleDrive,
}

export interface CloudStore {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  getAllKeys: () => Promise<string[]>
  /** Copies every key from one provider to another. Does not delete the source. */
  migrate: (opts: { from: ProviderName; to: ProviderName }) => Promise<{ copied: string[] }>
  /** Attempts to drain queued writes. Safe to call on reconnect or foreground. */
  flushOutbox: () => Promise<{ drained: number; remaining: number }>
  /** Entries still waiting, for surfacing a "pending sync" indicator. */
  pendingWrites: () => OutboxEntry[]
  /** Registers an extra provider (e.g. the in-memory test double). */
  registerProvider: (provider: CloudProvider) => void
}

export function createCloudStore(
  options: CloudStoreOptions & { outboxStorage?: OutboxStorage }
): CloudStore {
  const custom = new Map<string, CloudProvider>()
  const useOutbox = options.outbox ?? true
  const storage: OutboxStorage = options.outboxStorage ?? createMemoryOutboxStorage()

  const tiering: TieringConfig | null
    = options.tiering === 'off'
      ? null
      : options.tiering === 'auto' || options.tiering == null
        ? DEFAULT_TIERING
        : options.tiering

  function resolve(name: ProviderName): CloudProvider {
    const found = custom.get(name) ?? (BUILT_IN as Record<string, CloudProvider>)[name]
    if (found == null)
      throw new CloudStorageError(
        ErrorCode.CONTAINER_MISCONFIGURED,
        `[RNCloudStorage] Unknown provider '${name}'. Register it with registerProvider() first.`
      )

    return found
  }

  /** First configured+available provider, in the caller's preference order. */
  async function primary(): Promise<CloudProvider> {
    for (const name of options.providers) {
      const p = resolve(name)
      if (await p.isAvailable()) return p
    }
    throw new CloudStorageError(
      ErrorCode.NOT_SIGNED_IN,
      `[RNCloudStorage] None of the configured providers (${options.providers.join(', ')}) `
      + `is currently available.`
    )
  }

  function readOutbox(): OutboxEntry[] {
    const raw = storage.getString(OUTBOX_KEY)
    if (raw == null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : []
    }
    catch {
      return []
    }
  }

  function writeOutbox(entries: OutboxEntry[]): void {
    storage.set(OUTBOX_KEY, JSON.stringify(entries))
  }

  function enqueue(key: string, value: string | null, provider: ProviderName): void {
    if (!useOutbox) return
    const entries = readOutbox().filter(e => !(e.key === key && e.provider === provider))
    entries.push({
      key,
      value,
      provider,
      attempts: 0,
      nextAttemptAt: Date.now(),
      enqueuedAt: Date.now(),
    })
    writeOutbox(entries)
  }

  /**
   * Routes a value to the right backing store by size.
   *
   * Without this, size limits leak into product code - cryptoc caps its tracked
   * venue list at 40 entries by hand "because this blob goes into the iCloud
   * key-value store, which has a hard per-key size limit", while its bookmark
   * list has no cap at all and can silently exceed the same limit.
   */
  function providerForSize(value: string, preferred: CloudProvider): CloudProvider {
    if (tiering == null) return preferred
    const bytes = byteLength(value)

    if (preferred.name === 'icloudKV' && bytes > tiering.kvMaxBytes) {
      const fallback = options.providers.find(n => n === 'cloudKit' || n === 'googleDrive')
      if (fallback != null) return resolve(fallback)
      throw new CloudStorageError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudStorage] Value is ${bytes} bytes, above the ${tiering.kvMaxBytes}-byte key-value `
        + `limit, and no larger-capacity provider is configured. Add 'cloudKit' or 'googleDrive' `
        + `to providers.`,
        { limitBytes: tiering.kvMaxBytes, actualBytes: bytes, provider: preferred.name }
      )
    }
    return preferred
  }

  const store: CloudStore = {
    getItem: async (key: string) => {
      let lastError: unknown = null
      // Fall through the preference list: a value written on another device by
      // a different provider should still be found.
      for (const name of options.providers) {
        const p = resolve(name)
        try {
          if (!(await p.isAvailable())) continue
          const v = await p.getItem(key)
          if (v != null) return v
        }
        catch (e) {
          lastError = e
        }
      }
      if (lastError != null) throw normalizeError(lastError)
      return null
    },

    setItem: async (key: string, value: string) => {
      const target = providerForSize(value, await primary())
      try {
        await target.setItem(key, value)
      }
      catch (e) {
        const err = normalizeError(e, target.name)
        if (useOutbox && isRetryable(err)) {
          enqueue(key, value, target.name)
          options.onError?.(err)
          return
        }
        throw err
      }
    },

    removeItem: async (key: string) => {
      const target = await primary()
      try {
        await target.removeItem(key)
      }
      catch (e) {
        const err = normalizeError(e, target.name)
        if (useOutbox && isRetryable(err)) {
          enqueue(key, null, target.name)
          options.onError?.(err)
          return
        }
        throw err
      }
    },

    getAllKeys: async () => {
      const seen = new Set<string>()
      for (const name of options.providers) {
        const p = resolve(name)
        try {
          if (!(await p.isAvailable())) continue
          for (const k of await p.getAllKeys()) seen.add(k)
        }
        catch {
          // A provider that cannot list should not hide the ones that can.
        }
      }
      return [...seen]
    },

    migrate: async ({ from, to }) => {
      const src = resolve(from)
      const dst = resolve(to)
      const keys = await src.getAllKeys()
      const copied: string[] = []

      for (const key of keys) {
        const value = await src.getItem(key)
        if (value == null) continue
        await dst.setItem(key, value)
        copied.push(key)
      }
      return { copied }
    },

    flushOutbox: async () => {
      const entries = readOutbox()
      if (entries.length === 0) return { drained: 0, remaining: 0 }

      const now = Date.now()
      const keep: OutboxEntry[] = []
      let drained = 0

      for (const entry of entries) {
        if (entry.nextAttemptAt > now) {
          keep.push(entry)
          continue
        }
        const p = resolve(entry.provider)
        try {
          if (entry.value == null) await p.removeItem(entry.key)
          else await p.setItem(entry.key, entry.value)
          drained += 1
        }
        catch (e) {
          const err = normalizeError(e, entry.provider)
          const attempts = entry.attempts + 1
          // Exponential backoff, honouring a server-supplied retry hint when
          // there is one (CloudKit sends `retryAfter`, Drive `Retry-After`).
          const backoff = err.retryAfterMs ?? Math.min(2 ** attempts * 1000, 5 * 60_000)
          keep.push({ ...entry, attempts, nextAttemptAt: Date.now() + backoff })
          options.onError?.(err)
        }
      }

      writeOutbox(keep)
      return { drained, remaining: keep.length }
    },

    pendingWrites: () => readOutbox(),

    registerProvider: (provider: CloudProvider) => {
      custom.set(provider.name, provider)
    },
  }

  return store
}

function createMemoryOutboxStorage(): OutboxStorage {
  const map = new Map<string, string>()
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => { map.set(k, v) },
  }
}
