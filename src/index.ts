/**
 * @kesha-antonov/react-native-cloud-storage
 *
 * iCloud key-value store, CloudKit and Google Drive behind one API, on iOS,
 * Android and the web, on both React Native architectures.
 */

// Providers, each usable directly.
export { icloudKV, sync as icloudKVSync } from './providers/icloudKV'
export { cloudKit, zones as cloudKitZones } from './providers/cloudKit'
export { googleDrive } from './providers/googleDrive'
export { createMemoryProvider } from './providers/memory'

// The facade over them.
export { createCloudStore, type CloudStore, type OutboxStorage } from './store'

// Configuration for the REST-backed paths.
export {
  configureCloudKit,
  configureGoogleDrive,
  isCloudKitConfigured,
  isGoogleDriveConfigured
} from './config'

export type { CloudKitRestConfig } from './internal/cloudKitRest'
export type { GoogleDriveConfig } from './internal/googleDriveRest'

// Errors - the part callers branch on.
export {
  CloudStorageError,
  ErrorCode,
  isCloudStorageError,
  isRetryable,
  requiresUserAction
} from './errors'
export type { CloudStorageErrorInfo } from './errors'

export type {
  AccountChangeEvent,
  AccountStatus,
  ChangeReason,
  CloudProvider,
  CloudStoreOptions,
  OutboxEntry,
  ProviderName,
  RemoteChangeEvent,
  TieringConfig,
  Unsubscribe
} from './types'
export { DEFAULT_TIERING } from './types'

export { setLogsEnabled } from './internal/logger'
