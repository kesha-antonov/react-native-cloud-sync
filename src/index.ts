/**
 * react-native-cloud-sync
 *
 * iCloud key-value store, CloudKit, iCloud Drive and Google Drive behind one API,
 * on iOS, Android and the web, on both React Native architectures.
 */

// Providers, each usable directly.
export {
  icloudKV,
  getAllItems as icloudKVGetAllItems,
  sync as icloudKVSync
} from './providers/icloudKV'
export {
  cloudKit,
  createCloudKitProvider,
  zones as cloudKitZones,
  assets as cloudKitAssets
} from './providers/cloudKit'
export { cloudKitBackup } from './providers/cloudKitBackup'
export { cloudKitEncrypted } from './providers/cloudKitEncrypted'
export { icloudDocuments } from './providers/icloudDocuments'
export { googleDrive, createGoogleDriveProvider } from './providers/googleDrive'
export { googleDriveFiles } from './providers/googleDriveFiles'
export { createMemoryProvider } from './providers/memory'

// The facade over them.
export {
  createCloudStore,
  type CloudStore,
  type FlushResult,
  type MigrateOptions,
  type MigrateResult,
  type OutboxStorage
} from './store'
export {
  resolveByTimestamp,
  resolveByModifiedAt,
  resolveByPreferenceOrder,
  resolveByUnion,
  resolveFirstOf
} from './resolvers'

// Key rules, for callers whose keys come from somewhere they do not control.
export { checkKey, sanitizeKey } from './internal/keys'

/**
 * The abort-signal shape the cancellable APIs accept.
 *
 * Structural rather than the DOM `AbortSignal`, so any polyfill satisfies it
 * and consumers do not need `lib.dom` in their tsconfig.
 */
export type { AbortLike } from './internal/timeout'

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
export type {
  GoogleDriveConfig, GoogleDriveFileAdapter, GoogleDriveSessionStore, GoogleDriveUploadSession
} from './internal/googleDriveRest'

// The `GoogleDriveFileAdapter` contract is base64 in and base64 out, while every
// modern filesystem API is byte-oriented - so the codec that bridges them ships
// here rather than making each adapter author find one. Dependency-free and
// Hermes-safe, which `Buffer`/`atob` are not.
export { base64ToBytes, bytesToBase64 } from './internal/base64'

// Errors - the part callers branch on.
export {
  CloudSyncError,
  ErrorCode,
  isCancelled,
  isCloudSyncError,
  isRetryable,
  requiresUserAction
} from './errors'
export type { CloudSyncErrorInfo } from './errors'

export type { BackupOptions, BackupProgressEvent } from './providers/cloudKitBackup'
export type { DocumentEntry, DocumentFetchOptions } from './providers/icloudDocuments'
export type { DriveFileFetchOptions, DriveFileProgressEvent, DriveFileSaveOptions } from './providers/googleDriveFiles'

export type {
  AccountChangeEvent,
  AccountStatus,
  AssetProgressEvent,
  AutoFlushConfig,
  BuiltInProviderName,
  ChangeReason,
  CloudProvider,
  CloudStoreOptions,
  DropReason,
  DroppedWrite,
  ItemWithMeta,
  OutboxEntry,
  ProviderName,
  QuotaInfo,
  RemoteChangeEvent,
  ResolveCandidate,
  ResolveFn,
  TieringConfig,
  Unsubscribe,
  ValueCodec,
  WriteMode
} from './types'
export { DEFAULT_TIERING } from './types'

export { setLogsEnabled } from './internal/logger'
