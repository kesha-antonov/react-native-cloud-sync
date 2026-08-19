import { icloudKV } from './providers/icloudKV'
import { cloudKit } from './providers/cloudKit'
import { googleDrive } from './providers/googleDrive'
import { byteLength } from './internal/cloudKitRest'
import { CloudSyncError, ErrorCode, isRetryable, normalizeError } from './errors'
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
  const writeMode = options.writeMode ?? 'failover'
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
      throw new CloudSyncError(
        ErrorCode.CONTAINER_MISCONFIGURED,
        `[RNCloudSync] Unknown provider '${name}'. Register it with registerProvider() first.`
      )

    return found
  }

  /**
   * Every configured provider that is currently usable, in preference order.
   *
   * Ordering is preserved so `mirror` writes hit the preferred store first -
   * if the process dies mid-write, the copy that landed is the one reads reach
   * first.
   */
  async function allAvailable(): Promise<CloudProvider[]> {
    const found: CloudProvider[] = []
    for (const name of options.providers) {
      const p = resolve(name)
      if (await p.isAvailable()) found.push(p)
    }
    return found
  }

  /** First configured+available provider, in the caller's preference order. */
  async function primary(): Promise<CloudProvider> {
    for (const name of options.providers) {
      const p = resolve(name)
      if (await p.isAvailable()) return p
    }
    throw new CloudSyncError(
      ErrorCode.NOT_SIGNED_IN,
      `[RNCloudSync] None of the configured providers (${options.providers.join(', ')}) `
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
  /**
   * Whether a provider can hold this value at all.
   *
   * Used by `mirror` to skip a store the value does not fit in - the iCloud
   * key-value store is capped far below the others - rather than failing the
   * whole write because one destination is too small.
   */
  function canHold(provider: CloudProvider, value: string): boolean {
    if (tiering == null) return true
    if (provider.name !== 'icloudKV') return true
    return byteLength(value) <= tiering.kvMaxBytes
  }

  function providerForSize(value: string, preferred: CloudProvider): CloudProvider {
    if (tiering == null) return preferred
    const bytes = byteLength(value)

    if (preferred.name === 'icloudKV' && bytes > tiering.kvMaxBytes) {
      const fallback = options.providers.find(n => n === 'cloudKit' || n === 'googleDrive')
      if (fallback != null) return resolve(fallback)
      throw new CloudSyncError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudSync] Value is ${bytes} bytes, above the ${tiering.kvMaxBytes}-byte key-value `
        + `limit, and no larger-capacity provider is configured. Add 'cloudKit' or 'googleDrive' `
        + `to providers.`,
        { limitBytes: tiering.kvMaxBytes, actualBytes: bytes, provider: preferred.name }
      )
    }
    return preferred
  }

  /** Single-destination write, queueing a retryable failure. */
  async function writeOne(target: CloudProvider, key: string, value: string): Promise<void> {
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
  }

  /**
   * Mirrored write.
   *
   * Succeeds if at least one destination took the value, because one good copy
   * plus a queued retry is a better outcome than rejecting a write the user has
   * already been told about. Retryable failures go to the outbox per provider,
   * so they converge without re-sending to the ones that already succeeded.
   *
   * Rejects only when nothing stored it - silence there would be the false
   * success this package exists to avoid.
   */
  async function writeMany(targets: CloudProvider[], key: string, value: string): Promise<void> {
    const eligible = targets.filter(t => canHold(t, value))

    if (eligible.length === 0) {
      if (targets.length === 0)
        throw new CloudSyncError(
          ErrorCode.NOT_SIGNED_IN,
          `[RNCloudSync] None of the configured providers (${options.providers.join(', ')}) `
          + `is currently available.`
        )

      // Every destination exists but the value is too large for all of them.
      const bytes = byteLength(value)
      throw new CloudSyncError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudSync] Value is ${bytes} bytes and does not fit in any configured provider.`,
        { actualBytes: bytes, limitBytes: tiering?.kvMaxBytes }
      )
    }

    let stored = 0
    let fatal: CloudSyncError | null = null

    for (const target of eligible)
      try {
        await target.setItem(key, value)
        stored += 1
      }
      catch (e) {
        const err = normalizeError(e, target.name)
        if (useOutbox && isRetryable(err)) {
          enqueue(key, value, target.name)
          options.onError?.(err)
          continue
        }
        fatal ??= err
        options.onError?.(err)
      }

    // Nothing stored it and nothing was queued - that has to surface.
    if (stored === 0 && fatal != null) throw fatal
  }

  /** Mirrored delete, with the same at-least-one rule. */
  async function removeMany(targets: CloudProvider[], key: string): Promise<void> {
    let removed = 0
    let fatal: CloudSyncError | null = null

    for (const target of targets)
      try {
        await target.removeItem(key)
        removed += 1
      }
      catch (e) {
        const err = normalizeError(e, target.name)
        if (useOutbox && isRetryable(err)) {
          enqueue(key, null, target.name)
          options.onError?.(err)
          continue
        }
        fatal ??= err
        options.onError?.(err)
      }

    if (removed === 0 && fatal != null) throw fatal
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
      if (writeMode === 'failover') {
        const target = providerForSize(value, await primary())
        await writeOne(target, key, value)
        return
      }
      await writeMany(await allAvailable(), key, value)
    },

    removeItem: async (key: string) => {
      // A mirrored write must be a mirrored delete. Removing from only the
      // preferred provider would leave a copy behind that reads then fall
      // through to and resurrect.
      const targets = writeMode === 'mirror' ? await allAvailable() : [await primary()]
      await removeMany(targets, key)
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
