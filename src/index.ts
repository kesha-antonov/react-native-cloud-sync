/**
 * react-native-cloud-sync
 *
 * iCloud key-value store, CloudKit and Google Drive behind one API, on iOS,
 * Android and the web, on both React Native architectures.
 */

// Providers, each usable directly.
export { icloudKV, sync as icloudKVSync } from './providers/icloudKV'
export { cloudKit, zones as cloudKitZones, assets as cloudKitAssets } from './providers/cloudKit'
export { cloudKitBackup } from './providers/cloudKitBackup'
export { googleDrive } from './providers/googleDrive'
export { googleDriveFiles } from './providers/googleDriveFiles'
export { createMemoryProvider } from './providers/memory'

// The facade over them.
export { createCloudStore, type CloudStore, type OutboxStorage } from './store'
export { resolveByTimestamp, resolveByPreferenceOrder } from './resolvers'

// Configuration for the REST-backed paths.
export {
  configureCloudKit,
  configureGoogleDrive,
  configureGoogleDriveFiles,
  isCloudKitConfigured,
  isGoogleDriveConfigured,
  isGoogleDriveFilesConfigured
} from './config'

export type { CloudKitRestConfig } from './internal/cloudKitRest'
export type { GoogleDriveConfig, GoogleDriveFileAdapter } from './internal/googleDriveRest'

// Errors - the part callers branch on.
export {
  CloudSyncError,
  ErrorCode,
  isCloudSyncError,
  isRetryable,
  requiresUserAction
} from './errors'
export type { CloudSyncErrorInfo } from './errors'

export type { BackupOptions, BackupProgressEvent } from './providers/cloudKitBackup'
export type { DriveFileFetchOptions, DriveFileProgressEvent, DriveFileSaveOptions } from './providers/googleDriveFiles'

export type {
  AccountChangeEvent,
  AccountStatus,
  AssetProgressEvent,
  ChangeReason,
  CloudProvider,
  CloudStoreOptions,
  OutboxEntry,
  ProviderName,
  RemoteChangeEvent,
  ResolveCandidate,
  ResolveFn,
  TieringConfig,
  Unsubscribe
} from './types'
export { DEFAULT_TIERING } from './types'

export { setLogsEnabled } from './internal/logger'
