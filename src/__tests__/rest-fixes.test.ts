import { CloudKitRestClient } from '../internal/cloudKitRest'
import { GoogleDriveClient } from '../internal/googleDriveRest'
import type { DriveChunkSink, DriveChunkSource } from '../internal/googleDriveRest'
import { ErrorCode, isRetryable, timedOut } from '../errors'
import { createGoogleDriveProvider } from '../providers/googleDrive'

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

interface Reply {
  status?: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
  arrayBuffer?: ArrayBuffer
  /** Reject with this instead of resolving. */
  reject?: Error
}

interface DriveCall { url: string; method: string; headers: Headers }

function makeDrive(replies: Reply[], options: { chunkBytes?: number; onDuplicateName?: 'newest' | 'error' } = {}) {
  const calls: DriveCall[] = []
  let i = 0

  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) })
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    if (reply.reject != null) return Promise.reject(reply.reject)
    const status = reply.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.json ?? {}),
      text: () => Promise.resolve(reply.text ?? ''),
      arrayBuffer: () => Promise.resolve(reply.arrayBuffer ?? new ArrayBuffer(0)),
      headers: new Headers(reply.headers ?? {}),
    } as unknown as Response)
  }) as unknown as typeof fetch

  const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl, ...options })
  return { client, calls }
}

function memorySource(bytes: Uint8Array): DriveChunkSource {
  return { size: bytes.length, read: (start, length) => Promise.resolve(bytes.slice(start, start + length)) }
}

describe('Drive resumable upload', () => {
  it('resumes from the offset a 308 reports, not from what was sent', async () => {
    // Drive is allowed to persist only part of a chunk. Advancing past what it
    // reported would leave a hole in the uploaded file.
    const { client, calls } = makeDrive([
      { json: { files: [] } },
      { headers: { Location: 'https://www.googleapis.com/upload/s/s' } },
      { status: 308, headers: { Range: 'bytes=0-1' } }, // sent 0-3, kept 0-1
      { status: 308, headers: { Range: 'bytes=0-5' } }, // sent 2-5
      { status: 200, json: { id: 'new' } }, // sent 6-6
    ], { chunkBytes: 4 })

    await client.uploadFile('f', memorySource(Uint8Array.from([0, 1, 2, 3, 4, 5, 6])))

    const ranges = calls.filter(c => c.method === 'PUT').map(c => c.headers.get('Content-Range'))
    expect(ranges).toEqual(['bytes 0-3/7', 'bytes 2-5/7', 'bytes 6-6/7'])
  })

  it('retries a chunk that timed out, after asking Drive for the real offset', async () => {
    const { client, calls } = makeDrive([
      { json: { files: [] } },
      { headers: { Location: 'https://www.googleapis.com/upload/s/s' } },
      { reject: timedOut(60_000, 'googleDrive') }, // the chunk PUT times out
      { status: 308, headers: { Range: 'bytes=0-1' } }, // offset query
      { status: 200, json: { id: 'new' } }, // the resumed PUT
    ])

    await expect(client.uploadFile('f', memorySource(Uint8Array.from([0, 1, 2, 3]))))
      .resolves.toBeUndefined()

    const puts = calls.filter(c => c.method === 'PUT').map(c => c.headers.get('Content-Range'))
    expect(puts).toEqual(['bytes 0-3/4', 'bytes */4', 'bytes 2-3/4'])
  })

  it('recovers when the memoised id of the file being replaced is gone', async () => {
    const { client, calls } = makeDrive([
      { json: { files: [{ id: 'old', name: 'f' }] } }, // primes the id cache
      { text: 'x' },
      { status: 404 }, // PATCH resumable against the stale id
      { json: { files: [] } }, // fresh lookup: really gone
      { headers: { Location: 'https://www.googleapis.com/upload/s/s' } }, // POST create
      { status: 200, json: { id: 'new' } },
    ])

    await client.getItem('f')
    await expect(client.uploadFile('f', memorySource(Uint8Array.from([1]))))
      .resolves.toBeUndefined()

    const create = calls[4]
    expect(create.method).toBe('POST')
    expect(create.url).not.toContain('/old')
  })
})

describe('Drive download', () => {
  it('recovers when the memoised id is gone', async () => {
    const written: Uint8Array[] = []
    const sink: DriveChunkSink = {
      write: (b) => {
        written.push(b)
        return Promise.resolve()
      },
    }
    const { client } = makeDrive([
      { json: { files: [{ id: 'old', name: 'f' }] } },
      { text: 'x' },
      { status: 404 }, // size lookup against the stale id
      { json: { files: [{ id: 'new', name: 'f' }] } },
      { json: { size: '2' } },
      { status: 206, arrayBuffer: Uint8Array.from([7, 8]).buffer },
    ])

    await client.getItem('f')
    await expect(client.downloadFile('f', sink)).resolves.toBe(true)
    expect(Array.from(written[0])).toEqual([7, 8])
  })
})

describe('Drive rate limiting', () => {
  it('reports no retry hint when a 429 carries no Retry-After', async () => {
    const { client } = makeDrive([{ status: 429 }])
    const e = await client.getAllKeys().catch((err: unknown) => err)
    expect(e).toMatchObject({ code: ErrorCode.RATE_LIMITED })
    expect((e as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
  })

  it('still honours a Retry-After that is there', async () => {
    const { client } = makeDrive([{ status: 429, headers: { 'Retry-After': '7' } }])
    await expect(client.getAllKeys()).rejects.toMatchObject({ retryAfterMs: 7000 })
  })
})

describe('Drive duplicate names', () => {
  const dupes = {
    files: [
      { id: 'newer', name: 'k', modifiedTime: '2024-02-01T00:00:00.000Z' },
      { id: 'older', name: 'k', modifiedTime: '2024-01-01T00:00:00.000Z' },
    ],
  }

  it('getAllKeys lists a duplicated name once and caches the newest copy', async () => {
    const { client, calls } = makeDrive([{ json: dupes }, { text: 'v' }])

    await expect(client.getAllKeys()).resolves.toEqual(['k'])
    await client.getItem('k')
    // The last listed duplicate used to win the cache, bypassing the
    // deterministic newest-first choice.
    expect(calls[1].url).toContain('/newer?alt=media')
  })

  it('getAllKeys leaves a duplicate uncached in error mode, so reads raise CONFLICT', async () => {
    const { client } = makeDrive([{ json: dupes }, { json: dupes }], { onDuplicateName: 'error' })

    await client.getAllKeys()
    await expect(client.getItem('k')).rejects.toMatchObject({ code: ErrorCode.CONFLICT })
  })
})

describe('Drive metadata freshness', () => {
  it('a setItem update asks Drive for the new metadata', async () => {
    const { client, calls } = makeDrive([
      { json: { files: [{ id: 'id1', name: 'k' }] } },
      { json: { id: 'id1', name: 'k', modifiedTime: '2024-06-01T00:00:00.000Z' } }, // PATCH
    ])

    await client.setItem('k', 'new')
    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].url).toContain('fields=')
  })

  it('getItemWithMeta re-lists even with a cached id, so the timestamp is current', async () => {
    // Another device wrote between the two reads; only a fresh listing knows.
    const { client, calls } = makeDrive([
      { json: { files: [{ id: 'id1', name: 'k', modifiedTime: '2024-01-01T00:00:00.000Z' }] } },
      { text: 'old' },
      { json: { files: [{ id: 'id1', name: 'k', modifiedTime: '2024-06-01T00:00:00.000Z' }] } },
      { text: 'new' },
    ])

    await client.getItemWithMeta('k')
    await expect(client.getItemWithMeta('k')).resolves.toMatchObject({
      value: 'new',
      modifiedAt: Date.parse('2024-06-01T00:00:00.000Z'),
    })
    expect(calls[2].url).toContain('q=')
  })

  it('a change for a name sends the next read back through the listing', async () => {
    // Another device created a second file with the same name; the cached id
    // still points at this device's old copy.
    const { client, calls } = makeDrive([
      { json: { files: [{ id: 'mine', name: 'k' }] } },
      { text: 'v' },
      { json: { newStartPageToken: 't2', changes: [{ fileId: 'theirs', file: { id: 'theirs', name: 'k' } }] } },
      { json: { files: [{ id: 'theirs', name: 'k' }] } },
      { text: 'theirs' },
    ])

    await client.getItem('k')
    await client.pollChanges('t1')
    await expect(client.getItem('k')).resolves.toBe('theirs')
    expect(calls[3].url).toContain('q=')
  })
})

// ---------------------------------------------------------------------------
// CloudKit
// ---------------------------------------------------------------------------

describe('CloudKit asset download URL', () => {
  it('fills in the ${f} file-name placeholder before downloading', async () => {
    const fetchImpl = (() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        records: [{
          recordName: 'r',
          fields: { file: { value: { downloadURL: 'https://cvws.example/B/abc/${f}?o=1' } } },
        }],
      }),
      headers: new Headers(),
    } as unknown as Response)) as unknown as typeof fetch

    const opened: string[] = []
    const xhr = {
      open: (_method: string, url: string) => opened.push(url),
      send() {
        this.status = 200
        this.response = Uint8Array.from([1]).buffer
        this.onload?.()
      },
      status: 0,
      response: null as ArrayBuffer | null,
      timeout: 0,
      responseType: '',
      onload: null as null | (() => void),
      onprogress: null,
      onerror: null,
      ontimeout: null,
    }

    const client = new CloudKitRestClient({
      containerIdentifier: 'iCloud.test',
      apiToken: 'api',
      environment: 'development',
      getAuthToken: () => 'web',
      fetchImpl,
      xhrImpl: () => xhr as unknown as XMLHttpRequest,
    })

    await expect(client.fetchAsset('r', 'file')).resolves.toEqual(Uint8Array.from([1]))
    expect(opened[0]).toBe('https://cvws.example/B/abc/file?o=1')
  })
})

// ---------------------------------------------------------------------------
// Drive provider change polling
// ---------------------------------------------------------------------------

describe('Drive provider change polling', () => {
  function makeProvider(replies: Reply[]) {
    const calls: string[] = []
    let i = 0
    const fetchImpl = ((url: string) => {
      calls.push(url)
      const reply = replies[Math.min(i, replies.length - 1)]
      i += 1
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(reply.json ?? {}),
        headers: new Headers(),
      } as unknown as Response)
    }) as unknown as typeof fetch
    const provider = createGoogleDriveProvider({
      getAccessToken: () => 'token', fetchImpl, changePollIntervalMs: 1000,
    })
    return { provider, calls }
  }

  const flush = async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve()
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('takes the starting cursor as soon as someone subscribes', async () => {
    const { provider, calls } = makeProvider([{ json: { startPageToken: 't1' } }])
    const unsubscribe = provider.onRemoteChange!(() => undefined)
    await flush()
    expect(calls[0]).toContain('startPageToken')
    unsubscribe()
  })

  it('keeps polling for existing subscribers after clearCaches', async () => {
    const { provider, calls } = makeProvider([
      { json: { startPageToken: 't1' } },
      { json: { startPageToken: 't2' } },
      { json: { newStartPageToken: 't3', changes: [{ fileId: 'a', file: { id: 'a', name: 'k' } }] } },
    ])
    const listener = jest.fn()
    const unsubscribe = provider.onRemoteChange!(listener)
    await flush()

    provider.clearCaches!()
    await flush()
    jest.advanceTimersByTime(1000)
    await flush()

    expect(calls.filter(u => u.includes('startPageToken'))).toHaveLength(2)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ keys: ['k'] }))
    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Follow-up fixes
// ---------------------------------------------------------------------------

describe('Drive 5xx', () => {
  it.each([500, 502, 503, 504])('classifies HTTP %i as retryable', async (status) => {
    const { client } = makeDrive([{ status }])
    const e = await client.getAllKeys().catch((err: unknown) => err)
    expect(isRetryable(e)).toBe(true)
    expect(e).toMatchObject({ code: ErrorCode.RATE_LIMITED, serverErrorCode: `HTTP_${status}` })
  })

  it('resumes an upload whose chunk hit a 503', async () => {
    const { client, calls } = makeDrive([
      { json: { files: [] } },
      { headers: { Location: 'https://www.googleapis.com/upload/s/s' } },
      { status: 503 },
      { status: 308, headers: { Range: 'bytes=0-1' } },
      { status: 200, json: { id: 'new' } },
    ])

    await expect(client.uploadFile('f', memorySource(Uint8Array.from([0, 1, 2, 3]))))
      .resolves.toBeUndefined()
    const puts = calls.filter(c => c.method === 'PUT').map(c => c.headers.get('Content-Range'))
    expect(puts).toEqual(['bytes 0-3/4', 'bytes */4', 'bytes 2-3/4'])
  })
})

describe('Drive change cursor', () => {
  it('asks for the start token without a spaces parameter it does not take', async () => {
    const { client, calls } = makeDrive([{ json: { startPageToken: 't' } }])
    await client.getStartPageToken()
    expect(calls[0].url).not.toContain('spaces=')
  })
})

describe('Drive empty reads', () => {
  it('uploadFile throws instead of looping when the source returns no bytes', async () => {
    const { client } = makeDrive([
      { json: { files: [] } },
      { headers: { Location: 'https://www.googleapis.com/upload/s/s' } },
    ])
    const source: DriveChunkSource = { size: 4, read: () => Promise.resolve(new Uint8Array(0)) }
    await expect(client.uploadFile('f', source)).rejects.toMatchObject({ code: ErrorCode.UNKNOWN })
  })

  it('downloadFile throws instead of looping when Drive returns an empty body', async () => {
    const { client } = makeDrive([
      { json: { files: [{ id: 'id', name: 'f' }] } },
      { json: { size: '4' } },
      { status: 206 },
    ])
    const sink: DriveChunkSink = { write: () => Promise.resolve() }
    await expect(client.downloadFile('f', sink)).rejects.toMatchObject({ code: ErrorCode.UNKNOWN })
  })
})

describe('CloudKit follow-ups', () => {
  function makeCloudKit(json: unknown, onAuthExpired?: () => void) {
    const bodies: unknown[] = []
    const fetchImpl = ((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve(json), headers: new Headers(),
      } as unknown as Response)
    }) as unknown as typeof fetch
    const client = new CloudKitRestClient({
      containerIdentifier: 'iCloud.test', apiToken: 'api', environment: 'development',
      getAuthToken: () => 'web', fetchImpl, onAuthExpired,
    })
    return { client, bodies }
  }

  it('ACCESS_DENIED is a permission problem and does not sign the user out', async () => {
    const onAuthExpired = jest.fn()
    const { client } = makeCloudKit({ serverErrorCode: 'ACCESS_DENIED' }, onAuthExpired)
    await expect(client.getRecord('k')).rejects.toMatchObject({
      code: ErrorCode.CONTAINER_MISCONFIGURED, serverErrorCode: 'ACCESS_DENIED',
    })
    expect(onAuthExpired).not.toHaveBeenCalled()
  })

  it('queryRecordNames asks for no fields', async () => {
    const { client, bodies } = makeCloudKit({ records: [{ recordName: 'a' }] })
    await expect(client.queryRecordNames()).resolves.toEqual(['a'])
    expect(bodies[0]).toMatchObject({ desiredKeys: [] })
  })
})
