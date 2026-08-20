import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes'

/**
 * Codegen cannot express an index signature, so dynamic dictionaries cross the
 * bridge as `UnsafeObject`. Same workaround react-native-background-downloader
 * uses for its header maps.
 */
export type UnsafeObject = { [key: string]: string }

export type RemoteChangeNativeEvent = {
  keys: string[]
  /** One of ChangeReason. Kept as a plain string - codegen has no string unions. */
  reason: string
  provider: string
}

export type AccountChangeNativeEvent = {
  /** One of AccountStatus. */
  status: string
  identityChanged: boolean
  provider: string
}

export type DocumentEntryNativeEvent = {
  name: string
  sizeBytes: number
  /** False when the file exists in the account but has no local copy yet. */
  isDownloaded: boolean
  isDownloading: boolean
}

export type AssetProgressNativeEvent = {
  recordName: string
  fieldName: string
  bytesTransferred: number
  bytesTotal: number
}

export interface Spec extends TurboModule {
  getConstants: () => {
    /** The iCloud container id resolved from entitlements, or '' if unset. */
    containerIdentifier: string
    /** True when the build carries an iCloud entitlement at all. */
    hasICloudEntitlement: boolean
  }

  // ---------------------------------------------------------------- account

  getAccountStatus: () => Promise<string>
  isAvailable: () => Promise<boolean>

  // ------------------------------------------- iCloud key-value store (KVS)

  kvGetItem: (key: string) => Promise<string | null>
  kvSetItem: (key: string, value: string) => Promise<void>
  kvRemoveItem: (key: string) => Promise<void>
  kvGetAllKeys: () => Promise<string[]>
  /**
   * Every key and value at once - one bridge hop where `kvGetAllKeys` plus N
   * `kvGetItem` calls would be N+1. Non-string values are omitted rather than
   * coerced, since a stringified number would not round-trip through
   * `kvSetItem`.
   */
  kvGetAllItems: () => Promise<UnsafeObject>
  /**
   * Flushes pending KV changes to disk.
   *
   * Note this is `NSUbiquitousKeyValueStore.synchronize()`, which despite the
   * name does NOT confirm a server round trip - it only schedules the upload.
   * Callers must not treat a resolved `kvSync()` as "the cloud has my data".
   */
  kvSync: () => Promise<boolean>

  /**
   * How full the key-value store is, against Apple's documented ceilings.
   *
   * Measured from `dictionaryRepresentation` (a local plist, not a network
   * call) because Apple exposes no usage API. Without it an app can only learn
   * it is near the 1 MB *total* by exceeding it, and exceeding it is silent.
   */
  kvGetUsage: () => Promise<{
    usedBytes: number
    totalBytes: number
    keyCount: number
    maxKeys: number
  }>

  // ------------------------------------------------------------- CloudKit

  /**
   * `encrypted` reads the value out of `CKRecord.encryptedValues` rather than
   * the plain field. A field is one or the other, never both - CloudKit records
   * encryption in the schema - so reading the wrong side returns null, which is
   * indistinguishable from a missing record.
   */
  ckGetRecord: (
    recordType: string,
    recordName: string,
    zoneName: string | null,
    encrypted: boolean
  ) => Promise<string | null>
  /**
   * `encrypted` writes through `CKRecord.encryptedValues`, so CloudKit
   * end-to-end encrypts the value with a key from the user's iCloud Keychain.
   * Nothing server-side can read it back - including CloudKit Web Services, and
   * therefore this package's Android and web paths.
   */
  ckSaveRecord: (
    recordType: string,
    recordName: string,
    value: string,
    zoneName: string | null,
    encrypted: boolean
  ) => Promise<void>
  ckDeleteRecord: (recordName: string, zoneName: string | null) => Promise<boolean>
  ckQueryRecordNames: (recordType: string, zoneName: string | null) => Promise<string[]>

  ckCreateZone: (zoneName: string) => Promise<void>
  ckDeleteZone: (zoneName: string) => Promise<void>
  ckListZones: () => Promise<string[]>

  /** Uploads a local file as a CKAsset field. Emits `onAssetProgress` while running. */
  ckSaveAsset: (
    recordType: string,
    recordName: string,
    fieldName: string,
    fileUri: string,
    zoneName: string | null
  ) => Promise<void>
  /** Downloads a CKAsset field. Emits `onAssetProgress` while running. */
  ckFetchAsset: (recordName: string, fieldName: string, zoneName: string | null) => Promise<string | null>
  /**
   * Cancels an in-flight asset transfer. Resolves true when there was one.
   *
   * The cancelled call's own promise rejects with `ERR_CANCELLED` - CloudKit
   * reports the cancellation as `CKError.operationCancelled`, which the error
   * mapper already recognises.
   */
  ckCancelAsset: (recordName: string, fieldName: string) => Promise<boolean>

  // ------------------------------------------------- iCloud Drive documents

  /** Whether a usable iCloud Drive container exists on this device right now. */
  docIsAvailable: () => Promise<boolean>
  /** Copies a local file into iCloud Drive under `name`. Resolves its iCloud path. */
  docSave: (fileUri: string, name: string) => Promise<string>
  /**
   * Ensures `name` has been downloaded and resolves a local path, or null when
   * no such file exists. Copies out to `destinationUri` when one is given.
   */
  docFetch: (
    name: string,
    destinationUri: string | null,
    timeoutMs: number
  ) => Promise<string | null>
  docList: () => Promise<DocumentEntryNativeEvent[]>
  /** Resolves true when something was deleted, false when it was already gone. */
  docRemove: (name: string) => Promise<boolean>

  // --------------------------------------------------------------- events

  readonly onRemoteChange: EventEmitter<RemoteChangeNativeEvent>
  readonly onAccountChange: EventEmitter<AccountChangeNativeEvent>
  readonly onAssetProgress: EventEmitter<AssetProgressNativeEvent>

  // -------------------------------------------------------------- tooling

  setLogsEnabled: (enabled: boolean) => void
}

export default TurboModuleRegistry.get<Spec>('RNCloudSync')
