import { icloudKV } from './providers/icloudKV'
import { cloudKit } from './providers/cloudKit'
import { cloudKitEncrypted } from './providers/cloudKitEncrypted'
import { googleDrive } from './providers/googleDrive'
import { byteLength } from './internal/bytes'
import { assertKey } from './internal/keys'
import { withTimeout } from './internal/timeout'
import { attachAutoFlush } from './internal/autoFlush'
import { CloudSyncError, ErrorCode, isRetryable, normalizeError } from './errors'
import {
  DEFAULT_TIERING,
  type AccountChangeEvent,
  type CloudProvider,
  type CloudStoreOptions,
  type DropReason,
  type DroppedWrite,
  type ItemWithMeta,
  type OutboxEntry,
  type ProviderName,
  type QuotaInfo,
  type RemoteChangeEvent,
  type ResolveCandidate,
  type TieringConfig,
  type Unsubscribe,
  type ValueCodec,
} from './types'

/**
 * A durable place to park failed writes.
 *
 * Defaults to memory, which is honest but loses the queue on app restart. Pass
 * an MMKV-backed adapter in production so an offline write survives being
 * killed - that is the whole point of the outbox.
 *
 * Both methods are synchronous: the outbox is read and rewritten on the write
 * path, where there is nowhere to await. AsyncStorage therefore cannot be
 * wrapped directly; keep a synchronous cache in front of it if that is the
 * only store you have.
 */
export interface OutboxStorage {
  getString: (key: string) => string | null | undefined
  set: (key: string, value: string) => void
}

const OUTBOX_KEY = 'rncs.outbox.v1'

/**
 * Identity of a queued write: one entry per (provider, key).
 *
 * A single helper rather than a template literal at each site, because the two
 * places that build it have to agree exactly - when they did not, a flush
 * failed to recognise the entries it had just processed and wrote every one of
 * them straight back, so a drained queue never shrank.
 *
 * The separator is an escaped NUL, which cannot appear in a provider name or a
 * key, so the two halves can never run together and make two different pairs
 * collide.
 */
function outboxId(provider: ProviderName, key: string): string {
  return `${provider}\u0000${key}`
}

const DEFAULT_OUTBOX_MAX_ENTRIES = 1000
const DEFAULT_OUTBOX_MAX_ATTEMPTS = 12
const DEFAULT_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_AVAILABILITY_TTL_MS = 3_000

const BUILT_IN: Record<string, CloudProvider> = {
  icloudKV,
  cloudKit,
  cloudKitEncrypted,
  googleDrive,
}

export interface MigrateOptions {
  from: ProviderName
  to: ProviderName
  /**
   * Keep going when a single key fails instead of aborting the whole
   * migration. Default true.
   *
   * A serial loop that throws on the first bad key leaves the user half
   * migrated with no record of how far it got, which is the worst of both
   * outcomes. The failures come back in the result instead.
   */
  continueOnError?: boolean
  /** Only migrate keys this returns true for. */
  filter?: (key: string) => boolean
  /** Called after each key, for a progress bar over a long migration. */
  onProgress?: (done: number, total: number) => void
}

export interface MigrateResult {
  copied: string[]
  /** Keys that held no value at the source and so had nothing to copy. */
  skipped: string[]
  /** Keys that could not be copied, with the reason for each. */
  failed: { key: string; error: CloudSyncError }[]
}

export interface FlushResult {
  drained: number
  remaining: number
  /** Entries abandoned during this flush. Also reported through `onDropped`. */
  dropped: DroppedWrite[]
}

export interface CloudStore {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  getAllKeys: () => Promise<string[]>

  /** Reads many keys, batching per provider where the provider supports it. */
  multiGet: (keys: string[]) => Promise<[string, string | null][]>
  /** Writes many pairs, batching per destination. */
  multiSet: (entries: [string, string][]) => Promise<void>
  /** Removes many keys, batching per provider. */
  multiRemove: (keys: string[]) => Promise<void>
  /**
   * Removes every key this store can see. Enumerated, not hardcoded - a
   * "delete my data" flow that forgets a key has not deleted the user's data.
   */
  clear: () => Promise<{ removed: string[] }>

  /**
   * Every key and value the store can see, as one object.
   *
   * `getAllKeys()` followed by `multiGet()`, so it costs whatever those cost -
   * one batched request per provider that batches, a loop where one does not.
   * Here because it is the shape a debug screen or an export actually wants,
   * and because every key-value library being migrated from has it.
   */
  getAllItems: () => Promise<Record<string, string>>

  /** Per-provider storage usage, for the providers that report it. */
  getQuota: () => Promise<QuotaInfo[]>

  /** Copies every key from one provider to another. Does not delete the source. */
  migrate: (opts: MigrateOptions) => Promise<MigrateResult>

  /** Attempts to drain queued writes. Safe to call on reconnect or foreground. */
  flushOutbox: () => Promise<FlushResult>
  /** Entries still waiting, for surfacing a "pending sync" indicator. */
  pendingWrites: () => OutboxEntry[]
  /**
   * Abandons queued writes, optionally only those matching `filter`. Returns
   * how many were removed.
   *
   * The counterpart to `pendingWrites()`: a UI that can show a stuck write
   * should be able to let the user give up on it.
   */
  discardPendingWrites: (filter?: (e: OutboxEntry) => boolean) => number

  /** Registers an extra provider (e.g. the in-memory test double). */
  registerProvider: (provider: CloudProvider) => void

  /**
   * Remote-change events from every configured provider, merged.
   *
   * Previously only the raw providers exposed this, so the facade - the
   * recommended entry point - could not be subscribed to at all.
   */
  onRemoteChange: (listener: (e: RemoteChangeEvent) => void) => Unsubscribe
  /**
   * Account-change events from every configured provider, merged.
   *
   * The store also acts on these itself: an `identityChanged` event drops
   * provider caches and abandons queued writes, because both belong to the
   * account that just went away.
   */
  onAccountChange: (listener: (e: AccountChangeEvent) => void) => Unsubscribe

  /** Releases the store's own provider subscriptions. */
  dispose: () => void
}

export function createCloudStore(
  options: CloudStoreOptions & { outboxStorage?: OutboxStorage }
): CloudStore {
  const custom = new Map<string, CloudProvider>()
  const useOutbox = options.outbox ?? true
  const writeMode = options.writeMode ?? 'failover'
  const resolveValue = options.resolve
  // Repair defaults on with a resolver: without it the losing store keeps its
  // old value and every read has to resolve again, forever.
  const repairOnRead = options.repairOnRead ?? (resolveValue != null)
  const storage: OutboxStorage = options.outboxStorage ?? createMemoryOutboxStorage()
  const codec: ValueCodec | null = options.codec ?? null
  const validateKeys = options.validateKeys ?? true
  const timeoutMs = options.timeoutMs
  const availabilityTtlMs = options.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS
  const maxEntries = options.outboxMaxEntries ?? DEFAULT_OUTBOX_MAX_ENTRIES
  const maxAttempts = options.outboxMaxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS
  const maxAgeMs = options.outboxMaxAgeMs ?? DEFAULT_OUTBOX_MAX_AGE_MS

  const tiering: TieringConfig | null
    = options.tiering === 'off'
      ? null
      : options.tiering === 'auto' || options.tiering == null
        ? DEFAULT_TIERING
        : options.tiering

  // ------------------------------------------------------------- providers

  function resolveProvider(name: ProviderName): CloudProvider {
    const found = custom.get(name) ?? BUILT_IN[name]
    if (found == null)
      throw new CloudSyncError(
        ErrorCode.CONTAINER_MISCONFIGURED,
        `[RNCloudSync] Unknown provider '${name}'. Register it with registerProvider() first.`
      )

    return found
  }

  /**
   * Memoised `isAvailable()`.
   *
   * The store asks before every operation, and for `icloudKV` that is a bridge
   * hop while for `googleDrive` it invokes the host's `getAccessToken`. A loop
   * over 100 keys used to cost 100+ probes on top of the work itself. Held
   * briefly, so a token expiring mid-session is still noticed quickly.
   */
  const availability = new Map<string, { at: number; ok: boolean }>()

  async function isAvailable(p: CloudProvider): Promise<boolean> {
    if (availabilityTtlMs <= 0) return probe(p)

    const now = Date.now()
    const cached = availability.get(p.name)
    if (cached != null && now - cached.at < availabilityTtlMs) return cached.ok

    const ok = await probe(p)
    availability.set(p.name, { at: Date.now(), ok })
    return ok
  }

  async function probe(p: CloudProvider): Promise<boolean> {
    try {
      return await run(p, () => p.isAvailable())
    }
    catch {
      // `isAvailable` is documented as non-throwing, but a timeout wrapper or a
      // third-party provider can still reject. Unavailable is the safe reading.
      return false
    }
  }

  function invalidateAvailability(): void {
    availability.clear()
  }

  /** Applies the configured per-operation timeout, if any. */
  function run<T>(p: CloudProvider, op: () => Promise<T>): Promise<T> {
    if (timeoutMs == null) return op()
    return withTimeout(op(), timeoutMs, p.name)
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
      const p = resolveProvider(name)
      if (await isAvailable(p)) found.push(p)
    }
    return found
  }

  /** First configured+available provider, in the caller's preference order. */
  async function primary(): Promise<CloudProvider> {
    for (const name of options.providers) {
      const p = resolveProvider(name)
      if (await isAvailable(p)) return p
    }
    throw noneAvailable()
  }

  function noneAvailable(): CloudSyncError {
    return new CloudSyncError(
      ErrorCode.NOT_SIGNED_IN,
      `[RNCloudSync] None of the configured providers (${options.providers.join(', ')}) `
      + `is currently available.`
    )
  }

  function checkKey(key: string): void {
    if (validateKeys) assertKey(key, options.providers)
  }

  // ----------------------------------------------------------------- codec

  async function encode(key: string, value: string): Promise<string> {
    return codec == null ? value : await codec.encode(value, key)
  }

  async function decode(key: string, value: string): Promise<string> {
    return codec == null ? value : await codec.decode(value, key)
  }

  // ---------------------------------------------------------------- outbox

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

  function reportDropped(entry: OutboxEntry, reason: DropReason, error?: CloudSyncError): void {
    options.onDropped?.({ entry, reason, error })
  }

  function enqueue(
    key: string,
    value: string | null,
    provider: ProviderName,
    lastErrorCode?: string
  ): void {
    if (!useOutbox) return
    const entries = readOutbox().filter(e => !(e.key === key && e.provider === provider))
    entries.push({
      key,
      value,
      provider,
      attempts: 0,
      nextAttemptAt: Date.now(),
      enqueuedAt: Date.now(),
      lastErrorCode,
    })

    // An unbounded queue is a slow leak: every enqueue rewrites the whole blob,
    // so a long offline stretch degrades the write path itself. Drop the oldest
    // and say so, rather than growing without limit or failing silently.
    while (entries.length > maxEntries) {
      const evicted = entries.shift()
      if (evicted != null) reportDropped(evicted, 'queueFull')
    }

    writeOutbox(entries)
  }

  /**
   * Forgets any queued write for this key/provider.
   *
   * Called after a *successful* direct write, and this is not an optimisation.
   * Without it: an offline `setItem(k, v1)` queues v1, a later online
   * `setItem(k, v2)` succeeds directly, and the next flush writes v1 back over
   * v2. The queue has to be invalidated by the newer write that superseded it.
   */
  function dequeue(key: string, provider: ProviderName): void {
    if (!useOutbox) return
    const entries = readOutbox()
    const kept = entries.filter(e => !(e.key === key && e.provider === provider))
    if (kept.length !== entries.length) writeOutbox(kept)
  }

  function dequeueMany(keys: string[], provider: ProviderName): void {
    if (!useOutbox || keys.length === 0) return
    const drop = new Set(keys)
    const entries = readOutbox()
    const kept = entries.filter(e => !(drop.has(e.key) && e.provider === provider))
    if (kept.length !== entries.length) writeOutbox(kept)
  }

  // ------------------------------------------------------------ size rules

  /**
   * The byte ceiling tiering imposes on a provider, or null when it imposes
   * none. This is what routes a value to the right backing store by size.
   *
   * Both thresholds are honoured. Drive stores whole files and has no
   * comparable small ceiling, so it is the destination of last resort.
   */
  function limitFor(provider: CloudProvider): number | null {
    if (tiering == null) return null
    if (provider.name === 'icloudKV') return tiering.kvMaxBytes
    if (provider.name === 'cloudKit') return tiering.recordMaxBytes
    return null
  }

  function canHold(provider: CloudProvider, value: string): boolean {
    const limit = limitFor(provider)
    return limit == null || byteLength(value) <= limit
  }

  /**
   * Picks the destination for a `failover` write when the preferred provider is
   * too small for the value.
   *
   * Candidates must be both large enough AND currently available: routing to a
   * provider that is configured but unreachable just converts a size problem
   * into a write failure.
   */
  async function providerForSize(
    value: string,
    preferred: CloudProvider
  ): Promise<CloudProvider> {
    if (canHold(preferred, value)) return preferred

    const bytes = byteLength(value)
    for (const name of options.providers) {
      if (name === preferred.name) continue
      const candidate = resolveProvider(name)
      if (!canHold(candidate, value)) continue
      if (!(await isAvailable(candidate))) continue
      return candidate
    }

    throw new CloudSyncError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      `[RNCloudSync] Value is ${bytes} bytes, above the ${limitFor(preferred)}-byte limit for `
      + `'${preferred.name}', and no larger-capacity provider is configured and available. Add `
      + `'cloudKit' or 'googleDrive' to providers.`,
      { limitBytes: limitFor(preferred) ?? undefined, actualBytes: bytes, provider: preferred.name }
    )
  }

  // ----------------------------------------------------------------- reads

  async function readOne(p: CloudProvider, key: string): Promise<ItemWithMeta | null> {
    if (p.getItemWithMeta != null) return await run(p, () => p.getItemWithMeta!(key))
    const value = await run(p, () => p.getItem(key))
    return value == null ? null : { value }
  }

  async function readBatch(p: CloudProvider, keys: string[]): Promise<(string | null)[]> {
    if (p.multiGet != null) return await run(p, () => p.multiGet!(keys))

    const out: (string | null)[] = []
    for (const key of keys) out.push(await run(p, () => p.getItem(key)))
    return out
  }

  async function writeBatch(p: CloudProvider, entries: [string, string][]): Promise<void> {
    if (entries.length === 0) return
    if (p.multiSet != null) {
      await run(p, () => p.multiSet!(entries))
      return
    }
    for (const [key, value] of entries) await run(p, () => p.setItem(key, value))
  }

  async function removeBatch(p: CloudProvider, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    if (p.multiRemove != null) {
      await run(p, () => p.multiRemove!(keys))
      return
    }
    for (const key of keys) await run(p, () => p.removeItem(key))
  }

  // ---------------------------------------------------------------- writes

  /** Single-destination write, queueing a retryable failure. */
  async function writeOne(target: CloudProvider, key: string, value: string): Promise<void> {
    try {
      await run(target, () => target.setItem(key, value))
      // This write supersedes anything queued for the same destination.
      dequeue(key, target.name)
    }
    catch (e) {
      const err = normalizeError(e, target.name)
      if (useOutbox && isRetryable(err)) {
        enqueue(key, value, target.name, err.code)
        options.onError?.(err)
        return
      }
      throw err
    }
  }

  /**
   * Removes a key from providers that are reachable but cannot hold this value.
   *
   * Without this, `mirror` plus tiering strands stale data: a value that grows
   * past `kvMaxBytes` is written to CloudKit and Drive and *skipped* on the
   * key-value store, which keeps the older, smaller copy. A read with no
   * resolver prefers that provider and returns the stale value forever, and
   * read repair never cleans it up because it applies the same size guard.
   * The copy the value no longer fits in has to go.
   */
  async function evictWhereTooLarge(
    targets: CloudProvider[],
    key: string,
    value: string
  ): Promise<void> {
    for (const target of targets) {
      if (canHold(target, value)) continue
      try {
        await run(target, () => target.removeItem(key))
        dequeue(key, target.name)
      }
      catch (e) {
        // Best effort. A stale copy left behind is reported, not fatal - the
        // value itself did land somewhere.
        options.onError?.(normalizeError(e, target.name))
      }
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
      if (targets.length === 0) throw noneAvailable()

      // Every destination exists but the value is too large for all of them.
      const bytes = byteLength(value)
      const largest = targets
        .map(limitFor)
        .filter((n): n is number => n != null)
        .reduce<number | undefined>((a, b) => (a == null || b > a ? b : a), undefined)
      throw new CloudSyncError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `[RNCloudSync] Value is ${bytes} bytes and does not fit in any configured provider.`,
        { actualBytes: bytes, limitBytes: largest }
      )
    }

    let stored = 0
    let fatal: CloudSyncError | null = null

    for (const target of eligible)
      try {
        await run(target, () => target.setItem(key, value))
        dequeue(key, target.name)
        stored += 1
      }
      catch (e) {
        const err = normalizeError(e, target.name)
        if (useOutbox && isRetryable(err)) {
          enqueue(key, value, target.name, err.code)
          options.onError?.(err)
          continue
        }
        fatal ??= err
        options.onError?.(err)
      }

    // Only once the value has a home somewhere: dropping the old copy first
    // would open a window in which the key exists nowhere.
    if (stored > 0) await evictWhereTooLarge(targets, key, value)

    // Nothing stored it and nothing was queued - that has to surface.
    if (stored === 0 && fatal != null) throw fatal
  }

  /** Mirrored delete, with the same at-least-one rule. */
  async function removeMany(targets: CloudProvider[], key: string): Promise<void> {
    // Nothing to delete from is a failed delete, not a completed one. Without
    // this, a mirrored `removeItem` with every provider unavailable resolved
    // successfully having removed the key from nowhere - the same false success
    // this package exists to avoid, and which `writeMany` already refuses.
    if (targets.length === 0) throw noneAvailable()

    let removed = 0
    let fatal: CloudSyncError | null = null

    for (const target of targets)
      try {
        await run(target, () => target.removeItem(key))
        dequeue(key, target.name)
        removed += 1
      }
      catch (e) {
        const err = normalizeError(e, target.name)
        if (useOutbox && isRetryable(err)) {
          enqueue(key, null, target.name, err.code)
          options.onError?.(err)
          continue
        }
        fatal ??= err
        options.onError?.(err)
      }

    if (removed === 0 && fatal != null) throw fatal
  }

  /**
   * Writes the resolved value back to providers that disagreed, and to
   * reachable providers that were missing it entirely.
   *
   * A provider the winner no longer fits in has its stale copy removed instead
   * of being silently left holding it - see {@link evictWhereTooLarge}.
   */
  async function repair(
    key: string,
    winner: string,
    candidates: ResolveCandidate[],
    reachable: Map<ProviderName, CloudProvider>
  ): Promise<void> {
    const byProvider = new Map(candidates.map(c => [c.provider, c.value]))
    const stored = await encode(key, winner)

    for (const [name, provider] of reachable) {
      if (byProvider.get(name) === winner) continue

      if (!canHold(provider, stored)) {
        if (!byProvider.has(name)) continue
        try {
          await run(provider, () => provider.removeItem(key))
        }
        catch (e) {
          options.onError?.(normalizeError(e, name))
        }
        continue
      }

      try {
        await run(provider, () => provider.setItem(key, stored))
      }
      catch (e) {
        options.onError?.(normalizeError(e, name))
      }
    }
  }

  // ---------------------------------------------------------------- events

  const remoteListeners = new Set<(e: RemoteChangeEvent) => void>()
  const accountListeners = new Set<(e: AccountChangeEvent) => void>()
  let providerSubscriptions: Unsubscribe[] | null = null
  let flushing: Promise<FlushResult> | null = null

  /**
   * Subscribes to every configured provider exactly once, lazily.
   *
   * Lazy because `createCloudStore` is often called at module scope, before the
   * native module or a Drive token exists, and eagerly subscribing there would
   * resolve providers too early.
   */
  function ensureSubscribed(): void {
    if (providerSubscriptions != null) return
    providerSubscriptions = []

    for (const name of options.providers) {
      let p: CloudProvider
      try {
        p = resolveProvider(name)
      }
      catch {
        // An unregistered provider is reported loudly by every other path;
        // subscription should not be the thing that throws first.
        continue
      }

      if (p.onRemoteChange != null)
        providerSubscriptions.push(p.onRemoteChange((e) => {
          for (const l of remoteListeners) l(e)
        }))

      if (p.onAccountChange != null)
        providerSubscriptions.push(p.onAccountChange((e) => {
          if (isDuplicateAccountEvent(e)) return
          handleAccountChange(e)
          for (const l of accountListeners) l(e)
        }))
    }
  }

  /**
   * Collapses the same account event arriving from several providers at once.
   *
   * On Apple platforms `icloudKV` and `cloudKit` both listen to the same two
   * system notifications and relabel them with their own provider name -
   * correctly, because an Apple ID change matters to both. The consequence is
   * that a store configured with both delivers one system event to app
   * listeners twice.
   *
   * Deduplicated on the event's content rather than its provider, over a short
   * window: the providers emit within the same tick, so anything that looks
   * identical that soon after is the same underlying notification. A genuine
   * second change of the same shape inside the window is vanishingly unlikely,
   * and would only cost a repeat of work that is already idempotent.
   */
  const ACCOUNT_EVENT_DEDUPE_MS = 250
  let lastAccountEvent: { key: string; at: number } | null = null

  function isDuplicateAccountEvent(e: AccountChangeEvent): boolean {
    const key = `${e.status}\u0000${String(e.identityChanged)}`
    const now = Date.now()
    const seen = lastAccountEvent != null
      && lastAccountEvent.key === key
      && now - lastAccountEvent.at < ACCOUNT_EVENT_DEDUPE_MS

    lastAccountEvent = { key, at: now }
    return seen
  }

  /**
   * The store's own reaction to an account event.
   *
   * A different Apple ID or Google account is now signed in, so three pieces of
   * state belong to somebody who is no longer here: memoised availability,
   * whatever the providers cached (Drive file ids, CloudKit reachability), and
   * the outbox. Queued writes are the dangerous one - an entry carries no
   * account identity, so flushing after a switch would write the previous
   * user's data into the new user's account.
   */
  function handleAccountChange(e: AccountChangeEvent): void {
    invalidateAvailability()
    if (!e.identityChanged) return

    for (const name of options.providers)
      try {
        resolveProvider(name).clearCaches?.()
      }
      catch {
        // Nothing to clear on a provider that will not resolve.
      }

    const pending = readOutbox()
    if (pending.length === 0) return
    writeOutbox([])
    for (const entry of pending) reportDropped(entry, 'accountChanged')
  }

  // ------------------------------------------------------------------ read

  /**
   * Reads one key across the configured providers.
   *
   * Returns `{ found: false }` only when at least one provider was reachable
   * and none of them held the key. When *nothing* was reachable the caller is
   * told, because resolving `null` there is indistinguishable from "no such
   * key" - and the documented first-launch recipe reacts to `null` by seeding
   * empty state, which is how a signed-out user's real backup gets overwritten.
   */
  async function readAcross(
    key: string
  ): Promise<{ found: boolean; value: string | null; reachedAny: boolean }> {
    let lastError: unknown = null
    let reachedAny = false

    // No resolver: first non-null wins and we stop looking. Cheap, and right
    // when only one population of devices ever writes.
    if (resolveValue == null) {
      for (const name of options.providers) {
        const p = resolveProvider(name)
        try {
          if (!(await isAvailable(p))) continue
          const hit = await readOne(p, key)
          reachedAny = true
          if (hit != null) return { found: true, value: await decode(key, hit.value), reachedAny }
        }
        catch (e) {
          lastError = e
        }
      }
      if (lastError != null) throw normalizeError(lastError)
      return { found: false, value: null, reachedAny }
    }

    // With a resolver: consult every available provider, because the first one
    // holding a value is not necessarily holding the newest. This is what makes
    // sync work in both directions across a mixed fleet.
    const candidates: ResolveCandidate[] = []
    const reachable = new Map<ProviderName, CloudProvider>()

    for (const name of options.providers) {
      const p = resolveProvider(name)
      try {
        if (!(await isAvailable(p))) continue
        const hit = await readOne(p, key)
        // Only a provider we actually read from is a repair target. Marking it
        // reachable before the read meant a provider whose read merely failed
        // - a transient network blip - was repaired too, overwriting whatever
        // it held with another provider's value. If the copy we could not read
        // was the newer one, that silently destroyed it.
        reachable.set(p.name, p)
        reachedAny = true
        if (hit != null)
          candidates.push({
            provider: p.name,
            value: await decode(key, hit.value),
            modifiedAt: hit.modifiedAt,
          })
      }
      catch (e) {
        lastError = e
      }
    }

    if (candidates.length === 0) {
      if (lastError != null) throw normalizeError(lastError)
      return { found: false, value: null, reachedAny }
    }

    const winner = resolveValue(candidates)
    if (winner == null) return { found: false, value: null, reachedAny }

    // Best-effort convergence. Never fails the read - the caller already has
    // the right answer, and a failed repair only costs another resolve later.
    if (repairOnRead) void repair(key, winner, candidates, reachable)

    return { found: true, value: winner, reachedAny }
  }

  // ------------------------------------------------------------------ API

  const store: CloudStore = {
    getItem: async (key: string) => {
      checkKey(key)
      const result = await readAcross(key)
      // Nothing was reachable, so this is not an absent key - it is an unknown
      // one. Saying `null` here is the false negative the error contract exists
      // to prevent.
      if (!result.reachedAny) throw noneAvailable()
      return result.found ? result.value : null
    },

    setItem: async (key: string, value: string) => {
      checkKey(key)
      const stored = await encode(key, value)

      if (writeMode === 'failover') {
        const target = await providerForSize(stored, await primary())
        await writeOne(target, key, stored)
        return
      }
      await writeMany(await allAvailable(), key, stored)
    },

    removeItem: async (key: string) => {
      checkKey(key)
      // A mirrored write must be a mirrored delete. Removing from only the
      // preferred provider would leave a copy behind that reads then fall
      // through to and resurrect.
      const targets = writeMode === 'mirror' ? await allAvailable() : [await primary()]
      await removeMany(targets, key)
    },

    getAllKeys: async () => {
      const seen = new Set<string>()
      for (const name of options.providers) {
        const p = resolveProvider(name)
        try {
          if (!(await isAvailable(p))) continue
          for (const k of await run(p, () => p.getAllKeys())) seen.add(k)
        }
        catch {
          // A provider that cannot list should not hide the ones that can.
        }
      }
      return [...seen]
    },

    multiGet: async (keys: string[]) => {
      for (const key of keys) checkKey(key)
      if (keys.length === 0) return []

      const answers = new Map<string, string | null>()

      // A resolving read has to see every provider's copy of every key, so
      // there is no early exit to exploit - but each provider is still a single
      // batched request rather than one per key.
      if (resolveValue != null) {
        const perKey = new Map<string, ResolveCandidate[]>(keys.map(k => [k, []]))
        let reachedAny = false

        for (const name of options.providers) {
          const p = resolveProvider(name)
          try {
            if (!(await isAvailable(p))) continue
            const values = await readBatch(p, keys)
            reachedAny = true
            for (let i = 0; i < keys.length; i += 1) {
              const raw = values[i]
              if (raw == null) continue
              perKey.get(keys[i])!.push({ provider: p.name, value: await decode(keys[i], raw) })
            }
          }
          catch {
            // Same rule as `getAllKeys`: one provider failing to answer must not
            // erase the answers the others gave.
          }
        }

        if (!reachedAny) throw noneAvailable()
        for (const key of keys) {
          const candidates = perKey.get(key)!
          answers.set(key, candidates.length === 0 ? null : resolveValue(candidates))
        }
        return keys.map(k => [k, answers.get(k) ?? null] as [string, string | null])
      }

      // No resolver: ask each provider only for the keys still unanswered, so a
      // second provider is consulted for the tail rather than for everything.
      let outstanding = [...keys]
      let reachedAny = false

      for (const name of options.providers) {
        if (outstanding.length === 0) break
        const p = resolveProvider(name)
        try {
          if (!(await isAvailable(p))) continue
          const values = await readBatch(p, outstanding)
          reachedAny = true
          const stillMissing: string[] = []
          for (let i = 0; i < outstanding.length; i += 1) {
            const raw = values[i]
            if (raw == null) stillMissing.push(outstanding[i])
            else answers.set(outstanding[i], await decode(outstanding[i], raw))
          }
          outstanding = stillMissing
        }
        catch {
          // Leave those keys outstanding for the next provider.
        }
      }

      if (!reachedAny) throw noneAvailable()
      return keys.map(k => [k, answers.get(k) ?? null] as [string, string | null])
    },

    multiSet: async (entries: [string, string][]) => {
      for (const [key] of entries) checkKey(key)
      if (entries.length === 0) return

      const encoded: [string, string][] = []
      for (const [key, value] of entries) encoded.push([key, await encode(key, value)])

      if (writeMode === 'failover') {
        // Tiering can route two values in the same batch to two different
        // providers, so group by destination rather than assuming one target.
        const preferred = await primary()
        const byTarget = new Map<string, { provider: CloudProvider; items: [string, string][] }>()

        for (const [key, value] of encoded) {
          const target = await providerForSize(value, preferred)
          const bucket = byTarget.get(target.name)
            ?? { provider: target, items: [] as [string, string][] }
          bucket.items.push([key, value])
          byTarget.set(target.name, bucket)
        }

        for (const { provider, items } of byTarget.values())
          try {
            await writeBatch(provider, items)
            dequeueMany(items.map(([k]) => k), provider.name)
          }
          catch (e) {
            const err = normalizeError(e, provider.name)
            if (useOutbox && isRetryable(err)) {
              for (const [key, value] of items) enqueue(key, value, provider.name, err.code)
              options.onError?.(err)
              continue
            }
            throw err
          }
        return
      }

      const targets = await allAvailable()
      if (targets.length === 0) throw noneAvailable()

      let anyStored = false
      let fatal: CloudSyncError | null = null

      for (const target of targets) {
        const fits = encoded.filter(([, value]) => canHold(target, value))
        if (fits.length === 0) continue
        try {
          await writeBatch(target, fits)
          dequeueMany(fits.map(([k]) => k), target.name)
          anyStored = true
        }
        catch (e) {
          const err = normalizeError(e, target.name)
          if (useOutbox && isRetryable(err)) {
            for (const [key, value] of fits) enqueue(key, value, target.name, err.code)
            options.onError?.(err)
            continue
          }
          fatal ??= err
          options.onError?.(err)
        }
      }

      if (anyStored)
        for (const [key, value] of encoded) await evictWhereTooLarge(targets, key, value)

      if (!anyStored && fatal != null) throw fatal
      if (!anyStored && fatal == null) {
        const bytes = Math.max(...encoded.map(([, v]) => byteLength(v)))
        throw new CloudSyncError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          `[RNCloudSync] No configured provider can hold these values (largest is ${bytes} bytes).`,
          { actualBytes: bytes }
        )
      }
    },

    multiRemove: async (keys: string[]) => {
      for (const key of keys) checkKey(key)
      if (keys.length === 0) return

      const targets = writeMode === 'mirror' ? await allAvailable() : [await primary()]
      if (targets.length === 0) throw noneAvailable()

      let removedAnywhere = false
      let fatal: CloudSyncError | null = null

      for (const target of targets)
        try {
          await removeBatch(target, keys)
          dequeueMany(keys, target.name)
          removedAnywhere = true
        }
        catch (e) {
          const err = normalizeError(e, target.name)
          if (useOutbox && isRetryable(err)) {
            for (const key of keys) enqueue(key, null, target.name, err.code)
            options.onError?.(err)
            continue
          }
          fatal ??= err
          options.onError?.(err)
        }

      if (!removedAnywhere && fatal != null) throw fatal
    },

    clear: async () => {
      const keys = await store.getAllKeys()
      if (keys.length === 0) return { removed: [] }
      await store.multiRemove(keys)
      return { removed: keys }
    },

    getAllItems: async () => {
      const keys = await store.getAllKeys()
      if (keys.length === 0) return {}

      const out: Record<string, string> = {}
      for (const [key, value] of await store.multiGet(keys))
        if (value != null) out[key] = value

      return out
    },

    getQuota: async () => {
      const out: QuotaInfo[] = []
      for (const name of options.providers) {
        const p = resolveProvider(name)
        if (p.getQuota == null) continue
        try {
          if (!(await isAvailable(p))) continue
          const quota = await run(p, () => p.getQuota!())
          if (quota != null) out.push(quota)
        }
        catch (e) {
          options.onError?.(normalizeError(e, name))
        }
      }
      return out
    },

    migrate: async ({ from, to, continueOnError = true, filter, onProgress }) => {
      const src = resolveProvider(from)
      const dst = resolveProvider(to)
      const all = await run(src, () => src.getAllKeys())
      const keys = filter == null ? all : all.filter(filter)

      const copied: string[] = []
      const skipped: string[] = []
      const failed: { key: string; error: CloudSyncError }[] = []

      // Values move verbatim. Both ends sit behind the same codec, so decoding
      // on the way out only to re-encode on the way in would be wasted work -
      // and, for a codec with a random nonce, would rewrite every byte.
      for (const key of keys) {
        try {
          const value = await run(src, () => src.getItem(key))
          if (value == null) {
            skipped.push(key)
          }
          else {
            await run(dst, () => dst.setItem(key, value))
            copied.push(key)
          }
        }
        catch (e) {
          const err = normalizeError(e, from)
          failed.push({ key, error: err })
          options.onError?.(err)
          // Aborting on the first bad key leaves the user half migrated with no
          // record of how far it got, which is the worst of both outcomes.
          if (!continueOnError) break
        }
        onProgress?.(copied.length + skipped.length + failed.length, keys.length)
      }

      return { copied, skipped, failed }
    },

    flushOutbox: async () => {
      // Two flushes at once - a reconnect and a foreground firing together -
      // would each snapshot the queue and each re-send every entry in it.
      if (flushing != null) return await flushing
      flushing = drain().finally(() => {
        flushing = null
      })
      return await flushing
    },

    pendingWrites: () => readOutbox(),

    discardPendingWrites: (filter) => {
      const entries = readOutbox()
      const kept: OutboxEntry[] = []
      const removed: OutboxEntry[] = []
      for (const entry of entries)
        if (filter == null || filter(entry)) removed.push(entry)
        else kept.push(entry)

      if (removed.length === 0) return 0
      writeOutbox(kept)
      for (const entry of removed) reportDropped(entry, 'discarded')
      return removed.length
    },

    registerProvider: (provider: CloudProvider) => {
      custom.set(provider.name, provider)
      availability.delete(provider.name)
      // A provider registered after the first subscription would otherwise
      // never be listened to. Cheapest correct fix is to resubscribe.
      if (providerSubscriptions != null) {
        for (const un of providerSubscriptions) un()
        providerSubscriptions = null
        if (remoteListeners.size > 0 || accountListeners.size > 0) ensureSubscribed()
      }
    },

    onRemoteChange: (listener) => {
      ensureSubscribed()
      remoteListeners.add(listener)
      return () => {
        remoteListeners.delete(listener)
      }
    },

    onAccountChange: (listener) => {
      ensureSubscribed()
      accountListeners.add(listener)
      return () => {
        accountListeners.delete(listener)
      }
    },

    dispose: () => {
      if (providerSubscriptions != null) for (const un of providerSubscriptions) un()
      providerSubscriptions = null
      remoteListeners.clear()
      accountListeners.clear()
      detachAutoFlush?.()
      detachAutoFlush = null
    },
  }

  // Attached last, so the store it flushes is fully built by the time the first
  // foreground event or timer tick can reach it.
  let detachAutoFlush: Unsubscribe | null = null
  if (options.autoFlush != null && options.autoFlush !== false)
    detachAutoFlush = attachAutoFlush(
      () => store.flushOutbox(),
      options.autoFlush === true ? {} : options.autoFlush
    )

  async function drain(): Promise<FlushResult> {
    const entries = readOutbox()
    if (entries.length === 0) return { drained: 0, remaining: 0, dropped: [] }

    const now = Date.now()
    const keep: OutboxEntry[] = []
    const dropped: DroppedWrite[] = []
    const handled = new Set<string>()
    let drained = 0

    function drop(entry: OutboxEntry, reason: DropReason, error?: CloudSyncError): void {
      dropped.push({ entry, reason, error })
      reportDropped(entry, reason, error)
    }

    for (const entry of entries) {
      handled.add(outboxId(entry.provider, entry.key))

      if (now - entry.enqueuedAt > maxAgeMs) {
        drop(entry, 'expired')
        continue
      }
      if (entry.nextAttemptAt > now) {
        keep.push(entry)
        continue
      }

      let p: CloudProvider
      try {
        p = resolveProvider(entry.provider)
      }
      catch (e) {
        // The provider it targeted is gone. Nothing will ever drain this.
        drop(entry, 'notRetryable', normalizeError(e, entry.provider))
        continue
      }

      try {
        if (entry.value == null) await run(p, () => p.removeItem(entry.key))
        else await run(p, () => p.setItem(entry.key, entry.value!))
        drained += 1
      }
      catch (e) {
        const err = normalizeError(e, entry.provider)
        options.onError?.(err)

        // A write only enters the queue for a retryable reason. If retrying it
        // now fails for one the user must act on - quota, signed out, a payload
        // the store will never accept - re-queueing turns it into a poison
        // entry that retries forever, never drains, and never surfaces.
        if (!isRetryable(err)) {
          drop(entry, 'notRetryable', err)
          continue
        }

        const attempts = entry.attempts + 1
        if (attempts >= maxAttempts) {
          drop({ ...entry, attempts, lastErrorCode: err.code }, 'tooManyAttempts', err)
          continue
        }

        // Exponential backoff, honouring a server-supplied retry hint when
        // there is one (CloudKit sends `retryAfter`, Drive `Retry-After`).
        const backoff = err.retryAfterMs ?? Math.min(2 ** attempts * 1000, 5 * 60_000)
        keep.push({
          ...entry,
          attempts,
          nextAttemptAt: Date.now() + backoff,
          lastErrorCode: err.code,
        })
      }
    }

    // Merge rather than overwrite. A `setItem` that failed while this flush was
    // awaiting the network enqueued itself into storage; writing the snapshot
    // back wholesale would silently discard it.
    const arrived = readOutbox().filter(e => !handled.has(outboxId(e.provider, e.key)))
    writeOutbox([...keep, ...arrived])

    return { drained, remaining: keep.length + arrived.length, dropped }
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
