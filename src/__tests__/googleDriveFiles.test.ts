import { googleDriveFiles } from '../providers/googleDriveFiles'
import { configureGoogleDrive, configureGoogleDriveFiles, __resetConfig } from '../config'
import { base64ToBytes, bytesToBase64 } from '../internal/base64'
import { ErrorCode } from '../errors'
import type { GoogleDriveFileAdapter } from '../internal/googleDriveRest'

afterEach(() => __resetConfig())

describe('googleDriveFiles without a configured adapter', () => {
  it('save rejects with ERR_CONTAINER_MISCONFIGURED, naming the fix', async () => {
    configureGoogleDrive({ getAccessToken: () => 'token' })

    await expect(
      googleDriveFiles.save({ name: 'backup.db', fileUri: '/tmp/backup.db' })
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_MISCONFIGURED })
    await expect(
      googleDriveFiles.save({ name: 'backup.db', fileUri: '/tmp/backup.db' })
    ).rejects.toThrow(/configureGoogleDriveFiles/)
  })

  it('fetch rejects with ERR_CONTAINER_MISCONFIGURED', async () => {
    configureGoogleDrive({ getAccessToken: () => 'token' })

    await expect(
      googleDriveFiles.fetch({ name: 'backup.db', destinationUri: '/tmp/restored.db' })
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_MISCONFIGURED })
  })
})

/** An in-memory filesystem, exercising real base64 round-tripping end to end. */
function memoryAdapter(): GoogleDriveFileAdapter {
  const files = new Map<string, Uint8Array>()

  return {
    statSize: uri => Promise.resolve(files.get(uri)?.length ?? 0),
    readChunk: (uri, position, length) => {
      const bytes = files.get(uri) ?? new Uint8Array(0)
      return Promise.resolve(bytesToBase64(bytes.slice(position, position + length)))
    },
    writeChunk: (uri, base64) => {
      files.set(uri, base64ToBytes(base64))
      return Promise.resolve()
    },
    appendChunk: (uri, base64) => {
      const existing = files.get(uri) ?? new Uint8Array(0)
      const added = base64ToBytes(base64)
      const combined = new Uint8Array(existing.length + added.length)
      combined.set(existing)
      combined.set(added, existing.length)
      files.set(uri, combined)
      return Promise.resolve()
    },
  }
}

describe('googleDriveFiles', () => {
  function setUp(driveResponses: unknown[] = []) {
    const adapter = memoryAdapter()
    let i = 0
    const fetchImpl = (() => {
      const r = driveResponses[Math.min(i, driveResponses.length - 1)] as {
        status?: number
        json?: unknown
        headers?: Record<string, string>
        arrayBuffer?: ArrayBuffer
      }
      i += 1
      const status = r.status ?? 200
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(r.headers ?? {}),
        json: () => Promise.resolve(r.json ?? {}),
        arrayBuffer: () => Promise.resolve(r.arrayBuffer ?? new ArrayBuffer(0)),
      } as unknown as Response)
    }) as unknown as typeof fetch

    configureGoogleDrive({ getAccessToken: () => 'token', fetchImpl, chunkBytes: 4 })
    configureGoogleDriveFiles(adapter)
    return { adapter }
  }

  it('save reads the source file through the adapter and reports progress', async () => {
    const { adapter } = setUp([
      { json: { files: [] } }, // findFileId
      { headers: { Location: 'https://upload.example/s' } }, // initiate
      { status: 308, headers: { Range: 'bytes=0-3' } }, // chunk 1/2 of a 7-byte file
      { status: 200, json: { id: 'new-id' } }, // chunk 2/2
    ])
    const bytes = Uint8Array.from([10, 20, 30, 40, 50, 60, 70])
    await adapter.writeChunk('/tmp/backup.db', bytesToBase64(bytes))

    const onProgress = jest.fn()
    await googleDriveFiles.save({ name: 'backup.db', fileUri: '/tmp/backup.db', onProgress })

    expect(onProgress).toHaveBeenCalledWith({ bytesTransferred: 4, bytesTotal: 7, fraction: 4 / 7 })
    expect(onProgress).toHaveBeenLastCalledWith({ bytesTransferred: 7, bytesTotal: 7, fraction: 1 })
  })

  it('fetch writes the downloaded bytes through the adapter and resolves destinationUri', async () => {
    const { adapter } = setUp([
      { json: { files: [{ id: 'id-1', name: 'backup.db' }] } },
      { json: { size: '7' } },
      { arrayBuffer: Uint8Array.from([10, 20, 30, 40]).buffer },
      { arrayBuffer: Uint8Array.from([50, 60, 70]).buffer },
    ])

    const path = await googleDriveFiles.fetch({ name: 'backup.db', destinationUri: '/tmp/restored.db' })

    expect(path).toBe('/tmp/restored.db')
    const size = await adapter.statSize('/tmp/restored.db')
    const written = base64ToBytes(await adapter.readChunk('/tmp/restored.db', 0, size))
    expect(written).toEqual(Uint8Array.from([10, 20, 30, 40, 50, 60, 70]))
  })

  it('fetch resolves null, and never calls the adapter, when the file does not exist', async () => {
    const { adapter } = setUp([{ json: { files: [] } }])
    const writeChunk = jest.spyOn(adapter, 'writeChunk')

    await expect(
      googleDriveFiles.fetch({ name: 'missing.db', destinationUri: '/tmp/restored.db' })
    ).resolves.toBeNull()
    expect(writeChunk).not.toHaveBeenCalled()
  })
})
