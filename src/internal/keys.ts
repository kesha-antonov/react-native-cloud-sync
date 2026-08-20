import { CloudSyncError, ErrorCode } from '../errors'
import type { ProviderName } from '../types'
import { byteLength } from './bytes'

/**
 * Key validation.
 *
 * One key string has to be three different things at once - an
 * `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Google Drive
 * file name - and the three disagree about what is legal. Nothing checked, a
 * key that is fine on iOS comes back from CloudKit Web Services as
 * `BAD_REQUEST`, which this package maps to `ERR_CONTAINER_MISCONFIGURED`, and
 * the developer goes looking at their entitlements.
 *
 * So the rules are stated here, checked before the request, and reported with
 * the offending key and the specific rule it broke.
 */

/**
 * Apple: "The maximum length for a key string is 64 bytes using UTF8 encoding."
 * Note *bytes*, not characters - a key of emoji is four times longer than it
 * looks.
 */
const KV_MAX_KEY_BYTES = 64

/** CloudKit's documented ceiling for a record name. */
const CK_MAX_RECORD_NAME = 255

/**
 * CloudKit accepts ASCII letters, digits, `-`, `_` and `.` in a record name.
 *
 * Checked **only when a CloudKit provider is configured**. It is a CloudKit
 * restriction, not a universal one: `NSUbiquitousKeyValueStore` keys are plain
 * strings with no character rules at all, and Drive file names are nearly as
 * permissive. Applying it everywhere rejected keys that had been working in
 * production for years - `auth/anonymousUserId/v1` in an app that only ever
 * used the key-value store - which is a far worse outcome than the server
 * error this check exists to pre-empt.
 */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/

/** CloudKit reserves the leading underscore for its own system record names. */
const RESERVED_PREFIX = '_'

/** Providers whose keys become CloudKit record names. */
const CLOUDKIT_PROVIDERS: readonly ProviderName[] = ['cloudKit', 'cloudKitEncrypted']

function usesCloudKit(providers: readonly ProviderName[]): ProviderName | null {
  return providers.find(p => CLOUDKIT_PROVIDERS.includes(p)) ?? null
}

export interface KeyRule {
  /** Human-readable statement of what was violated. */
  reason: string
  /** The provider whose limit this is, or null when every provider shares it. */
  provider: ProviderName | null
}

/**
 * The first rule `key` breaks for this set of providers, or null when it is
 * usable everywhere.
 *
 * Provider-aware on purpose: the 64-byte ceiling is the key-value store's
 * alone, and rejecting a 100-character key for an app that only configured
 * Drive would be a false alarm.
 */
export function checkKey(key: string, providers: readonly ProviderName[]): KeyRule | null {
  if (typeof key !== 'string' || key.length === 0)
    return { reason: 'a key must be a non-empty string', provider: null }

  // Every rule below this line belongs to a specific provider, and is only
  // applied when that provider is actually configured. Rejecting a key for a
  // restriction that cannot apply is not caution, it is a false alarm - and one
  // that breaks working apps rather than pre-empting a server error.
  const cloudKitProvider = usesCloudKit(providers)

  if (cloudKitProvider != null) {
    if (!SAFE_KEY.test(key))
      return {
        reason:
          'a key may contain only ASCII letters, digits, and the characters . _ - '
          + 'once it has to serve as a CloudKit record name',
        provider: cloudKitProvider,
      }

    if (key.startsWith(RESERVED_PREFIX))
      return {
        reason: 'a key may not start with "_", which CloudKit reserves for system records',
        provider: cloudKitProvider,
      }

    if (key.length > CK_MAX_RECORD_NAME)
      return {
        reason:
          `a CloudKit record name is limited to ${CK_MAX_RECORD_NAME} characters `
          + `(got ${key.length})`,
        provider: cloudKitProvider,
      }
  }

  if (providers.includes('icloudKV')) {
    const bytes = byteLength(key)
    if (bytes > KV_MAX_KEY_BYTES)
      return {
        reason:
          `an iCloud key-value store key is limited to ${KV_MAX_KEY_BYTES} UTF-8 bytes `
          + `(got ${bytes})`,
        provider: 'icloudKV',
      }
  }

  return null
}

/** Throws {@link ErrorCode.INVALID_KEY} when `key` is unusable. */
export function assertKey(key: string, providers: readonly ProviderName[]): void {
  const broken = checkKey(key, providers)
  if (broken == null) return

  throw new CloudSyncError(
    ErrorCode.INVALID_KEY,
    `[RNCloudSync] Invalid key ${JSON.stringify(key)}: ${broken.reason}.`,
    { provider: broken.provider ?? undefined }
  )
}

/**
 * Rewrites an arbitrary string into a key that passes {@link checkKey}.
 *
 * For callers whose keys come from somewhere they do not control - a file name,
 * a user-entered label, an id from another system. Illegal characters become
 * `-`, and anything too long is truncated and suffixed with a short hash of the
 * original so two different long keys cannot collide.
 */
export function sanitizeKey(raw: string, maxBytes = KV_MAX_KEY_BYTES): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^_+/, '')

  const base = cleaned.length > 0 ? cleaned : 'key'
  if (byteLength(base) <= maxBytes) return base

  // Truncating alone would map every long key with a shared prefix onto the
  // same short key, silently merging unrelated values.
  const suffix = `-${hash(raw)}`
  const room = Math.max(1, maxBytes - suffix.length)
  let head = base.slice(0, room)
  while (byteLength(head) > room) head = head.slice(0, -1)
  return head + suffix
}

/** FNV-1a, base36. Not cryptographic - only needs to separate collisions. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}
