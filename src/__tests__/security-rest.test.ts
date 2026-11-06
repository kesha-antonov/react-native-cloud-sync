import { CloudKitRestClient } from '../internal/cloudKitRest'
import {
  GoogleDriveClient, type GoogleDriveSessionStore, type GoogleDriveUploadSession,
} from '../internal/googleDriveRest'
import { MAX_RETRY_AFTER_MS } from '../internal/records'
import { base64ToBytes, bytesToBase64 } from '../internal/base64'
import { CloudSyncError, ErrorCode } from '../errors'

interface Reply {
  status?: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}

interface Call { url: string; method: string; headers: Headers; body?: unknown }

function makeFetch(replies: Reply[]) {
  const calls: Call[] = []
  let i = 0
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body })
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    const status = reply.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.json ?? {}),
      text: () => Promise.resolve(reply.text ?? ''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      headers: new Headers(reply.headers ?? {}),
    } as unknown as Response)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const SOURCE = { size: 3, read: () => Promise.resolve(new Uint8Array([1, 2, 3])) }

describe('Drive: bearer token never leaves googleapis.com', () => {
  it('ignores a persisted session URL on another host and never sends it the token', async () => {
    // A tampered (or corrupted) sessionStore entry used to receive
    // `Authorization: Bearer <token>` on the offset query.
    const persisted = new Map<string, GoogleDriveUploadSession>([
      ['f.db', { sessionUrl: 'https://attacker.example/steal', size: 3 }],
    ])
    const sessionStore: GoogleDriveSessionStore = {
      get: n => Promise.resolve(persisted.get(n) ?? null),
      set: (n, s) => {
        persisted.set(n, s)
        return Promise.resolve()
      },
      remove: (n) => {
        persisted.delete(n)
        return Promise.resolve()
      },
    }
    const { fetchImpl, calls } = makeFetch([
      { json: { files: [] } },
      { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=ok' } },
      { status: 200, json: { id: 'new' } },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 'secret-token', fetchImpl, sessionStore })

    await client.uploadFile('f.db', SOURCE)

    expect(calls.some(c => c.url.includes('attacker.example'))).toBe(false)
    for (const c of calls) expect(c.url.startsWith('https://www.googleapis.com/')).toBe(true)
  })

  it('rejects a Location header outside googleapis.com', async () => {
    const { fetchImpl, calls } = makeFetch([
      { json: { files: [] } },
      { headers: { Location: 'https://www.googleapis.com.evil.example/upload/x' } },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 'secret-token', fetchImpl })

    await expect(client.uploadFile('f.db', SOURCE)).rejects.toMatchObject({ serverErrorCode: 'UNTRUSTED_URL' })
    expect(calls).toHaveLength(2)
  })

  it('accepts upload sessions on a googleapis.com subdomain under /upload/', async () => {
    const { fetchImpl, calls } = makeFetch([
      { json: { files: [] } },
      { headers: { Location: 'https://content.googleapis.com/upload/drive/v3/files?upload_id=1' } },
      { status: 200, json: { id: 'new' } },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 't', fetchImpl })
    await client.uploadFile('f.db', SOURCE)
    expect(calls[2].url).toBe('https://content.googleapis.com/upload/drive/v3/files?upload_id=1')
  })
})

describe('Drive: server-controlled values', () => {
  it('clamps an absurd Retry-After and ignores a negative one', async () => {
    const huge = makeFetch([{ status: 429, headers: { 'Retry-After': '999999999' } }])
    const c1 = new GoogleDriveClient({ getAccessToken: () => 't', fetchImpl: huge.fetchImpl })
    const e1 = await c1.getQuota().catch((e: unknown) => e) as CloudSyncError
    expect(e1.code).toBe(ErrorCode.RATE_LIMITED)
    expect(e1.retryAfterMs).toBe(MAX_RETRY_AFTER_MS)

    const neg = makeFetch([{ status: 503, headers: { 'Retry-After': '-30' } }])
    const c2 = new GoogleDriveClient({ getAccessToken: () => 't', fetchImpl: neg.fetchImpl })
    const e2 = await c2.getQuota().catch((e: unknown) => e) as CloudSyncError
    expect(e2.retryAfterMs).toBe(0)
  })

  it('path-encodes server-issued file ids', async () => {
    const { fetchImpl, calls } = makeFetch([
      { json: { files: [{ id: '../about?x=', name: 'k' }] } },
      { text: 'v' },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 't', fetchImpl })
    await client.getItem('k')
    expect(calls[1].url).toBe('https://www.googleapis.com/drive/v3/files/..%2Fabout%3Fx%3D?alt=media')
  })

  it('rejects a non-numeric file size instead of reporting an empty download as done', async () => {
    const { fetchImpl } = makeFetch([
      { json: { files: [{ id: 'id1', name: 'f' }] } },
      { json: { size: 'lots' } },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 't', fetchImpl })
    const writes: Uint8Array[] = []
    await expect(client.downloadFile('f', { write: (b) => {
      writes.push(b)
      return Promise.resolve()
    } })).rejects.toBeInstanceOf(CloudSyncError)
    expect(writes).toHaveLength(0)
  })
})

describe('Drive: multipart boundary', () => {
  it('never uses a boundary that appears in the value', async () => {
    // A value carrying the boundary line ends the content part early and
    // injects whatever follows as another part.
    const realRandom = Math.random
    const realCrypto = (globalThis as { crypto?: unknown }).crypto
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
    let n = 0
    Math.random = () => (n++ < 4 ? 0.5 : 0.25)
    try {
      const predictable = `rncs-${(0.5).toString(36).slice(2).repeat(4)}`
      const value = `x\r\n--${predictable}\r\nContent-Type: text/plain\r\n\r\ninjected\r\n--${predictable}--`
      const { fetchImpl, calls } = makeFetch([{ json: { files: [] } }, { json: { id: 'n' } }])
      const client = new GoogleDriveClient({ getAccessToken: () => 't', fetchImpl })
      await client.setItem('k', value)

      const contentType = calls[1].headers.get('Content-Type') ?? ''
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? ''
      expect(boundary).not.toBe(predictable)
      expect(value.includes(boundary)).toBe(false)
      // Exactly the two parts this client wrote.
      expect(String(calls[1].body).split(`--${boundary}`)).toHaveLength(4)
    }
    finally {
      Math.random = realRandom
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true, writable: true })
    }
  })
})

describe('CloudKit REST', () => {
  function makeCk(replies: Reply[]) {
    const { fetchImpl, calls } = makeFetch(replies)
    const opened: string[] = []
    const xhrImpl = (): XMLHttpRequest => ({
      open: (_m: string, url: string) => opened.push(url),
      send: () => undefined,
      upload: {},
    }) as unknown as XMLHttpRequest
    const client = new CloudKitRestClient({
      containerIdentifier: 'iCloud.test',
      apiToken: 'api',
      environment: 'development',
      getAuthToken: () => 'web',
      fetchImpl,
      xhrImpl,
      timeoutMs: 0,
    })
    return { client, calls, opened }
  }

  it('does not serve another record\'s value for the requested key', async () => {
    const { client } = makeCk([
      { json: { records: [{ recordName: 'other', fields: { value: { value: 'not-mine' } } }] } },
    ])
    expect(await client.getRecord('mine')).toBeNull()
  })

  it('refuses a record of another type under the requested name', async () => {
    const foreign = { records: [{ recordName: 'k', recordType: 'Other', fields: { value: { value: 'x' } } }] }
    await expect(makeCk([{ json: foreign }]).client.getRecord('k')).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
    await expect(makeCk([{ json: foreign }]).client.getRecords(['k'])).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
    await expect(makeCk([{ json: foreign }]).client.fetchAsset('k', 'value')).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
  })

  it('reads a record whose type matches', async () => {
    const own = { records: [{ recordName: 'k', recordType: 'KVBlob', fields: { value: { value: 'mine' } } }] }
    expect(await makeCk([{ json: own }]).client.getRecord('k')).toBe('mine')
  })

  it('refuses a plain-HTTP asset download URL', async () => {
    const { client, opened } = makeCk([
      {
        json: {
          records: [{ recordName: 'r', fields: { f: { value: { downloadURL: 'http://cvws.example/${f}' } } } }],
        },
      },
    ])
    await expect(client.fetchAsset('r', 'f')).rejects.toMatchObject({ serverErrorCode: 'UNTRUSTED_URL' })
    expect(opened).toHaveLength(0)
  })

  it('refuses a plain-HTTP asset upload URL', async () => {
    const { client, opened } = makeCk([{ json: { tokens: [{ url: 'http://upload.example/a' }] } }])
    await expect(client.uploadAsset('r', 'f', new Uint8Array([1]))).rejects.toMatchObject({
      serverErrorCode: 'UNTRUSTED_URL',
    })
    expect(opened).toHaveLength(0)
  })

  it('clamps CloudKit retryAfter', async () => {
    const { client } = makeCk([{ json: { serverErrorCode: 'THROTTLED', retryAfter: 1e9 } }])
    const e = await client.getRecord('k').catch((x: unknown) => x) as CloudSyncError
    expect(e.retryAfterMs).toBe(MAX_RETRY_AFTER_MS)
  })
})

describe('base64ToBytes strictness', () => {
  it('rejects characters outside the alphabet instead of decoding garbage', () => {
    expect(() => base64ToBytes('AA*A')).toThrow(TypeError)
    expect(() => base64ToBytes('AAAAÿAAA')).toThrow(TypeError)
    expect(() => base64ToBytes('AAAAA')).toThrow(TypeError)
  })

  it('still round-trips and tolerates whitespace and padding', () => {
    const bytes = new Uint8Array([0, 255, 128, 7, 9])
    const b64 = bytesToBase64(bytes)
    expect(base64ToBytes(`${b64.slice(0, 4)}\n${b64.slice(4)}`)).toEqual(bytes)
  })
})
