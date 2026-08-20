import { Platform } from 'react-native'

import { getNativeModule, hasNativeModule, requireNativeModule } from '../internal/nativeModule'
import { normalizeError, unsupportedPlatform } from '../errors'
import { toAccountStatus } from '../internal/enums'
import type { AccountStatus, CloudProvider } from '../types'

const NAME = 'cloudKitEncrypted' as const

/**
 * A record type of its own, deliberately.
 *
 * CloudKit records encryption in the *schema*: a field is encrypted or plain,
 * never both. Writing an encrypted `value` onto the same `KVBlob` type that
 * `cloudKit` uses for a plain one is a field-type conflict the server rejects,
 * so the two providers must not share a record type.
 */
const RECORD_TYPE = 'EncryptedKVBlob'

function isNative(): boolean {
  const os: string | undefined = Platform?.OS
  return (os === 'ios' || os === 'macos') && hasNativeModule()
}

function assertNative(): void {
  if (!isNative())
    throw unsupportedPlatform(
      NAME,
      'CloudKit end-to-end encryption is not a feature this package could add over REST. The key '
      + 'lives in the user\'s iCloud Keychain and never reaches Apple\'s servers, so CloudKit Web '
      + 'Services - the Android and web path - has nothing to decrypt with. Use the store facade '
      + 'with a `codec` for cross-platform encryption you hold the key to.'
    )
}

/**
 * CloudKit's own end-to-end encryption, via `CKRecord.encryptedValues`.
 *
 * The genuinely native answer to "can I store sensitive data here". Values
 * written through this provider are encrypted on device with a key from the
 * user's iCloud Keychain; Apple stores ciphertext and cannot read it, whether
 * or not the user has turned on Advanced Data Protection. Nothing to configure,
 * no key for you to manage, no passphrase for the user to lose.
 *
 * What it costs, and none of these are avoidable:
 *
 *   - **Apple platforms only.** The decryption key is in the iCloud Keychain,
 *     which CloudKit Web Services cannot reach, so a value written here is
 *     permanently unreadable from Android and web. Not a gap to be closed
 *     later - it is what end-to-end means. Reach for the store facade's
 *     `codec` if the same data has to be readable off-Apple.
 *   - **Not queryable.** CloudKit cannot index an encrypted field, so no
 *     server-side filtering or sorting on the value. `getAllKeys()` still
 *     works, because it queries record *names*, which are not encrypted.
 *   - **Record names are not encrypted either.** Your keys are visible to
 *     Apple; only values are protected. Do not put anything sensitive in a key.
 *   - **Its own record type** (`EncryptedKVBlob`), so it can coexist with
 *     `cloudKit` rather than colliding with its schema.
 *
 * Usable through the facade like any other provider, as long as every provider
 * in the list can actually serve the data:
 *
 * ```ts
 * const secrets = createCloudStore({ providers: ['cloudKitEncrypted'] })
 * ```
 *
 * Mixing it with `googleDrive` in one store is almost always a mistake - the
 * Drive copy would be plaintext, which quietly undoes the encryption.
 */
export const cloudKitEncrypted: CloudProvider = {
  name: NAME,

  isAvailable: async () => {
    // Not an error on Android or web: `isAvailable` is the method callers use
    // to branch without a try/catch, and this provider genuinely is not
    // available there.
    if (!isNative()) return false
    try {
      return await requireNativeModule().isAvailable()
    }
    catch {
      return false
    }
  },

  getAccountStatus: async (): Promise<AccountStatus> => {
    if (!isNative()) return 'couldNotDetermine'
    try {
      const m = getNativeModule()
      if (m == null) return 'couldNotDetermine'
      return toAccountStatus(await m.getAccountStatus())
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  getItem: async (key: string) => {
    assertNative()
    try {
      return await requireNativeModule().ckGetRecord(RECORD_TYPE, key, null, true)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  setItem: async (key: string, value: string) => {
    assertNative()
    try {
      await requireNativeModule().ckSaveRecord(RECORD_TYPE, key, value, null, true)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  removeItem: async (key: string) => {
    assertNative()
    try {
      await requireNativeModule().ckDeleteRecord(key, null)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Record names, which CloudKit does not encrypt - so listing works even
   * though the values cannot be queried.
   */
  getAllKeys: async () => {
    assertNative()
    try {
      return await requireNativeModule().ckQueryRecordNames(RECORD_TYPE, null)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  multiGet: async (keys: string[]) => {
    assertNative()
    try {
      const out: (string | null)[] = []
      for (const key of keys)
        out.push(await requireNativeModule().ckGetRecord(RECORD_TYPE, key, null, true))
      return out
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  multiSet: async (entries: [string, string][]) => {
    assertNative()
    try {
      for (const [key, value] of entries)
        await requireNativeModule().ckSaveRecord(RECORD_TYPE, key, value, null, true)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  multiRemove: async (keys: string[]) => {
    assertNative()
    try {
      for (const key of keys) await requireNativeModule().ckDeleteRecord(key, null)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
}
