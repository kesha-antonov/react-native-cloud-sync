import { Platform } from 'react-native'

import { getNativeModule, requireNativeModule } from '../internal/nativeModule'
import { normalizeError, unsupportedPlatform } from '../errors'

const NAME = 'icloudDocuments' as const

const APPLE_PLATFORMS = ['ios', 'macos'] as const

/** Default wait for a file to come down from iCloud before reporting a timeout. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000

function isApplePlatform(): boolean {
  const os: string | undefined = Platform?.OS
  return os != null && (APPLE_PLATFORMS as readonly string[]).includes(os)
}

function assertSupported(): void {
  if (!isApplePlatform() || getNativeModule() == null)
    throw unsupportedPlatform(
      NAME,
      'iCloud Drive is an Apple filesystem feature with no REST or browser equivalent. '
      + 'Use googleDriveFiles for user-visible files on Android and web.'
    )
}

export interface DocumentEntry {
  name: string
  sizeBytes: number
  /**
   * False when the file exists in the account but has no local copy on this
   * device.
   *
   * The distinction that makes iCloud Drive different from a normal directory:
   * a listing shows files this device has never downloaded, and reading one
   * without calling {@link icloudDocuments.fetch} first gives you nothing.
   */
  isDownloaded: boolean
  isDownloading: boolean
}

export interface DocumentFetchOptions {
  /**
   * Copy the file here once it is downloaded, and resolve this path instead of
   * the in-container one.
   *
   * Worth doing for anything you intend to keep: the system may evict a
   * downloaded copy from the container to reclaim space, turning it back into a
   * placeholder.
   */
  destinationUri?: string
  /**
   * How long to wait for the download. Default 60000.
   *
   * A timeout is not a failure of the transfer - iOS keeps downloading in the
   * background - so `ERR_TIMEOUT` here means "not yet", and it is classified as
   * retryable for exactly that reason.
   */
  timeoutMs?: number
}

/**
 * Files in the user's own iCloud Drive.
 *
 * This is the one thing no `CKRecord` or `CKAsset` API can do, and the most
 * common iCloud request in mobile apps: *put this file where the user can find
 * it*. A `CKAsset` lives in the app's private CloudKit database - the user
 * cannot see it, open it, or hand it to another app. A file written here lands
 * in the app's folder in iCloud Drive, visible in Files.app, syncing to every
 * device signed into the same Apple ID, and surviving the app being deleted.
 *
 * Requirements beyond the CloudKit entitlement:
 *
 *   - the **iCloud Documents** service on the container (the config plugin's
 *     `iCloudDocuments: true` option adds it);
 *   - an `NSUbiquitousContainers` Info.plist entry with
 *     `NSUbiquitousContainerIsDocumentScopePublic` set, or the folder syncs but
 *     stays invisible in Files.app. The plugin writes this too.
 *
 * Apple platforms only, and unlike the other providers that is not a gap to be
 * filled later: there is no REST surface for iCloud Drive and no browser API.
 * Use {@link googleDriveFiles} for user-visible files elsewhere.
 *
 * Not a {@link CloudProvider}: the contract there is keys to string values, and
 * this moves files by path. Same reason `cloudKitAssets` is its own API.
 */
export const icloudDocuments = {
  /** Whether this device has a usable iCloud Drive container right now. */
  isAvailable: async (): Promise<boolean> => {
    if (!isApplePlatform()) return false
    const m = getNativeModule()
    if (m == null) return false
    try {
      return await m.docIsAvailable()
    }
    catch {
      return false
    }
  },

  /**
   * Copies a local file into iCloud Drive under `name`, replacing whatever was
   * there. Resolves the resulting iCloud path.
   *
   * Resolving means "handed to iCloud", not "in the cloud" - the system uploads
   * in the background whether or not the app is running. Same distinction as
   * `icloudKVSync()`, and for the same reason: there is no API that waits for
   * the upload.
   */
  save: async (options: { fileUri: string; name: string }): Promise<string> => {
    assertSupported()
    try {
      return await requireNativeModule().docSave(options.fileUri, options.name)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Downloads `name` if this device does not have it yet, then resolves a local
   * path - or `null` when no such file exists in the account.
   *
   * The download step is the point. A file listed by {@link list} may be a
   * placeholder with no local bytes, and opening that gives you an empty file
   * rather than an error.
   *
   * Byte-level progress is not reported: that needs an `NSMetadataQuery`, which
   * needs a live run loop, and this runs off the main thread on purpose. Use
   * {@link list} to poll `isDownloading` if you need to show something.
   */
  fetch: async (
    options: { name: string } & DocumentFetchOptions
  ): Promise<string | null> => {
    assertSupported()
    try {
      return await requireNativeModule().docFetch(
        options.name,
        options.destinationUri ?? null,
        options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
      )
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Everything in the app's iCloud Drive folder, including files this device
   * has not downloaded.
   */
  list: async (): Promise<DocumentEntry[]> => {
    assertSupported()
    try {
      return await requireNativeModule().docList()
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Deletes a file from iCloud Drive - on every device, and from the user's
   * Files.app. Resolves false when it was already gone.
   */
  remove: async (name: string): Promise<boolean> => {
    assertSupported()
    try {
      return await requireNativeModule().docRemove(name)
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
}
