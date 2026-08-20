import { Platform } from 'react-native'

import { getNativeModule, hasNativeModule, requireNativeModule, subscribeNativeEvent } from '../internal/nativeModule'
import { getCloudKitClient, isCloudKitConfigured } from '../config'
import { CloudKitRestClient, type CloudKitRestConfig } from '../internal/cloudKitRest'
import { normalizeError, unsupportedPlatform } from '../errors'
import { toAccountStatus, toChangeReason } from '../internal/enums'
import type {
  AccountChangeEvent,
  AccountStatus,
  AssetProgressEvent,
  CloudProvider,
  ProviderName,
  RemoteChangeEvent,
  Unsubscribe,
} from '../types'
import type {
  AccountChangeNativeEvent,
  AssetProgressNativeEvent,
  RemoteChangeNativeEvent,
} from '../specs/NativeRNCloudSync'

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
  // `Platform?.OS` rather than `Platform.OS`: on a react-native-web build served
  // by a bundler that does not resolve platform extensions, this module is what
  // loads, and it has to answer 'not native' rather than throw.
  const os: string | undefined = Platform?.OS
  return (os === 'ios' || os === 'macos') && hasNativeModule()
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
      // Memoised inside the client: the store asks before every provider read,
      // and an unmemoised probe made each read cost two network round trips.
      return await getCloudKitClient().isReachable()
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
      if (isNative()) return await requireNativeModule().ckGetRecord('KVBlob', key, null, false)
      return await getCloudKitClient().getRecord(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Server modification time, over REST only.
   *
   * CloudKit returns `modified.timestamp` on every lookup, so the REST path
   * gets it for free. The native path would need a new bridge method and a
   * second field on every response for a value only the resolver uses, so it
   * reports no timestamp and falls back to preference order - which is what
   * {@link resolveByModifiedAt} is built to handle.
   */
  getItemWithMeta: async (key: string) => {
    if (isNative()) {
      const value = await cloudKit.getItem(key)
      return value == null ? null : { value }
    }
    try {
      return await getCloudKitClient().getRecordWithMeta(key)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Reads many records in one request, over REST.
   *
   * `/records/lookup` takes an array, so this is the difference between one
   * round trip and N - and between one rate-limit budget and N.
   */
  multiGet: async (keys: string[]) => {
    if (isNative()) {
      const out: (string | null)[] = []
      for (const key of keys)
        out.push(await requireNativeModule().ckGetRecord('KVBlob', key, null, false))
      return out
    }
    try {
      return await getCloudKitClient().getRecords(keys)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  multiSet: async (entries: [string, string][]) => {
    if (isNative()) {
      for (const [key, value] of entries)
        await requireNativeModule().ckSaveRecord('KVBlob', key, value, null, false)
      return
    }
    try {
      await getCloudKitClient().saveRecords(entries)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  multiRemove: async (keys: string[]) => {
    if (isNative()) {
      for (const key of keys) await requireNativeModule().ckDeleteRecord(key, null)
      return
    }
    try {
      await getCloudKitClient().deleteRecords(keys)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  clearCaches: () => {
    // The memoised reachability answer was recorded for the previous account's
    // web auth token and says nothing about the new one.
    if (!isNative() && isCloudKitConfigured()) getCloudKitClient().clearCache()
  },

  setItem: async (key: string, value: string) => {
    try {
      if (isNative()) {
        await requireNativeModule().ckSaveRecord('KVBlob', key, value, null, false)
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

/**
 * A CloudKit provider with its own REST credentials and its own name.
 *
 * `configureCloudKit` sets one client for the whole process. That is right for
 * a normal app, but leaves no way to reach two containers at once - a staging
 * container beside production, or a migration that copies between them - and no
 * way for two tests to hold different configurations.
 *
 * REST only, and that is not a limitation that can be lifted: the native path
 * authenticates as whatever iCloud account the *device* is signed into, so
 * "another set of credentials" has no meaning there. On iOS this therefore
 * still talks to CloudKit Web Services rather than to `CloudKit.framework`.
 */
export function createCloudKitProvider(
  config: CloudKitRestConfig & { name?: ProviderName }
): CloudProvider {
  const client = new CloudKitRestClient(config)
  const name = config.name ?? NAME

  return {
    name,

    isAvailable: async () => {
      try {
        return await client.isReachable()
      }
      catch {
        return false
      }
    },

    getAccountStatus: () => Promise.resolve<AccountStatus>('available'),

    getItem: async (key: string) => {
      try {
        return await client.getRecord(key)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    getItemWithMeta: async (key: string) => {
      try {
        return await client.getRecordWithMeta(key)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    setItem: async (key: string, value: string) => {
      try {
        await client.saveRecord(key, value)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    removeItem: async (key: string) => {
      try {
        await client.deleteRecord(key)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    getAllKeys: async () => {
      try {
        return await client.queryRecordNames()
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    multiGet: async (keys: string[]) => {
      try {
        return await client.getRecords(keys)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    multiSet: async (entries: [string, string][]) => {
      try {
        await client.saveRecords(entries)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    multiRemove: async (keys: string[]) => {
      try {
        await client.deleteRecords(keys)
      }
      catch (e) {
        throw normalizeError(e, name)
      }
    },

    clearCaches: () => {
      client.clearCache()
    },
  }
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

/**
 * Binary assets (`CKAsset`).
 *
 * Native only. CloudKit Web Services does expose an asset upload flow, but it
 * is a separate multi-step protocol (request an upload URL, POST the bytes,
 * then reference the returned token in a record) that this package does not
 * implement yet - so on Android and web these reject with
 * `ERR_UNSUPPORTED_PLATFORM` rather than appearing to work.
 *
 * Assets are deliberately an explicit API rather than something the store
 * facade routes to automatically: the caller passes a file path, not a string,
 * so there is no way to infer the intent from a `setItem` call.
 */
export const assets = {
  /**
   * Uploads a local file as a field on a record.
   *
   * Progress is reported per record through {@link onProgress}; a CKAsset is
   * streamed from disk, so a large file does not have to be held in memory the
   * way a base64 round trip would.
   */
  save: async (
    options: {
      recordName: string
      fieldName: string
      /** `file://` URL or a plain path. */
      fileUri: string
      recordType?: string
      zoneName?: string | null
    }
  ): Promise<void> => {
    if (!isNative())
      throw unsupportedPlatform(
        NAME,
        'CKAsset upload is implemented natively only. On Android and web, store the file '
        + 'with the googleDrive provider instead.'
      )

    try {
      await requireNativeModule().ckSaveAsset(
        options.recordType ?? 'KVBlob',
        options.recordName,
        options.fieldName,
        options.fileUri,
        options.zoneName ?? null
      )
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Downloads an asset field and resolves a local file path, or `null` when the
   * record or field does not exist.
   */
  fetch: async (
    options: { recordName: string; fieldName: string; zoneName?: string | null }
  ): Promise<string | null> => {
    if (!isNative())
      throw unsupportedPlatform(
        NAME,
        'CKAsset download is implemented natively only.'
      )

    try {
      return await requireNativeModule().ckFetchAsset(
        options.recordName,
        options.fieldName,
        options.zoneName ?? null
      )
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Cancels an in-flight {@link save} or {@link fetch}, rejecting that call
   * with `ERR_CANCELLED`. Resolves true when there was a transfer to cancel.
   *
   * Identified by record and field rather than by a handle, because that is
   * what identifies a transfer everywhere else in this API - `onProgress`
   * reports the same pair, so a UI already has it.
   */
  cancel: async (
    options: { recordName: string; fieldName: string }
  ): Promise<boolean> => {
    if (!isNative()) return false
    try {
      return await requireNativeModule().ckCancelAsset(options.recordName, options.fieldName)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /** Upload/download progress for asset transfers. Native only. */
  onProgress: (listener: (e: AssetProgressEvent) => void): Unsubscribe => {
    if (getNativeModule() == null) return () => undefined
    return subscribeNativeEvent<AssetProgressNativeEvent>(
      'onAssetProgress',
      'assetProgress',
      (e) => {
        listener({
          recordName: e.recordName,
          fieldName: e.fieldName,
          bytesTransferred: e.bytesTransferred,
          bytesTotal: e.bytesTotal,
        })
      }
    )
  },
}
