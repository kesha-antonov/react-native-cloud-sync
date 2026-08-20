import { assets } from './cloudKit'
import type { AssetProgressEvent } from '../types'

const DEFAULT_RECORD_NAME = 'backup'
const DEFAULT_FIELD_NAME = 'file'

export interface BackupProgressEvent {
  bytesTransferred: number
  bytesTotal: number
  /**
   * `bytesTransferred / bytesTotal`, or 0 while `bytesTotal` is still unknown.
   * `save` knows the size from the first callback (the file is local);
   * `restore` does too, as long as the backup was written by a version of this
   * package that stores the size alongside the asset - older backups fall back
   * to 0 until the transfer completes.
   */
  fraction: number
}

export interface BackupOptions {
  /** CKRecord name identifying this backup. Default `'backup'`. */
  recordName?: string
  /** Asset field name on that record. Default `'file'`. */
  fieldName?: string
  zoneName?: string | null
  /** Called repeatedly while the transfer is in flight, scoped to this call only. */
  onProgress?: (e: BackupProgressEvent) => void
}

/**
 * Backup/restore built on {@link assets} (`CKAsset`), for a single named blob -
 * a database export, an archive, anything too big for a `CKRecord` field.
 *
 * `cloudKitAssets.onProgress` is a global feed shared by every asset transfer
 * in the app, keyed by `recordName`/`fieldName`, so a caller backing up one
 * file would otherwise have to filter it and manage the subscription by hand.
 * This scopes that to the single transfer each call makes, and unsubscribes
 * when it settles - including on failure.
 *
 * Native only, same as `cloudKitAssets` - rejects with `ERR_UNSUPPORTED_PLATFORM`
 * on Android and web.
 */
export const cloudKitBackup = {
  /**
   * Uploads `fileUri` as this backup's CKAsset, overwriting whatever was there.
   */
  save: async (fileUri: string, options: BackupOptions = {}): Promise<void> => {
    const recordName = options.recordName ?? DEFAULT_RECORD_NAME
    const fieldName = options.fieldName ?? DEFAULT_FIELD_NAME

    const unsubscribe = subscribeScoped(recordName, fieldName, options.onProgress)
    try {
      await assets.save({ recordName, fieldName, fileUri, zoneName: options.zoneName })
    }
    finally {
      unsubscribe()
    }
  },

  /**
   * Downloads the backup to a local file path, or resolves `null` when none
   * has been saved yet.
   */
  restore: async (options: BackupOptions = {}): Promise<string | null> => {
    const recordName = options.recordName ?? DEFAULT_RECORD_NAME
    const fieldName = options.fieldName ?? DEFAULT_FIELD_NAME

    const unsubscribe = subscribeScoped(recordName, fieldName, options.onProgress)
    try {
      return await assets.fetch({ recordName, fieldName, zoneName: options.zoneName })
    }
    finally {
      unsubscribe()
    }
  },
}

function subscribeScoped(
  recordName: string,
  fieldName: string,
  onProgress: BackupOptions['onProgress']
): () => void {
  if (onProgress == null) return () => undefined

  return assets.onProgress((e: AssetProgressEvent) => {
    if (e.recordName !== recordName || e.fieldName !== fieldName) return
    onProgress({
      bytesTransferred: e.bytesTransferred,
      bytesTotal: e.bytesTotal,
      fraction: e.bytesTotal > 0 ? e.bytesTransferred / e.bytesTotal : 0,
    })
  })
}
