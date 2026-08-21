import type { CloudKitRestConfig } from './internal/cloudKitRest'
import { CloudKitRestClient } from './internal/cloudKitRest'
import type { GoogleDriveConfig, GoogleDriveFileAdapter } from './internal/googleDriveRest'
import { GoogleDriveClient } from './internal/googleDriveRest'
import { CloudSyncError, ErrorCode } from './errors'

let cloudKitClient: CloudKitRestClient | null = null
let driveClient: GoogleDriveClient | null = null
let driveFileAdapter: GoogleDriveFileAdapter | null = null

/**
 * Supplies the credentials the CloudKit REST path needs.
 *
 * Only required on Android and web. On iOS the native provider authenticates
 * implicitly through the device's signed-in iCloud account and needs none of
 * this.
 */
export function configureCloudKit(config: CloudKitRestConfig): void {
  cloudKitClient = new CloudKitRestClient(config)
}

export function getCloudKitClient(): CloudKitRestClient {
  if (cloudKitClient == null)
    throw new CloudSyncError(
      ErrorCode.CONTAINER_MISCONFIGURED,
      '[RNCloudSync] CloudKit is not configured on this platform. Call configureCloudKit({ '
      + 'containerIdentifier, apiToken, environment, getAuthToken }) before using the cloudKit '
      + 'provider on Android or web.',
      { provider: 'cloudKit' }
    )

  return cloudKitClient
}

export function isCloudKitConfigured(): boolean {
  return cloudKitClient != null
}

/** Supplies the OAuth token the Drive provider uses. Required on every platform. */
export function configureGoogleDrive(config: GoogleDriveConfig): void {
  driveClient = new GoogleDriveClient(config)
}

export function getGoogleDriveClient(): GoogleDriveClient {
  if (driveClient == null)
    throw new CloudSyncError(
      ErrorCode.CONTAINER_MISCONFIGURED,
      '[RNCloudSync] Google Drive is not configured. Call configureGoogleDrive({ '
      + 'getAccessToken }) before using the googleDrive provider.',
      { provider: 'googleDrive' }
    )

  return driveClient
}

export function isGoogleDriveConfigured(): boolean {
  return driveClient != null
}

/**
 * Supplies local file I/O for `googleDriveFiles` - large binaries that go
 * through Drive's resumable upload/download rather than `googleDrive`'s
 * whole-value-as-a-string path.
 *
 * Separate from `configureGoogleDrive` because most apps never touch a file
 * that large and shouldn't need to think about filesystem access to use
 * `googleDrive`/the store facade. Only required for `googleDriveFiles`.
 */
export function configureGoogleDriveFiles(adapter: GoogleDriveFileAdapter): void {
  driveFileAdapter = adapter
}

export function getGoogleDriveFileAdapter(): GoogleDriveFileAdapter {
  if (driveFileAdapter == null)
    throw new CloudSyncError(
      ErrorCode.CONTAINER_MISCONFIGURED,
      '[RNCloudSync] This needs a file adapter. Call configureGoogleDriveFiles({ '
      + 'statSize, readChunk, writeChunk, appendChunk }) before saving or fetching a file - shared '
      + 'by googleDriveFiles and by cloudKitAssets on Android/web.',
      { provider: 'googleDrive' }
    )

  return driveFileAdapter
}

/**
 * Same adapter and same `configureGoogleDriveFiles` call, under a name that
 * doesn't imply it's Drive-specific. `cloudKitAssets`'s REST path (Android/web)
 * reads and writes local files the exact same way `googleDriveFiles` does, and
 * asking a host app to register two near-identical adapters for that would be
 * pure friction for no benefit.
 */
export const getSharedFileAdapter = getGoogleDriveFileAdapter

export function isGoogleDriveFilesConfigured(): boolean {
  return driveFileAdapter != null
}

/** Test seam - drops all configured clients. */
export function __resetConfig(): void {
  cloudKitClient = null
  driveClient = null
  driveFileAdapter = null
}
