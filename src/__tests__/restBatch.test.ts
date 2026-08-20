import { CloudKitRestClient } from '../internal/cloudKitRest'
import { GoogleDriveClient } from '../internal/googleDriveRest'
import { ErrorCode } from '../errors'

interface Call { url: string; method: string; body: unknown }

function makeCloudKit(responses: { status?: number; json: unknown }[]) {
  const calls: Call[] = []
  let i = 0

  const fetchImpl = ((url: string, init: RequestInit) => {
    const raw = typeof init.body === 'string' ? init.body : null
    calls.push({ url, method: init.method ?? 'GET', body: raw != null ? JSON.parse(raw) : null })
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
    getAuthToken: () => 'web-token',
    fetchImpl,
  })
  return { client, calls }
}

function record(name: string, value: string): unknown {
  return { recordName: name, fields: { value: { value } } }
}

describe('CloudKit batch reads', () => {
  it('looks up many records in one request', async () => {
    const { client, calls } = makeCloudKit([
      { json: { records: [record('a', '1'), record('b', '2')] } },
    ])

    await expect(client.getRecords(['a', 'b'])).resolves.toEqual(['1', '2'])
    // One request, not two - which is also one rate-limit budget instead of two.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/records/lookup')
    expect(calls[0].body).toMatchObject({ records: [{ recordName: 'a' }, { recordName: 'b' }] })
  })

  it('matches results back by recordName, not by position', async () => {
    // CloudKit does not promise the response preserves request order, and
    // zipping by index would silently hand back the wrong value for every key.
    const { client } = makeCloudKit([
      { json: { records: [record('b', 'B'), record('a', 'A')] } },
    ])

    await expect(client.getRecords(['a', 'b'])).resolves.toEqual(['A', 'B'])
  })

  it('treats one missing record as absent without failing the batch', async () => {
    const { client } = makeCloudKit([
      {
        json: {
          records: [record('a', '1'), { recordName: 'gone', serverErrorCode: 'NOT_FOUND' }],
        },
      },
    ])

    await expect(client.getRecords(['a', 'gone'])).resolves.toEqual(['1', null])
  })

  it('still surfaces a real per-record failure', async () => {
    const { client } = makeCloudKit([
      { json: { records: [{ recordName: 'a', serverErrorCode: 'QUOTA_EXCEEDED' }] } },
    ])

    await expect(client.getRecords(['a'])).rejects.toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
    })
  })

  it('splits an oversized batch into several requests', async () => {
    const { client, calls } = makeCloudKit([{ json: { records: [] } }])
    const keys = Array.from({ length: 450 }, (_, i) => `k${i}`)

    await client.getRecords(keys)

    // 200 per request, so 450 keys is three.
    expect(calls).toHaveLength(3)
    expect((calls[0].body as { records: unknown[] }).records).toHaveLength(200)
    expect((calls[2].body as { records: unknown[] }).records).toHaveLength(50)
  })

  it('does nothing at all for an empty batch', async () => {
    const { client, calls } = makeCloudKit([{ json: {} }])
    await expect(client.getRecords([])).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('CloudKit batch writes', () => {
  it('sends one forceUpdate operation per record in a single request', async () => {
    const { client, calls } = makeCloudKit([{ json: { records: [] } }])

    await client.saveRecords([['a', '1'], ['b', '2']])

    expect(calls).toHaveLength(1)
    const body = calls[0].body as { atomic: boolean; operations: { operationType: string }[] }
    expect(body.operations.map(o => o.operationType)).toEqual(['forceUpdate', 'forceUpdate'])
    // Not atomic: a batch is a convenience the caller asked for, not a
    // transaction, and one bad record must not discard the other 199.
    expect(body.atomic).toBe(false)
  })

  it('rejects an oversized value before sending anything', async () => {
    const { client, calls } = makeCloudKit([{ json: { records: [] } }])
    const huge = 'x'.repeat(1024 * 1024 + 1)

    await expect(client.saveRecords([['ok', 'v'], ['huge', huge]])).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
    })
    expect(calls).toHaveLength(0)
  })

  it('deletes many records in one request, tolerating ones already gone', async () => {
    const { client, calls } = makeCloudKit([
      { json: { records: [{ recordName: 'gone', serverErrorCode: 'NOT_FOUND' }] } },
    ])

    await expect(client.deleteRecords(['a', 'gone'])).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })
})

describe('CloudKit conditional writes', () => {
  it('sends the change tag so a concurrent edit is refused, not clobbered', async () => {
    const { client, calls } = makeCloudKit([{ json: { records: [record('a', 'mine')] } }])

    await client.saveRecordIfUnchanged('a', 'mine', 'tag-1')

    const body = calls[0].body as { operations: { operationType: string; record: unknown }[] }
    // `update` rather than `forceUpdate` is what makes it conditional.
    expect(body.operations[0].operationType).toBe('update')
    expect(body.operations[0].record).toMatchObject({ recordChangeTag: 'tag-1' })
  })

  it('reports a conflict with the server value, so the app can merge', async () => {
    const { client } = makeCloudKit([
      {
        json: {
          records: [{
            recordName: 'a',
            serverErrorCode: 'CONFLICT',
            serverRecord: { fields: { value: { value: 'theirs' } } },
          }],
        },
      },
    ])

    // Without a conditional write this error could never fire, which made the
    // documented merge path unreachable.
    await expect(client.saveRecordIfUnchanged('a', 'mine', 'stale')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      serverValue: 'theirs',
    })
  })
})

describe('CloudKit metadata reads', () => {
  it('surfaces the modification time and change tag a lookup already returns', async () => {
    const { client } = makeCloudKit([
      {
        json: {
          records: [{
            recordName: 'a',
            fields: { value: { value: 'v' } },
            modified: { timestamp: 1_700_000_000_000 },
            recordChangeTag: 'tag-9',
          }],
        },
      },
    ])

    await expect(client.getRecordWithMeta('a')).resolves.toEqual({
      value: 'v',
      modifiedAt: 1_700_000_000_000,
      recordChangeTag: 'tag-9',
    })
  })

  it('reports no timestamp rather than a fake one when the response omits it', async () => {
    const { client } = makeCloudKit([{ json: { records: [record('a', 'v')] } }])
    await expect(client.getRecordWithMeta('a')).resolves.toMatchObject({ modifiedAt: undefined })
  })
})

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

interface Reply { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }

function makeDrive(replies: Reply[]) {
  const calls: { url: string; method: string }[] = []
  let i = 0

  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET' })
    const reply = replies[Math.min(i, replies.length - 1)]
    i += 1
    const status = reply.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(reply.json ?? {}),
      text: () => Promise.resolve(reply.text ?? ''),
      headers: new Headers(reply.headers ?? {}),
    } as unknown as Response)
  }) as unknown as typeof fetch

  const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl })
  return { client, calls }
}

describe('Drive metadata and quota', () => {
  it('reports modifiedTime, which the name lookup already had to fetch', async () => {
    const { client, calls } = makeDrive([
      { json: { files: [{ id: 'id1', name: 'k', modifiedTime: '2024-03-01T12:00:00.000Z' }] } },
      { text: 'value' },
    ])

    await expect(client.getItemWithMeta('k')).resolves.toEqual({
      value: 'value',
      modifiedAt: Date.parse('2024-03-01T12:00:00.000Z'),
      version: undefined,
    })
    // Free: the listing that resolves a name to an id is asked for the field.
    expect(calls[0].url).toContain('modifiedTime')
  })

  it('reports no timestamp rather than NaN when Drive omits one', async () => {
    const { client } = makeDrive([
      { json: { files: [{ id: 'id1', name: 'k' }] } },
      { text: 'value' },
    ])

    await expect(client.getItemWithMeta('k')).resolves.toMatchObject({ modifiedAt: undefined })
  })

  it('resolves null for a key that is not there', async () => {
    const { client } = makeDrive([{ json: { files: [] } }])
    await expect(client.getItemWithMeta('missing')).resolves.toBeNull()
  })

  it('reads account storage usage', async () => {
    const { client, calls } = makeDrive([
      { json: { storageQuota: { usage: '1024', limit: '15000000000' } } },
    ])

    await expect(client.getQuota()).resolves.toEqual({
      usedBytes: 1024,
      totalBytes: 15000000000,
    })
    expect(calls[0].url).toContain('storageQuota')
  })

  it('reports no total for an unlimited account rather than zero', async () => {
    // Workspace pooled storage omits `limit`. Reporting 0 would make a
    // "you are out of space" prompt fire for someone who has plenty.
    const { client } = makeDrive([{ json: { storageQuota: { usage: '10' } } }])
    await expect(client.getQuota()).resolves.toEqual({ usedBytes: 10, totalBytes: undefined })
  })
})

describe('Drive change polling', () => {
  it('takes a starting cursor, then reports names changed since', async () => {
    const { client } = makeDrive([
      { json: { startPageToken: 'tok-1' } },
      {
        json: {
          newStartPageToken: 'tok-2',
          changes: [{ fileId: 'id1', file: { id: 'id1', name: 'changed' } }],
        },
      },
    ])

    const cursor = await client.getStartPageToken()
    expect(cursor).toBe('tok-1')

    await expect(client.pollChanges(cursor)).resolves.toEqual({
      names: ['changed'],
      nextToken: 'tok-2',
    })
  })

  it('follows every page before returning the next cursor', async () => {
    const { client, calls } = makeDrive([
      {
        json: {
          nextPageToken: 'page-2',
          changes: [{ fileId: 'a', file: { id: 'a', name: 'first' } }],
        },
      },
      {
        json: {
          newStartPageToken: 'tok-final',
          changes: [{ fileId: 'b', file: { id: 'b', name: 'second' } }],
        },
      },
    ])

    const result = await client.pollChanges('tok-1')
    expect(result.names.sort()).toEqual(['first', 'second'])
    expect(result.nextToken).toBe('tok-final')
    expect(calls).toHaveLength(2)
  })

  it('reports a deletion, which matters as much as a change', async () => {
    const { client } = makeDrive([
      {
        json: {
          newStartPageToken: 'tok-2',
          changes: [{ fileId: 'id1', removed: true, file: { id: 'id1', name: 'deleted' } }],
        },
      },
    ])

    await expect(client.pollChanges('tok-1')).resolves.toMatchObject({ names: ['deleted'] })
  })

  it('drops the memoised id of a file another device deleted', async () => {
    const { client, calls } = makeDrive([
      // Prime the cache with a lookup.
      { json: { files: [{ id: 'id1', name: 'k' }] } },
      { text: 'v' },
      // Then a change feed saying it is gone.
      {
        json: {
          newStartPageToken: 'tok-2',
          changes: [{ fileId: 'id1', removed: true, file: { id: 'id1', name: 'k' } }],
        },
      },
      // The next read must look the name up again rather than reuse the id.
      { json: { files: [] } },
    ])

    await client.getItem('k')
    const before = calls.length
    await client.pollChanges('tok-1')
    await expect(client.getItem('k')).resolves.toBeNull()

    // A listing request, proving the stale id was not reused.
    expect(calls.length).toBeGreaterThan(before + 1)
  })
})
