import type { CloudStorageError } from './errors'

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
   * rejects with a {@link CloudStorageError}. See `errors.ts` for why.
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

export interface CloudStoreOptions {
  /**
   * Providers in preference order. The first available one wins for writes;
   * reads fall through the list until a value is found.
   */
  providers: ProviderName[]
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
  onError?: (e: CloudStorageError) => void
}
