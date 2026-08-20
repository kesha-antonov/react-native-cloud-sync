import { cloudKitBackup } from '../providers/cloudKitBackup'
import { ErrorCode } from '../errors'

interface Harness {
  module: {
    ckSaveAsset: jest.Mock
    ckFetchAsset: jest.Mock
  }
  emit: (name: string, payload: unknown) => void
  setPlatform: (os: string) => void
  reset: () => void
}

const harness = (globalThis as unknown as { __RNCloudSync: Harness }).__RNCloudSync

afterEach(() => harness.reset())

describe('cloudKitBackup on a non-native platform', () => {
  beforeEach(() => harness.setPlatform('android'))

  it('save rejects with ERR_UNSUPPORTED_PLATFORM, same as cloudKitAssets', async () => {
    await expect(
      cloudKitBackup.save('/tmp/db.sqlite')
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_PLATFORM })
  })

  it('restore rejects with ERR_UNSUPPORTED_PLATFORM', async () => {
    await expect(cloudKitBackup.restore()).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PLATFORM,
    })
  })
})

describe('cloudKitBackup on iOS', () => {
  it('save uses the default record/field names', async () => {
    harness.module.ckSaveAsset.mockResolvedValueOnce(undefined)

    await cloudKitBackup.save('/tmp/db.sqlite')

    expect(harness.module.ckSaveAsset).toHaveBeenCalledWith(
      'KVBlob', 'backup', 'file', '/tmp/db.sqlite', null
    )
  })

  it('save reports progress scoped to this transfer, as a fraction', async () => {
    const onProgress = jest.fn()
    harness.module.ckSaveAsset.mockImplementationOnce(() => {
      harness.emit('assetProgress', {
        recordName: 'backup',
        fieldName: 'file',
        bytesTransferred: 250,
        bytesTotal: 500,
      })
      return Promise.resolve()
    })

    await cloudKitBackup.save('/tmp/db.sqlite', { onProgress })

    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith({
      bytesTransferred: 250,
      bytesTotal: 500,
      fraction: 0.5,
    })
  })

  it('ignores progress events for a different record or field', async () => {
    const onProgress = jest.fn()
    harness.module.ckSaveAsset.mockImplementationOnce(() => {
      harness.emit('assetProgress', {
        recordName: 'someone-elses-upload',
        fieldName: 'file',
        bytesTransferred: 1,
        bytesTotal: 2,
      })
      harness.emit('assetProgress', {
        recordName: 'backup',
        fieldName: 'thumbnail',
        bytesTransferred: 1,
        bytesTotal: 2,
      })
      return Promise.resolve()
    })

    await cloudKitBackup.save('/tmp/db.sqlite', { onProgress })

    expect(onProgress).not.toHaveBeenCalled()
  })

  it('unsubscribes once the transfer settles, so later events are not delivered', async () => {
    const onProgress = jest.fn()
    harness.module.ckSaveAsset.mockResolvedValueOnce(undefined)

    await cloudKitBackup.save('/tmp/db.sqlite', { onProgress })
    harness.emit('assetProgress', {
      recordName: 'backup', fieldName: 'file', bytesTransferred: 500, bytesTotal: 500,
    })

    expect(onProgress).not.toHaveBeenCalled()
  })

  it('unsubscribes even when the transfer fails', async () => {
    const onProgress = jest.fn()
    harness.module.ckSaveAsset.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: ErrorCode.NETWORK_UNAVAILABLE })
    )

    await expect(cloudKitBackup.save('/tmp/db.sqlite', { onProgress })).rejects.toThrow()
    harness.emit('assetProgress', {
      recordName: 'backup', fieldName: 'file', bytesTransferred: 1, bytesTotal: 1,
    })

    expect(onProgress).not.toHaveBeenCalled()
  })

  it('restore resolves the local path and reports progress', async () => {
    const onProgress = jest.fn()
    harness.module.ckFetchAsset.mockImplementationOnce(() => {
      harness.emit('assetProgress', {
        recordName: 'backup',
        fieldName: 'file',
        bytesTransferred: 500,
        bytesTotal: 500,
      })
      return Promise.resolve('/tmp/rncs-backup-file')
    })

    const path = await cloudKitBackup.restore({ onProgress })

    expect(path).toBe('/tmp/rncs-backup-file')
    expect(onProgress).toHaveBeenCalledWith({
      bytesTransferred: 500,
      bytesTotal: 500,
      fraction: 1,
    })
  })

  it('restore resolves null when no backup exists yet', async () => {
    harness.module.ckFetchAsset.mockResolvedValueOnce(null)

    await expect(cloudKitBackup.restore()).resolves.toBeNull()
  })

  it('honours a custom recordName/fieldName/zoneName', async () => {
    harness.module.ckFetchAsset.mockResolvedValueOnce('/tmp/x')

    await cloudKitBackup.restore({ recordName: 'export-2026', fieldName: 'blob', zoneName: 'Exports' })

    expect(harness.module.ckFetchAsset).toHaveBeenCalledWith('export-2026', 'blob', 'Exports', null)
  })
})

describe('restoring somewhere the user can reach', () => {
  it('passes a destination through, for an export rather than an in-app restore', async () => {
    harness.module.ckFetchAsset.mockResolvedValueOnce('file:///docs/backup.sqlite')

    await expect(cloudKitBackup.restore({
      destinationUri: 'file:///docs/backup.sqlite',
    })).resolves.toBe('file:///docs/backup.sqlite')

    expect(harness.module.ckFetchAsset).toHaveBeenCalledWith(
      'backup', 'file', null, 'file:///docs/backup.sqlite'
    )
  })

  it('defaults to a temporary path when the caller does not care', async () => {
    // Fine for restoring straight back into the app; wrong for anything the
    // user keeps, since iOS may reclaim the temporary directory.
    await cloudKitBackup.restore()
    expect(harness.module.ckFetchAsset).toHaveBeenCalledWith('backup', 'file', null, null)
  })
})
