import { assets } from '../providers/cloudKit'
import { configureCloudKit, configureGoogleDriveFiles, __resetConfig } from '../config'
import { base64ToBytes, bytesToBase64 } from '../internal/base64'
import { ErrorCode } from '../errors'
import type { GoogleDriveFileAdapter } from '../internal/googleDriveRest'

interface Harness {
  setPlatform: (os: string) => void
  reset: () => void
}

const harness = (globalThis as unknown as { __RNCloudSync: Harness }).__RNCloudSync

afterEach(() => {
  harness.reset()
  __resetConfig()
})

describe('cloudKitAssets on Android/web, CloudKit not configured', () => {
  beforeEach(() => harness.setPlatform('android'))

  // The asset API used to be flatly native-only. Now that CloudKit Web
  // Services can serve it too, an unconfigured client should say so
  // specifically (naming configureCloudKit), the same way every other REST
  // operation on this provider already does - not a blanket "not supported".
  it('rejects save with ERR_CONTAINER_MISCONFIGURED, naming configureCloudKit', async () => {
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png' })
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_MISCONFIGURED })
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png' })
    ).rejects.toThrow(/configureCloudKit/)
  })

  it('rejects fetch with ERR_CONTAINER_MISCONFIGURED', async () => {
    await expect(
      assets.fetch({ recordName: 'a', fieldName: 'image', destinationUri: '/tmp/a.png' })
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_MISCONFIGURED })
  })

  it('onProgress still returns a working unsubscribe', () => {
    const unsubscribe = assets.onProgress(() => undefined)
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('cloudKitAssets on Android/web - limits that stay native-only', () => {
  beforeEach(() => {
    harness.setPlatform('android')
    configureCloudKit({
      containerIdentifier: 'iCloud.test',
      apiToken: 't',
      environment: 'development',
      getAuthToken: () => 'web-token',
    })
  })

  it('rejects a custom zone with ERR_UNSUPPORTED_PLATFORM - the REST client has no zone support at all', async () => {
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png', zoneName: 'Exports' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_PLATFORM })

    await expect(
      assets.fetch({ recordName: 'a', fieldName: 'image', zoneName: 'Exports', destinationUri: '/tmp/a.png' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_PLATFORM })
  })

  it('rejects fetch without destinationUri - there is no native temp directory to fall back to', async () => {
    await expect(
      assets.fetch({ recordName: 'a', fieldName: 'image' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_PLATFORM })
  })

  it('cancel still resolves false rather than throwing - a known gap, not a broken promise', async () => {
    await expect(assets.cancel({ recordName: 'a', fieldName: 'image' })).resolves.toBe(false)
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

describe('cloudKitAssets on Android/web without a configured file adapter', () => {
  beforeEach(() => {
    harness.setPlatform('android')
    configureCloudKit({
      containerIdentifier: 'iCloud.test',
      apiToken: 't',
      environment: 'development',
      getAuthToken: () => 'web-token',
    })
  })

  it('rejects save, naming configureGoogleDriveFiles as the fix', async () => {
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png' })
    ).rejects.toMatchObject({ code: ErrorCode.CONTAINER_MISCONFIGURED })
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png' })
    ).rejects.toThrow(/configureGoogleDriveFiles/)
  })
})

describe('cloudKitAssets over REST (Android/web)', () => {
  function setUp(fetchResponses: unknown[], xhrScript: {
    status?: number
    json?: unknown
    arrayBuffer?: ArrayBuffer
    networkError?: boolean
  }) {
    harness.setPlatform('android')
    const adapter = memoryAdapter()

    let i = 0
    const fetchImpl = (() => {
      const r = fetchResponses[Math.min(i, fetchResponses.length - 1)] as { status?: number; json?: unknown }
      i += 1
      const status = r.status ?? 200
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(r.json ?? {}),
        text: () => Promise.resolve(JSON.stringify(r.json ?? {})),
        headers: new Headers(),
      } as unknown as Response)
    }) as unknown as typeof fetch

    const xhrImpl = (): XMLHttpRequest => {
      const req: {
        status: number
        responseText: string
        response: unknown
        responseType: string
        timeout: number
        upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
        onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null
        onload: (() => void) | null
        onerror: (() => void) | null
        ontimeout: (() => void) | null
        open: (method: string, url: string) => void
        send: (body?: unknown) => void
      } = {
        status: 0,
        responseText: '',
        response: undefined,
        responseType: '',
        timeout: 0,
        upload: { onprogress: null },
        onprogress: null,
        onload: null,
        onerror: null,
        ontimeout: null,
        open: () => undefined,
        send(body) {
          void Promise.resolve().then(() => {
            if (xhrScript.networkError) {
              req.onerror?.()
              return
            }
            req.status = xhrScript.status ?? 200
            if (xhrScript.json !== undefined) req.responseText = JSON.stringify(xhrScript.json)
            if (xhrScript.arrayBuffer !== undefined) req.response = xhrScript.arrayBuffer
            const total = xhrScript.arrayBuffer != null
              ? xhrScript.arrayBuffer.byteLength
              : (body as { length?: number } | undefined)?.length ?? 0
            req.upload.onprogress?.({ lengthComputable: true, loaded: total, total })
            req.onprogress?.({ lengthComputable: true, loaded: total, total })
            req.onload?.()
          })
        },
      }
      return req as unknown as XMLHttpRequest
    }

    configureCloudKit({
      containerIdentifier: 'iCloud.test',
      apiToken: 't',
      environment: 'development',
      getAuthToken: () => 'web-token',
      fetchImpl,
      xhrImpl,
    })
    configureGoogleDriveFiles(adapter)
    return { adapter }
  }

  it('save reads the file through the adapter, uploads it, and reports progress via onProgress', async () => {
    const { adapter } = setUp(
      [
        { json: { tokens: [{ url: 'https://upload.example/asset' }] } },
        { json: { records: [{ recordName: 'avatar' }] } },
      ],
      { json: { singleFile: { fileChecksum: 'c', size: '3', receipt: 'r' } } }
    )
    await adapter.writeChunk('/tmp/a.png', bytesToBase64(Uint8Array.from([1, 2, 3])))

    const onProgress = jest.fn()
    const unsubscribe = assets.onProgress(onProgress)
    try {
      await assets.save({ recordName: 'avatar', fieldName: 'image', fileUri: '/tmp/a.png' })
    }
    finally {
      unsubscribe()
    }

    expect(onProgress).toHaveBeenCalledWith({
      recordName: 'avatar', fieldName: 'image', bytesTransferred: 3, bytesTotal: 3,
    })
  })

  it('fetch downloads through the adapter and resolves the destination path', async () => {
    setUp(
      [{
        json: {
          records: [{
            recordName: 'avatar',
            fields: { image: { value: { downloadURL: 'https://download.example/asset' } } },
          }],
        },
      }],
      { arrayBuffer: Uint8Array.from([9, 8, 7]).buffer }
    )

    const path = await assets.fetch({
      recordName: 'avatar', fieldName: 'image', destinationUri: '/tmp/restored.png',
    })

    expect(path).toBe('/tmp/restored.png')
  })

  it('fetch resolves null when the record does not exist', async () => {
    setUp(
      [{ json: { records: [{ recordName: 'avatar', serverErrorCode: 'NOT_FOUND' }] } }],
      {}
    )

    await expect(
      assets.fetch({ recordName: 'avatar', fieldName: 'image', destinationUri: '/tmp/x.png' })
    ).resolves.toBeNull()
  })

  it('save rejects a file over the 15 MB CloudKit Web Services asset limit', async () => {
    const { adapter } = setUp([{ json: {} }], {})
    // Big enough to trip the guard without actually allocating 15 MB in the test.
    const original = adapter.statSize
    adapter.statSize = () => Promise.resolve(15 * 1024 * 1024 + 1)
    void original

    await expect(
      assets.save({ recordName: 'avatar', fieldName: 'image', fileUri: '/tmp/huge.bin' })
    ).rejects.toMatchObject({ code: ErrorCode.PAYLOAD_TOO_LARGE })
  })
})
