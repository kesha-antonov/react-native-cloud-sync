import type { CloudSyncError } from './errors'
import type { AutoFlushConfig } from './internal/autoFlush'

/**
 * Full account state.
 *
 * Deliberately not a boolean. `react-native-icloud-kit` exposes
 * `isAvailable(): Bool`, which flattens CloudKit's five `CKAccountStatus`
 * values into one bit - so an app cannot tell "signed out" (ask the user to
 * sign in) from "temporarily unavailable" (retry silently) from "could not
 * determine" (do nothing yet). Those three demand different product behaviour.
 */
export type AccountStatus
  = | 'available'
    | 'noAccount'
    | 'restricted'
    | 'temporarilyUnavailable'
    | 'couldNotDetermine'

/** Why a remote-change event fired. Mirrors NSUbiquitousKeyValueStore's reasons. */
export type ChangeReason
  = | 'serverChange'
    | 'initialSync'
    | 'quotaViolation'
    | 'accountChange'
    | 'unknown'

export interface RemoteChangeEvent {
  /** Keys whose values changed. May be empty for `accountChange`/`quotaViolation`. */
  keys: string[]
  reason: ChangeReason
  provider: ProviderName
}

export interface AccountChangeEvent {
  status: AccountStatus
  /**
   * True when the signed-in identity itself changed (a different Apple ID), as
   * opposed to the same account merely becoming available or unavailable.
   *
   * This is the event nobody handles. MagisteriaApp stores an anonymous user id
   * in iCloud and never observes `NSUbiquityIdentityDidChange`, so switching
   * Apple ID silently keeps the previous user's identity - its own TODO records
   * this as "sign out does not always give you a clean guest". Apps should treat
   * `identityChanged: true` as "drop all cached user-scoped state".
   */
  identityChanged: boolean
  provider: ProviderName
}

export interface AssetProgressEvent {
  recordName: string
  fieldName: string
  bytesTransferred: number
  bytesTotal: number
}

/** The providers this package ships. */
export type { AutoFlushConfig }

export type BuiltInProviderName
  = | 'icloudKV'
    | 'cloudKit'
    | 'cloudKitEncrypted'
    | 'googleDrive'
    | 'memory'

/**
 * A provider's name.
 *
 * Open on purpose. `registerProvider` is documented as the way to plug in a
 * provider you wrote yourself, but while this was a closed union of the four
 * built-ins that was impossible to express in types - a `'dropbox'` provider
 * needed a cast at every call site, including in `CloudStoreOptions.providers`.
 * The `string & {}` arm keeps editor autocomplete for the built-in names while
 * still accepting any other string.
 */
export type ProviderName = BuiltInProviderName | (string & {})

export type Unsubscribe = () => void

/**
 * The contract every provider implements. The facade in `store.ts` is written
 * against this and nothing else, which is what makes providers swappable and
 * makes the in-memory test double a first-class provider rather than a mock.
 */
export interface CloudProvider {
  readonly name: ProviderName

  /**
   * Whether this provider can currently be used. Cheap and non-throwing, so it
   * is safe to call on a render path.
   */
  isAvailable: () => Promise<boolean>

  getAccountStatus: () => Promise<AccountStatus>

  /**
   * Resolves `null` if and only if the key does not exist. Every other failure
   * rejects with a {@link CloudSyncError}. See `errors.ts` for why.
   */
  getItem: (key: string) => Promise<string | null>

  /**
   * Like {@link getItem}, but also reports the server's own last-modified time.
   *
   * Optional because not every backing store knows one - `NSUbiquitousKeyValueStore`
   * exposes no per-key timestamp at all. Where a provider *does* know (CloudKit's
   * `modified.timestamp`, Drive's `modifiedTime`, both one query parameter away),
   * implementing this lets {@link resolveByModifiedAt} order candidates without
   * the app having to embed a timestamp inside its own payload.
   */
  getItemWithMeta?: (key: string) => Promise<ItemWithMeta | null>

  setItem: (key: string, value: string) => Promise<void>

  removeItem: (key: string) => Promise<void>

  getAllKeys: () => Promise<string[]>

  /**
   * Reads many keys in one go. Optional: the store falls back to sequential
   * {@link getItem} calls when a provider does not implement it.
   *
   * Worth implementing whenever the backend has a batch endpoint - CloudKit Web
   * Services' `/records/lookup` and `/records/modify` both take arrays, so the
   * difference between this and a loop is one request against N.
   */
  multiGet?: (keys: string[]) => Promise<(string | null)[]>

  /** Writes many key/value pairs in one go. Optional, same fallback rule. */
  multiSet?: (entries: [string, string][]) => Promise<void>

  /** Removes many keys in one go. Optional, same fallback rule. */
  multiRemove?: (keys: string[]) => Promise<void>

  /**
   * Total and used bytes for this account, when the backend reports them.
   * Optional - `NSUbiquitousKeyValueStore` has no usage API.
   */
  getQuota?: () => Promise<QuotaInfo | null>

  /**
   * Drops any state cached for the *previous* account.
   *
   * Called by the store when an `identityChanged` account event arrives.
   * Memoised Drive file ids and CloudKit reachability answers belong to whoever
   * was signed in when they were recorded; serving them to the next user is a
   * cross-account data leak.
   */
  clearCaches?: () => void

  onRemoteChange?: (listener: (e: RemoteChangeEvent) => void) => Unsubscribe

  onAccountChange?: (listener: (e: AccountChangeEvent) => void) => Unsubscribe
}

/** A value plus whatever metadata the provider could report alongside it. */
export interface ItemWithMeta {
  value: string
  /** Server-reported last modification, epoch millis, when the provider knows one. */
  modifiedAt?: number
}

/** Account storage usage, for providers that report it. */
export interface QuotaInfo {
  /** Bytes currently used, or undefined when the backend does not say. */
  usedBytes?: number
  /** Total bytes available, or undefined for an unlimited/unreported quota. */
  totalBytes?: number
  provider: ProviderName
}

/** Byte thresholds that decide which backing store a value lands in. */
export interface TieringConfig {
  /**
   * At or below this, values go to the iCloud key-value store.
   *
   * Apple's hard limits are 1 MB total / 1 MB per key / 1024 keys, but the
   * *total* is the one that bites - a handful of large values silently starves
   * every other key. 64 KB keeps the KV store for what it is good at (settings,
   * small identifiers) and pushes real payloads to CloudKit records.
   */
  kvMaxBytes: number
  /**
   * At or below this, values go in a CKRecord field. CloudKit's documented
   * record ceiling is 1 MB excluding assets; 900 KB leaves room for the record's
   * own metadata.
   */
  recordMaxBytes: number
}

export const DEFAULT_TIERING: TieringConfig = {
  kvMaxBytes: 64 * 1024,
  recordMaxBytes: 900 * 1024,
}

export interface OutboxEntry {
  key: string
  value: string | null
  provider: ProviderName
  attempts: number
  /** Epoch millis of the next attempt. */
  nextAttemptAt: number
  enqueuedAt: number
  /**
   * The error code of the most recent failed attempt, so a "pending sync" UI
   * can say *why* something is still queued rather than only that it is.
   */
  lastErrorCode?: string
}

/** Why the store gave up on a queued write. Reported through {@link CloudStoreOptions.onDropped}. */
/**
 * - `notRetryable` - the failure stopped being retryable; the user has to act on it.
 * - `tooManyAttempts` - {@link CloudStoreOptions.outboxMaxAttempts} was reached.
 * - `expired` - it sat in the queue longer than {@link CloudStoreOptions.outboxMaxAgeMs}.
 * - `queueFull` - the queue hit its cap and this was the oldest entry.
 * - `accountChanged` - a different account signed in, so it belongs to nobody now.
 * - `discarded` - `discardPendingWrites` removed it.
 */
export type DropReason
  = | 'notRetryable'
    | 'tooManyAttempts'
    | 'expired'
    | 'queueFull'
    | 'accountChanged'
    | 'discarded'

export interface DroppedWrite {
  entry: OutboxEntry
  reason: DropReason
  /** The failure that caused it, when there was one. */
  error?: CloudSyncError
}

/**
 * How a write is distributed across the configured providers.
 *
 * - `failover` - write to the first available provider only. The rest are read
 *   fallbacks. Cheapest, and right when the providers are alternatives.
 * - `mirror` - write to every available provider. Costs one request per
 *   provider, and is what makes a value written on an iPhone readable on
 *   Android: the Apple-only providers cannot be reached from there, so unless
 *   something also wrote to Drive, there is nothing for Android to find.
 *
 * Reads fall through the list in both modes.
 */
export type WriteMode = 'failover' | 'mirror'

/** One provider's copy of a key, as seen during a resolving read. */
export interface ResolveCandidate {
  provider: ProviderName
  value: string
  /**
   * The server's own last-modified time in epoch millis, when the provider
   * reported one (see {@link CloudProvider.getItemWithMeta}).
   *
   * This is what {@link resolveByModifiedAt} orders on, and it is why that
   * resolver works on payloads the app never had to instrument.
   */
  modifiedAt?: number
}

/**
 * Picks the winner when providers disagree.
 *
 * The store holds opaque strings, so it cannot know which copy is newer - only
 * the app knows what its values mean. Returning `null` means "none of these",
 * which reads as absent.
 */
export type ResolveFn = (candidates: ResolveCandidate[]) => string | null

export interface CloudStoreOptions {
  /**
   * Providers in preference order.
   *
   * Reads fall through this list until a value is found. Writes go to the first
   * available provider, or to all of them - see {@link writeMode}.
   */
  providers: ProviderName[]
  /**
   * Default `failover`.
   *
   * Use `mirror` when the same data has to be reachable from a platform where
   * the preferred provider does not exist.
   */
  writeMode?: WriteMode
  /**
   * How a read picks a value when more than one provider holds the key.
   *
   * Without this, `getItem` returns the first non-null value in provider order
   * and stops. That is cheap and correct when only one device population
   * writes - but it silently serves stale data as soon as writes come from
   * both sides. An Apple device reading `['icloudKV', 'googleDrive']` always
   * finds *something* in iCloud, so a newer value written from Android via
   * Drive is never even looked at.
   *
   * Supplying this makes a read consult every available provider and hand you
   * the candidates. {@link resolveByTimestamp} covers the usual case.
   */
  resolve?: ResolveFn
  /**
   * After a resolving read, write the winner back to providers that disagreed.
   *
   * Default true when {@link resolve} is set. This is what actually makes two
   * populations converge: without it, the losing store keeps its old value and
   * every read pays to resolve again forever.
   *
   * Best-effort - a failed repair never fails the read.
   */
  repairOnRead?: boolean
  tiering?: TieringConfig | 'auto' | 'off'
  /**
   * Persist failed writes and retry them with backoff.
   *
   * Default true. With it off, a write made while offline is lost - which is
   * exactly the documented behaviour of react-native-cloud-storage today
   * ("the OS will not throw an error ... you'll need to check for an internet
   * connection before handing data to" it).
   */
  outbox?: boolean
  /**
   * Hard cap on queued writes. Default 1000.
   *
   * An unbounded queue is a slow memory and storage leak: every `enqueue`
   * rewrites the whole JSON blob, so an app that stays offline long enough
   * degrades its own write path. When the cap is hit the oldest entry is
   * dropped and reported through {@link onDropped}, so the loss is visible
   * rather than silent.
   */
  outboxMaxEntries?: number
  /**
   * Give up on a queued write after this many failed attempts. Default 12,
   * which with the capped exponential backoff is roughly an hour of retrying.
   */
  outboxMaxAttempts?: number
  /**
   * Give up on a queued write older than this. Default 7 days.
   *
   * Time matters independently of attempt count: an app opened twice in a month
   * accrues almost no attempts, and re-sending a fortnight-old value over
   * whatever the user has done since is rarely what they want.
   */
  outboxMaxAgeMs?: number
  /** Called whenever a queued write is abandoned, with the reason. */
  onDropped?: (dropped: DroppedWrite) => void
  /**
   * Drain the outbox automatically, instead of leaving `flushOutbox()` entirely
   * to the caller. Off by default; pass `true` for the defaults.
   *
   * A durable queue with no trigger is only half a feature - every retryable
   * failure is captured correctly and then waits for someone to remember. This
   * flushes on app foreground and on a slow timer, which is where nearly every
   * app was calling it by hand.
   *
   * Not network-aware, on purpose: that needs NetInfo, and adding a dependency
   * every consumer must install to save one line in the ones that want it is a
   * bad trade. Call `flushOutbox()` from your own reconnect listener too if you
   * have one.
   */
  autoFlush?: boolean | AutoFlushConfig
  /**
   * How long an `isAvailable()` answer is reused across operations. Default 3000.
   *
   * The store asks every provider before every operation, and for `icloudKV`
   * that is a bridge hop while for `googleDrive` it invokes the host's
   * `getAccessToken`. Unmemoised, a loop over 100 keys cost 100+ probes on top
   * of the actual work. Set to 0 to probe every time.
   */
  availabilityTtlMs?: number
  /**
   * Transforms values on the way out and back on the way in - the seam for
   * encrypting at rest.
   *
   * Drive's `appDataFolder` is plaintext to anything holding the account's OAuth
   * token, and this package deliberately ships no crypto of its own (key
   * management is the app's problem, and bundling a cipher would make it look
   * solved). Supplying a codec is how you close that gap with a library you
   * chose.
   *
   * Applied to values only, never to keys - `getAllKeys()`, tiering and read
   * repair all need cleartext keys to work.
   *
   * Encoding runs *before* tiering picks a destination, so a value is routed by
   * the size it will actually occupy rather than by its plaintext size. That is
   * the correct behaviour, and it means a codec that inflates its input makes
   * your effective {@link TieringConfig.kvMaxBytes} smaller than the number
   * says.
   */
  codec?: ValueCodec
  /**
   * Reject keys that cannot round-trip through every configured provider.
   * Default true.
   *
   * One key string has to be a `NSUbiquitousKeyValueStore` key, a CloudKit
   * `recordName` and a Drive filename at once, and those three disagree about
   * what is legal. Without this check an invalid `recordName` comes back from
   * CloudKit as `BAD_REQUEST`, which maps to `ERR_CONTAINER_MISCONFIGURED` and
   * sends you looking at your entitlements instead of at your key.
   */
  validateKeys?: boolean
  /**
   * Abandon a single provider operation that has not settled in this long,
   * with {@link ErrorCode.TIMEOUT}. Off by default.
   *
   * React Native's `fetch` has no default timeout and neither does CloudKit's
   * native stack, so a socket that never answers hangs the operation forever -
   * including `isAvailable()`, which the store calls before everything else.
   * A timeout is classified as retryable, so with the outbox on, a hung write
   * is queued rather than lost.
   */
  timeoutMs?: number
  onError?: (e: CloudSyncError) => void
}

/**
 * A two-way value transform, applied at the boundary between the store and its
 * providers. See {@link CloudStoreOptions.codec}.
 */
export interface ValueCodec {
  /** Called with the app's value; the result is what the provider stores. */
  encode: (value: string, key: string) => Promise<string> | string
  /** Called with what the provider returned; the result is what the app sees. */
  decode: (value: string, key: string) => Promise<string> | string
}
