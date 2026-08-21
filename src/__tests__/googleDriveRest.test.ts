import { GoogleDriveClient } from '../internal/googleDriveRest'
import { ErrorCode } from '../errors'

interface Call { url: string; method: string; body: string | null }

interface Reply {
  status?: number
  json?: unknown
  text?: string
}

/**
 * A Drive stub driven by a queue of replies, one per request, so a test can
 * describe exactly what the API returns at each step of a multi-request path.
 */
function makeClient(replies: Reply[]) {
  const calls: Call[] = []
  let i = 0

  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : null,
    })
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    const status = reply.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.json ?? {}),
      text: () => Promise.resolve(reply.text ?? ''),
      headers: new Headers(),
    } as unknown as Response)
  }) as unknown as typeof fetch

  const client = new GoogleDriveClient({
    getAccessToken: () => 'access-token',
    fetchImpl,
  })
  return { client, calls }
}

const found = (id: string, name: string): Reply => ({ json: { files: [{ id, name }] } })
const empty: Reply = { json: { files: [] } }
const gone: Reply = { status: 404 }

describe('memoised file ids', () => {
  it('resolves a name once and reuses the id', async () => {
    const { client, calls } = makeClient([
      found('id-1', 'k'),
      { text: 'value' },
      { text: 'value' },
    ])

    await expect(client.getItem('k')).resolves.toBe('value')
    await expect(client.getItem('k')).resolves.toBe('value')

    // Two reads, three requests: the second read skipped the name lookup.
    expect(calls).toHaveLength(3)
  })
})

describe('an id that another device deleted', () => {
  // Drive has no get-by-name endpoint, so ids are memoised. When a file is
  // deleted from another device the memo goes stale, and the 404 that follows
  // used to surface as ERR_UNKNOWN - permanently, because nothing ever evicted
  // the bad entry. The key became unreadable and unwritable for the session.
  it('reports a genuinely absent key as null rather than failing forever', async () => {
    const { client } = makeClient([
      found('id-1', 'k'),
      { text: 'value' },
      // Deleted elsewhere: the memoised id 404s, and the re-lookup finds nothing.
      gone,
      empty,
    ])

    await expect(client.getItem('k')).resolves.toBe('value')
    await expect(client.getItem('k')).resolves.toBeNull()
  })

  it('picks up the new id when the file was replaced, not removed', async () => {
    const { client } = makeClient([
      found('id-1', 'k'),
      { text: 'old' },
      gone,
      found('id-2', 'k'),
      { text: 'new' },
    ])

    await expect(client.getItem('k')).resolves.toBe('old')
    await expect(client.getItem('k')).resolves.toBe('new')
  })

  it('recreates the file instead of failing the write', async () => {
    const { client, calls } = makeClient([
      found('id-1', 'k'),
      { text: 'value' },
      gone, // the PATCH against the stale id
      { json: { id: 'id-2' } }, // the multipart create that replaces it
    ])

    await client.getItem('k')
    await expect(client.setItem('k', 'v')).resolves.toBeUndefined()

    const create = calls[calls.length - 1]
    expect(create.method).toBe('POST')
    expect(create.url).toContain('uploadType=multipart')
    expect(create.body).toContain('appDataFolder')
  })

  it('treats a delete of an already-deleted file as done', async () => {
    const { client } = makeClient([
      found('id-1', 'k'),
      { text: 'value' },
      gone, // the DELETE against the stale id
    ])

    await client.getItem('k')
    await expect(client.removeItem('k')).resolves.toBeUndefined()
  })

  it('does not mistake a real failure for a stale id', async () => {
    const { client } = makeClient([found('id-1', 'k'), { status: 500 }])

    await expect(client.getItem('k')).rejects.toMatchObject({
      code: ErrorCode.UNKNOWN,
    })
  })

  it('still surfaces an auth failure rather than retrying blind', async () => {
    const { client } = makeClient([found('id-1', 'k'), { status: 401 }])

    await expect(client.getItem('k')).rejects.toMatchObject({
      code: ErrorCode.AUTH_EXPIRED,
    })
  })
})

describe('HTTP 403 reason classification', () => {
  // Drive overloads 403 for three unrelated conditions, distinguished only by
  // `error.errors[0].reason` in the body - a plain status-code check would
  // misclassify a full-storage user as an auth failure and wrongly prompt them
  // to reconnect their account instead of telling them to free up space.
  it('reports storageQuotaExceeded as ERR_QUOTA_EXCEEDED, not an auth failure', async () => {
    const { client } = makeClient([
      found('id-1', 'k'),
      { status: 403, json: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } },
    ])

    await expect(client.setItem('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
    })
  })

  it.each(['userRateLimitExceeded', 'rateLimitExceeded'])(
    'reports %s as ERR_RATE_LIMITED, not an auth failure',
    async (reason) => {
      const { client } = makeClient([
        found('id-1', 'k'),
        { status: 403, json: { error: { errors: [{ reason }] } } },
      ])

      await expect(client.setItem('k', 'v')).rejects.toMatchObject({
        code: ErrorCode.RATE_LIMITED,
      })
    }
  )

  it('falls back to ERR_AUTH_EXPIRED for a 403 with no recognised reason', async () => {
    const onAuthExpired = jest.fn()
    const calls: Reply[] = [
      found('id-1', 'k'),
      { status: 403, json: { error: { errors: [{ reason: 'insufficientFilePermissions' }] } } },
    ]
    const fetchImpl = (() => {
      const i = { n: 0 }
      return () => {
        const reply = calls[Math.min(i.n, calls.length - 1)]
        i.n += 1
        const status = reply.status ?? 200
        return Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(reply.json ?? {}),
          text: () => Promise.resolve(reply.text ?? ''),
          headers: new Headers(),
        } as unknown as Response)
      }
    })() as unknown as typeof fetch

    const client = new GoogleDriveClient({ getAccessToken: () => 'access-token', fetchImpl, onAuthExpired })

    await expect(client.setItem('k', 'v')).rejects.toMatchObject({ code: ErrorCode.AUTH_EXPIRED })
    expect(onAuthExpired).toHaveBeenCalledTimes(1)
  })

  it('still treats a plain 401 as an auth failure without inspecting the body', async () => {
    const { client } = makeClient([found('id-1', 'k'), { status: 401 }])

    await expect(client.setItem('k', 'v')).rejects.toMatchObject({ code: ErrorCode.AUTH_EXPIRED })
  })
})

describe('filename query escaping', () => {
  it('escapes a literal backslash before a literal quote, not after', async () => {
    const { client, calls } = makeClient([empty])

    await client.getItem('a\\b\'s file')

    const url = decodeURIComponent(calls[0].url)
    // The one real backslash before "b" is escaped first, becoming two, and
    // the one real quote is escaped separately, becoming backslash-quote -
    // `a\b's file` -> `a\\b\'s file`. Regex avoids fighting JS string-literal
    // escaping for a value that itself contains both backslashes and quotes.
    expect(/name='a\\\\b\\'s file'/.test(url)).toBe(true)
  })
})

describe('getAllKeys', () => {
  it('paginates and memoises every id it saw', async () => {
    const { client, calls } = makeClient([
      { json: { files: [{ id: 'id-a', name: 'a' }], nextPageToken: 'page-2' } },
      { json: { files: [{ id: 'id-b', name: 'b' }] } },
      { text: 'value-b' },
    ])

    await expect(client.getAllKeys()).resolves.toEqual(['a', 'b'])
    expect(calls).toHaveLength(2)

    // The listing warmed the cache, so this read needs no name lookup.
    await expect(client.getItem('b')).resolves.toBe('value-b')
    expect(calls[2].url).toContain('id-b')
  })
})
