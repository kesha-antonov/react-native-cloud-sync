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
   * Flushes pending KV changes to disk.
   *
   * Note this is `NSUbiquitousKeyValueStore.synchronize()`, which despite the
   * name does NOT confirm a server round trip - it only schedules the upload.
   * Callers must not treat a resolved `kvSync()` as "the cloud has my data".
   */
  kvSync: () => Promise<boolean>

  // ------------------------------------------------------------- CloudKit

  ckGetRecord: (recordType: string, recordName: string, zoneName: string | null) => Promise<string | null>
  ckSaveRecord: (
    recordType: string,
    recordName: string,
    value: string,
    zoneName: string | null
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
  ckFetchAsset: (recordName: string, fieldName: string, zoneName: string | null) => Promise<string | null>

  // --------------------------------------------------------------- events

  readonly onRemoteChange: EventEmitter<RemoteChangeNativeEvent>
  readonly onAccountChange: EventEmitter<AccountChangeNativeEvent>
  readonly onAssetProgress: EventEmitter<AssetProgressNativeEvent>

  // -------------------------------------------------------------- tooling

  setLogsEnabled: (enabled: boolean) => void
}

export default TurboModuleRegistry.get<Spec>('RNCloudSync')
