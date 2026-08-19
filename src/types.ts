import type { CloudSyncError } from './errors'

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

export type ProviderName = 'icloudKV' | 'cloudKit' | 'googleDrive' | 'memory'

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

  setItem: (key: string, value: string) => Promise<void>

  removeItem: (key: string) => Promise<void>

  getAllKeys: () => Promise<string[]>

  onRemoteChange?: (listener: (e: RemoteChangeEvent) => void) => Unsubscribe

  onAccountChange?: (listener: (e: AccountChangeEvent) => void) => Unsubscribe
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
  onError?: (e: CloudSyncError) => void
}
