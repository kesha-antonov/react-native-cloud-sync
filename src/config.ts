import type { CloudKitRestConfig } from './internal/cloudKitRest'
import { CloudKitRestClient } from './internal/cloudKitRest'
import type { GoogleDriveConfig } from './internal/googleDriveRest'
import { GoogleDriveClient } from './internal/googleDriveRest'
import { CloudStorageError, ErrorCode } from './errors'

let cloudKitClient: CloudKitRestClient | null = null
let driveClient: GoogleDriveClient | null = null

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
    throw new CloudStorageError(
      ErrorCode.CONTAINER_MISCONFIGURED,
      '[RNCloudStorage] CloudKit is not configured on this platform. Call configureCloudKit({ '
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
    throw new CloudStorageError(
      ErrorCode.CONTAINER_MISCONFIGURED,
      '[RNCloudStorage] Google Drive is not configured. Call configureGoogleDrive({ '
      + 'getAccessToken }) before using the googleDrive provider.',
      { provider: 'googleDrive' }
    )

  return driveClient
}

export function isGoogleDriveConfigured(): boolean {
  return driveClient != null
}

/** Test seam - drops all configured clients. */
export function __resetConfig(): void {
  cloudKitClient = null
  driveClient = null
}
