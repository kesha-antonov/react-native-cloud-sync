import { Platform } from 'react-native'

import { getNativeModule, hasNativeModule, requireNativeModule, subscribeNativeEvent } from '../internal/nativeModule'
import { getCloudKitClient, isCloudKitConfigured } from '../config'
import { normalizeError } from '../errors'
import { toAccountStatus, toChangeReason } from '../internal/enums'
import type {
  AccountChangeEvent,
  AccountStatus,
  CloudProvider,
  RemoteChangeEvent,
  Unsubscribe,
} from '../types'
import type {
  AccountChangeNativeEvent,
  RemoteChangeNativeEvent,
} from '../specs/NativeRNCloudStorage'

const NAME = 'cloudKit' as const

/**
 * CloudKit private database.
 *
 * The only provider here that reaches the *same* data on every platform:
 *
 *   iOS / macOS  ->  CloudKit.framework, natively, no configuration
 *   Android      ->  CloudKit Web Services REST (see configureCloudKit)
 *   Web          ->  the same REST client
 *
 * On Android and web the user must sign in with an Apple ID to mint a
 * `ckWebAuthToken`, and that token lives 30 minutes - or 2 weeks if they ticked
 * "Keep me signed in" - with no documented refresh. Treat those platforms as
 * suited to a deliberate import/export ("bring my iPhone data over"), not to a
 * silent always-on backup. `googleDrive` is the better continuous backend there.
 */

/** True when this platform talks to CloudKit natively rather than over REST. */
function isNative(): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'macos') && hasNativeModule()
}

export const cloudKit: CloudProvider = {
  name: NAME,

  isAvailable: async () => {
    if (isNative())
      try {
        return await requireNativeModule().isAvailable()
      }
      catch {
        return false
      }

    if (!isCloudKitConfigured()) return false
    try {
      // A lookup of a key that is not expected to exist. A `null` result and a
      // NOT_FOUND both mean "reachable and authenticated"; only a thrown
      // auth/network/config error means unavailable.
      await getCloudKitClient().getRecord('__rncs_availability_probe__')
      return true
    }
    catch {
      return false
    }
  },

  getAccountStatus: async (): Promise<AccountStatus> => {
    if (isNative())
      try {
        return toAccountStatus(await requireNativeModule().getAccountStatus())
      }
      catch (e) {
        throw normalizeError(e, NAME)
      }

    // Over REST there is no account-status endpoint; possession of a usable web
    // auth token is the closest equivalent signal.
    return isCloudKitConfigured() ? 'available' : 'noAccount'
  },

  getItem: async (key: string) => {
    try {
      if (isNative()) return await requireNativeModule().ckGetRecord('KVBlob', key, null)
      return await getCloudKitClient().getRecord(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  setItem: async (key: string, value: string) => {
    try {
      if (isNative()) {
        await requireNativeModule().ckSaveRecord('KVBlob', key, value, null)
        return
      }
      await getCloudKitClient().saveRecord(key, value)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  removeItem: async (key: string) => {
    try {
      if (isNative()) {
        await requireNativeModule().ckDeleteRecord(key, null)
        return
      }
      await getCloudKitClient().deleteRecord(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  getAllKeys: async () => {
    try {
      if (isNative()) return await requireNativeModule().ckQueryRecordNames('KVBlob', null)
      return await getCloudKitClient().queryRecordNames()
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  onRemoteChange: (listener: (e: RemoteChangeEvent) => void): Unsubscribe => {
    // REST has no push channel without APNs, so this is a native-only signal.
    if (getNativeModule() == null) return () => undefined
    return subscribeNativeEvent<RemoteChangeNativeEvent>(
      'onRemoteChange',
      'remoteChange',
      (e) => {
        if (e.provider !== NAME) return
        listener({ keys: e.keys, reason: toChangeReason(e.reason), provider: NAME })
      }
    )
  },

  onAccountChange: (listener: (e: AccountChangeEvent) => void): Unsubscribe => {
    if (getNativeModule() == null) return () => undefined
    return subscribeNativeEvent<AccountChangeNativeEvent>(
      'onAccountChange',
      'accountChange',
      (e) => {
        listener({
          status: toAccountStatus(e.status),
          identityChanged: e.identityChanged,
          provider: NAME,
        })
      }
    )
  },
}

/** Custom zones. Native only - the REST client uses the default zone. */
export const zones = {
  create: async (zoneName: string): Promise<void> => {
    try {
      await requireNativeModule().ckCreateZone(zoneName)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
  remove: async (zoneName: string): Promise<void> => {
    try {
      await requireNativeModule().ckDeleteZone(zoneName)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
  list: async (): Promise<string[]> => {
    try {
      return await requireNativeModule().ckListZones()
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
}
