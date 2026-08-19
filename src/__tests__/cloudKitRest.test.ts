import { CloudKitRestClient, byteLength } from '../internal/cloudKitRest'
import { ErrorCode, isCloudSyncError } from '../errors'

interface FetchCall { url: string; body: unknown }

function makeClient(
  responses: { status?: number; json: unknown }[],
  overrides: { onAuthExpired?: () => void; authToken?: string | null } = {}
) {
  const calls: FetchCall[] = []
  let i = 0

  const fetchImpl = ((url: string, init: RequestInit) => {
    const rawBody = typeof init.body === 'string' ? init.body : null
    calls.push({ url, body: rawBody != null ? JSON.parse(rawBody) : null })
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    const status = r.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(r.json),
      text: () => Promise.resolve(JSON.stringify(r.json)),
      headers: new Headers(),
    } as unknown as Response)
  }) as unknown as typeof fetch

  const client = new CloudKitRestClient({
    containerIdentifier: 'iCloud.test',
    apiToken: 'api-token',
    environment: 'development',
    getAuthToken: () => (overrides.authToken === undefined ? 'web-token' : overrides.authToken),
    onAuthExpired: overrides.onAuthExpired,
    fetchImpl,
  })
  return { client, calls }
}

describe('AUTHENTICATION_REQUIRED handling', () => {
  // The regression this whole client exists to fix. CloudKit answers an expired
  // token with HTTP 421 and a TOP-LEVEL error dict - there is no `records`
  // array at all. An implementation that looks for the error inside `records`
  // (as cryptoc's did) can never see it, so the token is never cleared and every
  // subsequent read and write silently no-ops forever.
  it('detects the top-level 421 error dict that has no records array', async () => {
    const onAuthExpired = jest.fn()
    const { client } = makeClient(
      [{
        status: 421,
        json: {
          uuid: 'abc',
          serverErrorCode: 'AUTHENTICATION_REQUIRED',
          reason: 'request needs authorization',
          redirectURL: 'https://idmsa.apple.com/...',
        },
      }],
      { onAuthExpired }
    )

    await expect(client.getRecord('k')).rejects.toMatchObject({
      code: ErrorCode.AUTH_EXPIRED,
    })
    expect(onAuthExpired).toHaveBeenCalledTimes(1)
  })

  it('still reports auth failure when the body is unparseable', async () => {
    const onAuthExpired = jest.fn()
    const { client } = makeClient([{ status: 401, json: null }], { onAuthExpired })

    await expect(client.getRecord('k')).rejects.toMatchObject({ code: ErrorCode.AUTH_EXPIRED })
    expect(onAuthExpired).toHaveBeenCalled()
  })
})

describe('missing records', () => {
  // The real Web Services code is NOT_FOUND. `UNKNOWN_ITEM` is a CloudKit
  // *framework* code that never appears over REST, so matching on it
  // misclassifies every miss as a failure.
  it('treats NOT_FOUND on lookup as an absent key, not an error', async () => {
    const { client } = makeClient([
      { json: { records: [{ recordName: 'k', serverErrorCode: 'NOT_FOUND' }] } },
    ])
    await expect(client.getRecord('k')).resolves.toBeNull()
  })

  it('treats NOT_FOUND on delete as success - the end state already holds', async () => {
    const { client } = makeClient([
      { json: { records: [{ recordName: 'k', serverErrorCode: 'NOT_FOUND' }] } },
    ])
    await expect(client.deleteRecord('k')).resolves.toBeUndefined()
  })
})

describe('error mapping', () => {
  it('maps THROTTLED to a retryable rate-limit error carrying retryAfter', async () => {
    const { client } = makeClient([
      { json: { serverErrorCode: 'THROTTLED', reason: 'slow down', retryAfter: 30 } },
    ])
    try {
      await client.getRecord('k')
      throw new Error('should have rejected')
    }
    catch (e) {
      expect(isCloudSyncError(e)).toBe(true)
      expect((e as { code: string }).code).toBe(ErrorCode.RATE_LIMITED)
      expect((e as { retryAfterMs?: number }).retryAfterMs).toBe(30_000)
    }
  })

  it('maps QUOTA_EXCEEDED distinctly from a network failure', async () => {
    const { client } = makeClient([{ json: { serverErrorCode: 'QUOTA_EXCEEDED' } }])
    await expect(client.getRecord('k')).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED })
  })

  it('reports a fetch rejection as NETWORK_UNAVAILABLE rather than null', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    const client = new CloudKitRestClient({
      containerIdentifier: 'iCloud.test',
      apiToken: 't',
      environment: 'development',
      getAuthToken: () => 'web-token',
      fetchImpl,
    })
    await expect(client.getRecord('k')).rejects.toMatchObject({
      code: ErrorCode.NETWORK_UNAVAILABLE,
    })
  })
})

describe('configuration guards', () => {
  it('says the container is misconfigured when no API token was supplied', async () => {
    const { client } = makeClient([{ json: {} }])
    const bad = new CloudKitRestClient({
      containerIdentifier: 'iCloud.test',
      apiToken: '',
      environment: 'development',
      getAuthToken: () => 'web-token',
      fetchImpl: () => Promise.resolve({} as Response),
    })
    void client
    await expect(bad.getRecord('k')).rejects.toMatchObject({
      code: ErrorCode.CONTAINER_MISCONFIGURED,
    })
  })

  it('says NOT_SIGNED_IN when there is no web auth token', async () => {
    const { client } = makeClient([{ json: {} }], { authToken: null })
    await expect(client.getRecord('k')).rejects.toMatchObject({ code: ErrorCode.NOT_SIGNED_IN })
  })
})

describe('saveRecord', () => {
  it('sets atomic explicitly rather than relying on the server default', async () => {
    const { client, calls } = makeClient([{ json: { records: [{ recordName: 'k' }] } }])
    await client.saveRecord('k', 'v')
    expect((calls[0].body as { atomic: boolean }).atomic).toBe(true)
  })

  it('falls back to forceUpdate when the record already exists', async () => {
    const { client, calls } = makeClient([
      { json: { records: [{ recordName: 'k', serverErrorCode: 'EXISTS' }] } },
      { json: { records: [{ recordName: 'k' }] } },
    ])
    await client.saveRecord('k', 'v')

    expect(calls).toHaveLength(2)
    const ops = (calls[1].body as { operations: { operationType: string }[] }).operations
    expect(ops[0].operationType).toBe('forceUpdate')
  })

  it('falls through to forceUpdate on a top-level ATOMIC_ERROR', async () => {
    // With atomic: true, CloudKit reports a failed operation at the top level
    // rather than per record, so an already-exists create arrives as a throw.
    const { client, calls } = makeClient([
      { json: { serverErrorCode: 'ATOMIC_ERROR', reason: 'record exists' } },
      { json: { records: [{ recordName: 'k' }] } },
    ])
    await client.saveRecord('k', 'v')

    expect(calls).toHaveLength(2)
    const ops = (calls[1].body as { operations: { operationType: string }[] }).operations
    expect(ops[0].operationType).toBe('forceUpdate')
  })

  it('does NOT force-update after a failure it could not classify', async () => {
    // Regression guard. Swallowing an unclassified create failure and
    // force-updating anyway would overwrite whatever is on the server on the
    // strength of an error nobody read - the exact class of bug this package
    // exists to prevent.
    const { client, calls } = makeClient([
      { json: { serverErrorCode: 'SOMETHING_UNEXPECTED', reason: 'who knows' } },
    ])

    await expect(client.saveRecord('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.UNKNOWN,
      serverErrorCode: 'SOMETHING_UNEXPECTED',
    })
    // One call only - no blind second write.
    expect(calls).toHaveLength(1)
  })

  it('does NOT force-update after a quota failure', async () => {
    const { client, calls } = makeClient([{ json: { serverErrorCode: 'QUOTA_EXCEEDED' } }])

    await expect(client.saveRecord('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
    })
    expect(calls).toHaveLength(1)
  })

  it('rejects an oversized value locally instead of letting the server drop it', async () => {
    const { client, calls } = makeClient([{ json: { records: [{ recordName: 'k' }] } }])
    const tooBig = 'x'.repeat(1024 * 1024 + 1)

    await expect(client.saveRecord('k', tooBig)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      limitBytes: 1024 * 1024,
    })
    expect(calls).toHaveLength(0)
  })
})

describe('byteLength', () => {
  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // A payload that looks short by String.length but is not, which is exactly
    // how a value slips past a naive size check and fails server-side.
    expect('café'.length).toBe(4)
    expect(byteLength('café')).toBe(5)
    expect(byteLength('日本語')).toBe(9)
  })
})

describe('queryRecordNames pagination', () => {
  // `/records/query` caps a response at 200 records and returns a continuation
  // marker for the rest. Taking only the first page silently truncated
  // getAllKeys(), and migrate() is built on getAllKeys() - so a migration
  // quietly copied part of the data and reported success.
  it('follows the continuation marker to the end', async () => {
    const { client, calls } = makeClient([
      {
        json: {
          records: [{ recordName: 'a' }, { recordName: 'b' }],
          continuationMarker: 'marker-1',
        },
      },
      { json: { records: [{ recordName: 'c' }] } },
    ])

    await expect(client.queryRecordNames()).resolves.toEqual(['a', 'b', 'c'])

    expect(calls).toHaveLength(2)
    expect(calls[0].body).toMatchObject({ query: { recordType: 'KVBlob' } })
    expect(calls[0].body).not.toHaveProperty('continuationMarker')
    expect(calls[1].body).toMatchObject({ continuationMarker: 'marker-1' })
  })

  it('stops after a single page when there is no marker', async () => {
    const { client, calls } = makeClient([{ json: { records: [{ recordName: 'a' }] } }])

    await expect(client.queryRecordNames()).resolves.toEqual(['a'])
    expect(calls).toHaveLength(1)
  })

  it('refuses to loop when a server repeats the same marker', async () => {
    // Defensive: a marker that never advances would otherwise spin forever.
    const { client, calls } = makeClient([
      { json: { records: [{ recordName: 'a' }], continuationMarker: 'stuck' } },
    ])

    await expect(client.queryRecordNames()).resolves.toEqual(['a', 'a'])
    expect(calls).toHaveLength(2)
  })
})

describe('isReachable', () => {
  it('memoises, so a read does not cost two round trips', async () => {
    // `isAvailable()` is documented as safe on a render path, and the store
    // calls it before every provider read. An unmemoised probe doubled the
    // request count of every getItem on Android and web.
    const { client, calls } = makeClient([{ json: { records: [] } }])

    await expect(client.isReachable()).resolves.toBe(true)
    await expect(client.isReachable()).resolves.toBe(true)

    expect(calls).toHaveLength(1)
  })

  it('reports false when the container cannot be reached, without throwing', async () => {
    const { client } = makeClient([
      { status: 421, json: { serverErrorCode: 'AUTHENTICATION_REQUIRED' } },
    ])

    await expect(client.isReachable()).resolves.toBe(false)
  })
})
