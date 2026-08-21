import { GoogleDriveClient } from '../internal/googleDriveRest'
import type {
  DriveChunkSink, DriveChunkSource, GoogleDriveSessionStore, GoogleDriveUploadSession,
} from '../internal/googleDriveRest'
import { ErrorCode } from '../errors'
import type { AbortLike } from '../internal/timeout'

interface Call { url: string; method: string; headers: Headers; body: unknown }

interface ScriptedReply {
  status?: number
  json?: unknown
  headers?: Record<string, string>
  arrayBuffer?: ArrayBuffer
  /** Throw instead of resolving - simulates a dropped connection. */
  networkError?: boolean
}

/** A Drive stub driven by a queue of replies, one per request. */
function makeClient(
  replies: ScriptedReply[],
  chunkBytes?: number,
  sessionStore?: GoogleDriveSessionStore
) {
  const calls: Call[] = []
  let i = 0

  const fetchImpl = ((url: string, init: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body })

    if (reply.networkError) return Promise.reject(new Error('network drop'))

    const status = reply.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(reply.headers ?? {}),
      json: () => Promise.resolve(reply.json ?? {}),
      arrayBuffer: () => Promise.resolve(reply.arrayBuffer ?? new ArrayBuffer(0)),
    } as unknown as Response)
  }) as unknown as typeof fetch

  const client = new GoogleDriveClient({ getAccessToken: () => 'access-token', fetchImpl, chunkBytes, sessionStore })
  return { client, calls }
}

/** An in-memory stand-in for the host's persistence, shared across `makeClient`
 *  calls to simulate a session surviving a fresh `GoogleDriveClient` instance -
 *  i.e. a process restart. */
function memorySessionStore(): GoogleDriveSessionStore & { data: Map<string, GoogleDriveUploadSession> } {
  const data = new Map<string, GoogleDriveUploadSession>()
  return {
    data,
    get: name => Promise.resolve(data.get(name) ?? null),
    set: (name, session) => {
      data.set(name, session)
      return Promise.resolve()
    },
    remove: (name) => {
      data.delete(name)
      return Promise.resolve()
    },
  }
}

/** A signal a test can flip mid-transfer, without wiring up a real AbortController. */
function fakeSignal(): AbortLike & { abort: () => void } {
  const state = { aborted: false }
  return {
    get aborted() { return state.aborted },
    addEventListener: () => {},
    removeEventListener: () => {},
    abort: () => { state.aborted = true },
  }
}

/** A source backed by an in-memory byte array, for `uploadFile`. */
function memorySource(bytes: Uint8Array): DriveChunkSource {
  return {
    size: bytes.length,
    read: (start, length) => Promise.resolve(bytes.slice(start, start + length)),
  }
}

/** A sink that reassembles whatever `downloadFile` writes, for assertions. */
function memorySink() {
  const chunks: Uint8Array[] = []
  const sink: DriveChunkSink = {
    write: (bytes) => {
      chunks.push(bytes)
      return Promise.resolve()
    },
  }
  return { sink, bytes: () => Uint8Array.from(chunks.flatMap(c => Array.from(c))) }
}

describe('uploadFile', () => {
  it('creates a new file in one chunk when it fits, and caches the returned id', async () => {
    const { client, calls } = makeClient([
      { json: { files: [] } }, // findFileId: not found
      { headers: { Location: 'https://upload.example/session-1' } }, // initiate
      { status: 200, json: { id: 'new-id' } }, // single PUT, complete
    ])

    const onProgress = jest.fn()
    await client.uploadFile('backup.db', memorySource(Uint8Array.from([1, 2, 3])), onProgress)

    expect(calls[1].method).toBe('POST')
    expect(calls[1].url).toContain('uploadType=resumable')
    expect(calls[2].method).toBe('PUT')
    expect(calls[2].headers.get('Content-Range')).toBe('bytes 0-2/3')
    expect(onProgress).toHaveBeenLastCalledWith(3, 3)
  })

  it('splits a file larger than the chunk size across multiple PUTs', async () => {
    const { client, calls } = makeClient([
      { json: { files: [] } },
      { headers: { Location: 'https://upload.example/session-2' } },
      { status: 308, headers: { Range: 'bytes=0-3' } }, // chunk 1 of 4 bytes: incomplete
      { status: 200, json: { id: 'new-id' } }, // chunk 2: complete
    ], 4 /* chunkBytes */)

    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6])
    const onProgress = jest.fn()
    await client.uploadFile('big.db', memorySource(bytes), onProgress)

    const puts = calls.filter(c => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(puts[0].headers.get('Content-Range')).toBe('bytes 0-3/7')
    expect(puts[1].headers.get('Content-Range')).toBe('bytes 4-6/7')
    expect(onProgress).toHaveBeenCalledWith(4, 7)
    expect(onProgress).toHaveBeenLastCalledWith(7, 7)
  })

  it('updates an existing file with PATCH, not POST', async () => {
    const { client, calls } = makeClient([
      { json: { files: [{ id: 'existing-id', name: 'backup.db' }] } },
      { headers: { Location: 'https://upload.example/session-3' } },
      { status: 200, json: {} },
    ])

    await client.uploadFile('backup.db', memorySource(Uint8Array.from([9])))

    expect(calls[1].method).toBe('PATCH')
    expect(calls[1].url).not.toContain('fields=id')
  })

  it('recovers a chunk that drops mid-flight by querying the real offset and resuming', async () => {
    const { client, calls } = makeClient([
      { json: { files: [] } },
      { headers: { Location: 'https://upload.example/session-4' } },
      { networkError: true }, // chunk 1 PUT: connection drops
      { status: 308, headers: { Range: 'bytes=0-3' } }, // offset query: server actually got 4 bytes
      { status: 200, json: { id: 'new-id' } }, // resumed PUT from byte 4: complete
    ], 4)

    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6])
    await client.uploadFile('flaky.db', memorySource(bytes))

    const puts = calls.filter(c => c.method === 'PUT')
    // dropped attempt, offset query, resumed attempt
    expect(puts).toHaveLength(3)
    expect(puts[1].headers.get('Content-Range')).toBe('bytes */7')
    expect(puts[2].headers.get('Content-Range')).toBe('bytes 4-6/7')
  })

  it('propagates a non-retryable failure (e.g. quota) without masking it as a network drop', async () => {
    const { client } = makeClient([
      { json: { files: [] } },
      { headers: { Location: 'https://upload.example/session-5' } },
      // Drive signals quota-exceeded as 403 with this reason - never a 507.
      { status: 403, json: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } },
    ])

    await expect(
      client.uploadFile('big.db', memorySource(Uint8Array.from([1, 2, 3])))
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })
  })
})

describe('uploadFile session persistence', () => {
  it('survives a fresh client instance: resumes from the real offset instead of restarting', async () => {
    const store = memorySessionStore()
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6])

    // "Before restart": the session is started and one chunk lands, then the
    // process dies mid-transfer (modelled here as an unrecoverable failure).
    const before = makeClient([
      { json: { files: [] } }, // findFileId: not found
      { headers: { Location: 'https://upload.example/session-restart' } }, // initiate
      { status: 308, headers: { Range: 'bytes=0-3' } }, // chunk 1 of 4 bytes: accepted
      // simulated crash - never sent, never resolved cleanly. Quota-exceeded
      // (a real 403 + reason, never a 507) stands in for "some unrecoverable
      // failure interrupted the upload".
      { status: 403, json: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } },
    ], 4, store)

    await expect(
      before.client.uploadFile('resumable.db', memorySource(bytes))
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })

    // The session was persisted before the first chunk went out, and a crash
    // is not a cancel, so it is still there for the next attempt.
    expect(store.data.get('resumable.db')).toEqual({
      sessionUrl: 'https://upload.example/session-restart',
      size: 7,
    })

    // "After restart": a brand new client, sharing only the session store.
    const after = makeClient([
      { status: 308, headers: { Range: 'bytes=0-3' } }, // offset query: 4 bytes already landed
      { status: 200, json: { id: 'new-id' } }, // remaining bytes: complete
    ], undefined, store)

    const onProgress = jest.fn()
    await after.client.uploadFile('resumable.db', memorySource(bytes), onProgress)

    // No findFileId, no fresh session - straight to the offset query, then one
    // PUT for the bytes that were never confirmed.
    expect(after.calls).toHaveLength(2)
    expect(after.calls[0].headers.get('Content-Range')).toBe('bytes */7')
    expect(after.calls[1].method).toBe('PUT')
    expect(after.calls[1].headers.get('Content-Range')).toBe('bytes 4-6/7')
    expect(onProgress).toHaveBeenLastCalledWith(7, 7)
    expect(store.data.has('resumable.db')).toBe(false)
  })

  it('discards a persisted session once the upload it describes has finished', async () => {
    const store = memorySessionStore()
    store.data.set('small.db', { sessionUrl: 'https://upload.example/stale', size: 3 })

    // Only one request: the offset query itself reports completion (a 200,
    // not a 308) - the completing chunk's own response is what got lost, not
    // the chunk. No further PUT should follow.
    const { client, calls } = makeClient([
      { status: 200, json: { id: 'already-there' } },
    ], undefined, store)

    const onProgress = jest.fn()
    await client.uploadFile('small.db', memorySource(Uint8Array.from([1, 2, 3])), onProgress)

    expect(calls).toHaveLength(1)
    expect(onProgress).toHaveBeenLastCalledWith(3, 3)
    expect(store.data.has('small.db')).toBe(false)
  })

  it('ignores a persisted session for a file that has since changed size', async () => {
    const store = memorySessionStore()
    store.data.set('changed.db', { sessionUrl: 'https://upload.example/old-size', size: 5 })

    const { client, calls } = makeClient([
      { json: { files: [] } }, // findFileId
      { headers: { Location: 'https://upload.example/new-size' } }, // fresh session
      { status: 200, json: { id: 'new-id' } }, // single PUT, complete
    ], undefined, store)

    await client.uploadFile('changed.db', memorySource(Uint8Array.from([1, 2, 3])))

    // The stale session URI is never touched - every request targets the
    // freshly started one instead.
    for (const call of calls) expect(call.url).not.toContain('old-size')
    expect(store.data.has('changed.db')).toBe(false)
  })

  it('discards a persisted session Drive no longer recognises, and starts fresh transparently', async () => {
    const store = memorySessionStore()
    store.data.set('expired.db', { sessionUrl: 'https://upload.example/expired', size: 3 })

    const { client, calls } = makeClient([
      { status: 404 }, // offset query against the expired session
      { json: { files: [] } }, // findFileId
      { headers: { Location: 'https://upload.example/fresh' } }, // fresh session
      { status: 200, json: { id: 'new-id' } }, // single PUT, complete
    ], undefined, store)

    await client.uploadFile('expired.db', memorySource(Uint8Array.from([1, 2, 3])))

    expect(calls[0].url).toBe('https://upload.example/expired')
    expect(calls[2].url).toContain('uploadType=resumable')
    expect(store.data.has('expired.db')).toBe(false)
  })

  it('drops the persisted session on an explicit cancel, rather than leaving it for a future resume', async () => {
    const store = memorySessionStore()
    const signal = fakeSignal()

    const { client } = makeClient([
      { json: { files: [] } },
      { headers: { Location: 'https://upload.example/cancel-me' } },
      { status: 308, headers: { Range: 'bytes=0-3' } }, // chunk 1: accepted
    ], 4, store)

    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6])
    const onProgress = jest.fn(() => signal.abort()) // abort right after chunk 1 lands

    await expect(
      client.uploadFile('cancel-me.db', memorySource(bytes), onProgress, signal)
    ).rejects.toMatchObject({ code: ErrorCode.CANCELLED })

    expect(store.data.has('cancel-me.db')).toBe(false)
  })
})

describe('downloadFile', () => {
  it('resolves false without writing anything when the file does not exist', async () => {
    const { client } = makeClient([{ json: { files: [] } }])
    const { sink, bytes } = memorySink()

    await expect(client.downloadFile('missing.db', sink)).resolves.toBe(false)
    expect(bytes()).toHaveLength(0)
  })

  it('downloads in fixed-size ranges and reassembles them in order', async () => {
    const { client, calls } = makeClient([
      { json: { files: [{ id: 'id-1', name: 'big.db' }] } },
      { json: { size: '7' } }, // fileSize
      { arrayBuffer: Uint8Array.from([0, 1, 2, 3]).buffer }, // bytes 0-3
      { arrayBuffer: Uint8Array.from([4, 5, 6]).buffer }, // bytes 4-6
    ], 4)

    const { sink, bytes } = memorySink()
    const onProgress = jest.fn()

    await expect(client.downloadFile('big.db', sink, onProgress)).resolves.toBe(true)
    expect(bytes()).toEqual(Uint8Array.from([0, 1, 2, 3, 4, 5, 6]))

    const gets = calls.filter(c => c.method === 'GET' && c.url.includes('alt=media'))
    expect(gets[0].headers.get('Range')).toBe('bytes=0-3')
    expect(gets[1].headers.get('Range')).toBe('bytes=4-6')
    expect(onProgress).toHaveBeenLastCalledWith(7, 7)
  })

  it('marks the first written chunk so the sink can distinguish create from append', async () => {
    const { client } = makeClient([
      { json: { files: [{ id: 'id-1', name: 'big.db' }] } },
      { json: { size: '6' } },
      { arrayBuffer: Uint8Array.from([1, 2, 3]).buffer },
      { arrayBuffer: Uint8Array.from([4, 5, 6]).buffer },
    ], 3)

    const calls: boolean[] = []
    const sink: DriveChunkSink = {
      write: (_bytes, isFirstChunk) => {
        calls.push(isFirstChunk)
        return Promise.resolve()
      },
    }

    await client.downloadFile('big.db', sink)

    expect(calls).toEqual([true, false])
  })
})
