import { Platform } from 'react-native'

import { getNativeModule, hasNativeModule, requireNativeModule, subscribeNativeEvent } from '../internal/nativeModule'
import { getCloudKitClient, getSharedFileAdapter, isCloudKitConfigured } from '../config'
import { CloudKitRestClient, type CloudKitRestConfig, MAX_ASSET_UPLOAD_BYTES } from '../internal/cloudKitRest'
import { CloudSyncError, ErrorCode, normalizeError, unsupportedPlatform } from '../errors'
import { toAccountStatus } from '../internal/enums'
import { base64ToBytes, bytesToBase64 } from '../internal/base64'
import type {
  AccountChangeEvent,
  AccountStatus,
  AssetProgressEvent,
  CloudProvider,
  ProviderName,
  Unsubscribe,
} from '../types'
import type {
  AccountChangeNativeEvent,
  AssetProgressNativeEvent,
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

  /**
   * Deliberately absent, rather than present and silent.
   *
   * This provider used to expose `onRemoteChange`, and it could never fire: the
   * only `remoteChange` the native layer emits comes from
   * `NSUbiquitousKeyValueStore.didChangeExternallyNotification` and is tagged
   * `icloudKV`, so the filter here never matched. A subscription that accepts a
   * listener and never calls it is worse than no method at all - the caller has
   * no way to tell it apart from "nothing has changed yet".
   *
   * Implementing it properly is not a small gap to paper over. CloudKit reports
   * record changes through `CKFetchRecordZoneChangesOperation` with a server
   * change token, and that only works in a **custom zone** - the default zone,
   * which this provider uses so that record names stay addressable from the
   * REST client, does not support change tokens at all. The alternatives are a
   * `CKDatabaseSubscription` delivered over APNs, which needs push entitlements
   * and a silent-notification handler in the host app. Either is a real feature
   * with a schema or entitlement cost, not a missing line.
   *
   * Until then: `cloudKit.onRemoteChange == null` is checkable, `icloudKV` and
   * `googleDrive` both report changes, and `onAccountChange` below does fire.
   */

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
 * Listeners for asset progress on Android/web, where there is no native event
 * emitter to bridge - {@link assets.onProgress} subscribes here instead when
 * not native, and the REST upload/download path publishes into it.
 */
const restAssetProgressListeners = new Set<(e: AssetProgressEvent) => void>()

function publishRestAssetProgress(e: AssetProgressEvent): void {
  for (const listener of restAssetProgressListeners) listener(e)
}

/**
 * Binary assets (`CKAsset`).
 *
 * Native on iOS/macOS. On Android and web, `save`/`fetch` go through CloudKit
 * Web Services' own asset-upload protocol (request a single-use upload URL,
 * POST the bytes, attach the returned descriptor to the record) - see
 * {@link MAX_ASSET_UPLOAD_BYTES} for the one hard limit that comes with it.
 * Custom zones and the native temporary-directory fallback remain native-only
 * (`ERR_UNSUPPORTED_PLATFORM`), since the REST client has no equivalent of
 * either.
 *
 * Assets are deliberately an explicit API rather than something the store
 * facade routes to automatically: the caller passes a file path, not a string,
 * so there is no way to infer the intent from a `setItem` call.
 */
export const assets = {
  /**
   * Uploads a local file as a field on a record.
   *
   * Progress is reported per record through {@link onProgress}. Natively, a
   * `CKAsset` is streamed from disk so a large file never has to be held in
   * memory; over REST the whole file is read once, which is fine given
   * {@link MAX_ASSET_UPLOAD_BYTES} - CloudKit Web Services itself caps a
   * single asset upload at 15 MB, so nothing this package could stream would
   * ever be large enough to need it.
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
    if (isNative()) {
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
      return
    }

    if (options.zoneName != null)
      throw unsupportedPlatform(
        NAME,
        'Custom zones are implemented natively only; the REST client uses the default zone.'
      )

    try {
      // Checked in this order deliberately: whether CloudKit itself is even
      // reachable is the more fundamental requirement, so it should surface
      // first rather than being masked by a missing file adapter.
      const client = getCloudKitClient()
      const adapter = getSharedFileAdapter()
      const size = await adapter.statSize(options.fileUri)
      if (size > MAX_ASSET_UPLOAD_BYTES)
        throw new CloudSyncError(
          ErrorCode.PAYLOAD_TOO_LARGE,
          `[RNCloudSync] '${options.fileUri}' is ${size} bytes; CloudKit Web Services caps a single `
          + `asset upload at ${MAX_ASSET_UPLOAD_BYTES} bytes. Use the googleDrive provider for larger `
          + `files on Android and web.`,
          { provider: NAME, limitBytes: MAX_ASSET_UPLOAD_BYTES, actualBytes: size }
        )

      const bytes = base64ToBytes(await adapter.readChunk(options.fileUri, 0, size))
      await client.uploadAsset(
        options.recordName,
        options.fieldName,
        bytes,
        (bytesTransferred, bytesTotal) => publishRestAssetProgress({
          recordName: options.recordName,
          fieldName: options.fieldName,
          bytesTransferred,
          bytesTotal,
        }),
        options.recordType
      )
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Downloads an asset field and resolves a local file path, or `null` when the
   * record or field does not exist.
   *
   * Pass `destinationUri` for anything the user is going to keep or hand to a
   * share sheet. Natively, without it the file lands in the app's temporary
   * directory under a name derived from the record, and iOS may reclaim that
   * at any time - fine for restoring straight back into the app, wrong for an
   * export. Parent directories are created if they do not exist. Over REST,
   * `destinationUri` is required: there is no OS-managed temporary directory
   * this package can fall back to without a native module.
   */
  fetch: async (
    options: {
      recordName: string
      fieldName: string
      zoneName?: string | null
      destinationUri?: string
    }
  ): Promise<string | null> => {
    if (isNative())
      try {
        return await requireNativeModule().ckFetchAsset(
          options.recordName,
          options.fieldName,
          options.zoneName ?? null,
          options.destinationUri ?? null
        )
      }
      catch (e) {
        throw normalizeError(e, NAME)
      }

    if (options.zoneName != null)
      throw unsupportedPlatform(
        NAME,
        'Custom zones are implemented natively only; the REST client uses the default zone.'
      )
    if (options.destinationUri == null)
      throw unsupportedPlatform(
        NAME,
        'A default temporary-directory destination is implemented natively only. Pass '
        + 'destinationUri explicitly on Android and web.'
      )

    try {
      const bytes = await getCloudKitClient().fetchAsset(
        options.recordName,
        options.fieldName,
        (bytesTransferred, bytesTotal) => publishRestAssetProgress({
          recordName: options.recordName,
          fieldName: options.fieldName,
          bytesTransferred,
          bytesTotal,
        })
      )
      if (bytes == null) return null

      await getSharedFileAdapter().writeChunk(options.destinationUri, bytesToBase64(bytes))
      return options.destinationUri
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
   *
   * Native only, still - the REST transfer has no in-flight handle to cancel
   * yet. Resolves `false` on Android/web rather than throwing, the same as
   * before, so this is a known gap rather than a broken promise: a REST
   * `save`/`fetch` cannot currently be stopped once started.
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

  /**
   * Upload/download progress for asset transfers.
   *
   * Native on iOS/macOS, bridged from the same event every transfer already
   * reports. On Android/web there is no native module to bridge, so this
   * subscribes to the in-JS feed the REST `save`/`fetch` path publishes into
   * instead - same event shape either way.
   */
  onProgress: (listener: (e: AssetProgressEvent) => void): Unsubscribe => {
    if (isNative())
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

    restAssetProgressListeners.add(listener)
    return () => restAssetProgressListeners.delete(listener)
  },
}
