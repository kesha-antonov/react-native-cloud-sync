import { getGoogleDriveClient, getGoogleDriveFileAdapter } from '../config'
import { normalizeError } from '../errors'
import { base64ToBytes, bytesToBase64 } from '../internal/base64'
import type { DriveChunkSink, DriveChunkSource } from '../internal/googleDriveRest'
import type { AbortLike } from '../internal/timeout'

const NAME = 'googleDrive' as const

export interface DriveFileProgressEvent {
  bytesTransferred: number
  bytesTotal: number
  /** `bytesTransferred / bytesTotal`, or 0 while `bytesTotal` is still 0. */
  fraction: number
}

export interface DriveFileSaveOptions {
  /** Called repeatedly while the upload is in flight. */
  onProgress?: (e: DriveFileProgressEvent) => void
  /**
   * Cancels the transfer, rejecting with `ERR_CANCELLED`.
   *
   * Checked between chunks, so a cancel takes effect during the transfer rather
   * than only once the whole file has moved - which is the entire point when
   * the file is several hundred megabytes. Bytes already accepted stay in the
   * resumable session; a later `save` of the same name starts a fresh one.
   *
   * Typed structurally rather than as the DOM `AbortSignal`, so any polyfill
   * works and consumers do not need `lib.dom` in their tsconfig.
   */
  signal?: AbortLike
}

export interface DriveFileFetchOptions {
  /** Called repeatedly while the download is in flight. */
  onProgress?: (e: DriveFileProgressEvent) => void
  /** Cancels the transfer, rejecting with `ERR_CANCELLED`. Checked between chunks. */
  signal?: AbortLike
}

/**
 * Binary files in Drive's `appDataFolder`, for anything too large to hold in
 * memory as a JS string the way `googleDrive.setItem` does - the Android/web
 * equivalent of `cloudKitAssets`' `CKAsset` on Apple platforms.
 *
 * Uploads use Drive's resumable protocol, reading the source in fixed chunks;
 * downloads write in the same fixed chunks. Neither ever holds more than one
 * chunk (8 MiB by default) in memory. Both go through a `GoogleDriveFileAdapter`
 * (`configureGoogleDriveFiles`) for the actual disk I/O - this package has no
 * filesystem dependency of its own, so the host app supplies one using
 * whichever fs library it already has. See the CloudKit/Google Drive guides
 * for the file adapter's exact contract and setup examples.
 */
export const googleDriveFiles = {
  /** Uploads `fileUri` as `name`, overwriting whatever was there. */
  save: async (
    options: { name: string; fileUri: string } & DriveFileSaveOptions
  ): Promise<void> => {
    const adapter = getGoogleDriveFileAdapter()

    try {
      const size = await adapter.statSize(options.fileUri)
      const source: DriveChunkSource = {
        size,
        read: async (start, length) =>
          base64ToBytes(await adapter.readChunk(options.fileUri, start, length)),
      }

      await getGoogleDriveClient().uploadFile(
        options.name, source, forward(options.onProgress), options.signal
      )
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },

  /**
   * Downloads `name` into `destinationUri`, resolving `destinationUri` back
   * once complete, or `null` when no such file exists - `destinationUri` is
   * never touched in that case.
   */
  fetch: async (
    options: { name: string; destinationUri: string } & DriveFileFetchOptions
  ): Promise<string | null> => {
    const adapter = getGoogleDriveFileAdapter()

    const sink: DriveChunkSink = {
      write: async (bytes, isFirstChunk) => {
        const base64 = bytesToBase64(bytes)
        if (isFirstChunk) await adapter.writeChunk(options.destinationUri, base64)
        else await adapter.appendChunk(options.destinationUri, base64)
      },
    }

    try {
      const found = await getGoogleDriveClient().downloadFile(
        options.name, sink, forward(options.onProgress), options.signal
      )
      return found ? options.destinationUri : null
    }
    catch (e) {
      throw normalizeError(e, NAME)
    }
  },
}

function forward(
  onProgress: DriveFileSaveOptions['onProgress']
): ((bytesTransferred: number, bytesTotal: number) => void) | undefined {
  if (onProgress == null) return undefined
  return (bytesTransferred, bytesTotal) =>
    onProgress({
      bytesTransferred,
      bytesTotal,
      fraction: bytesTotal > 0 ? bytesTransferred / bytesTotal : 0,
    })
}
