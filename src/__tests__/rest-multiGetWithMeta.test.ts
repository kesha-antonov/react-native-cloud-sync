import { CloudKitRestClient } from '../internal/cloudKitRest'
import { GoogleDriveClient } from '../internal/googleDriveRest'
import { createCloudKitProvider } from '../providers/cloudKit'
import { createGoogleDriveProvider } from '../providers/googleDrive'
import { ErrorCode } from '../errors'

interface Reply { status?: number; json?: unknown; text?: string }

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; method: string; body: unknown }[] = []
  let i = 0
  const fetchImpl = ((url: string, init: RequestInit) => {
    const raw = typeof init.body === 'string' ? init.body : null
    let body: unknown = raw
    try {
      body = raw != null ? JSON.parse(raw) : null
    }
    catch {
      // Not JSON - keep the raw string.
    }
    calls.push({ url, method: init.method ?? 'GET', body })
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
  return { fetchImpl, calls }
}

const ckConfig = {
  containerIdentifier: 'iCloud.test',
  apiToken: 'api',
  environment: 'development' as const,
  getAuthToken: () => 'web',
}

describe('CloudKit getRecordsWithMeta', () => {
  it('returns values and timestamps from one lookup, in input order, null for missing', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      json: {
        records: [
          { recordName: 'b', fields: { value: { value: 'B' } }, modified: { timestamp: 2 }, recordChangeTag: 't-b' },
          { recordName: 'missing', serverErrorCode: 'NOT_FOUND' },
          { recordName: 'a', fields: { value: { value: 'A' } }, modified: { timestamp: 1 } },
        ],
      },
    }])
    const client = new CloudKitRestClient({ ...ckConfig, fetchImpl })

    await expect(client.getRecordsWithMeta(['a', 'missing', 'b'])).resolves.toEqual([
      { value: 'A', modifiedAt: 1, recordChangeTag: undefined },
      null,
      { value: 'B', modifiedAt: 2, recordChangeTag: 't-b' },
    ])
    expect(calls).toHaveLength(1)
  })

  it('is exposed as multiGetWithMeta on a REST provider', async () => {
    const { fetchImpl, calls } = fakeFetch([{
      json: { records: [{ recordName: 'k', fields: { value: { value: 'v' } }, modified: { timestamp: 5 } }] },
    }])
    const provider = createCloudKitProvider({ ...ckConfig, fetchImpl })

    await expect(provider.multiGetWithMeta!(['k'])).resolves.toMatchObject([{ value: 'v', modifiedAt: 5 }])
    expect(calls[0].url).toContain('/records/lookup')
  })

  it('still refuses keys in the encrypted namespace', async () => {
    const { fetchImpl } = fakeFetch([{ json: {} }])
    const provider = createCloudKitProvider({ ...ckConfig, fetchImpl })
    await expect(provider.multiGetWithMeta!(['rncs-enc.k']))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_KEY })
  })
})

describe('Drive getItemsWithMeta', () => {
  it('resolves every name in one listing, then downloads each, in input order', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        json: {
          files: [
            { id: 'id-b', name: 'b', modifiedTime: '2024-02-01T00:00:00.000Z' },
            { id: 'id-a', name: 'a', modifiedTime: '2024-01-01T00:00:00.000Z' },
          ],
        },
      },
      { text: 'A' },
      { text: 'B' },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl })

    await expect(client.getItemsWithMeta(['a', 'missing', 'b'])).resolves.toEqual([
      { value: 'A', modifiedAt: Date.parse('2024-01-01T00:00:00.000Z'), version: undefined },
      null,
      { value: 'B', modifiedAt: Date.parse('2024-02-01T00:00:00.000Z'), version: undefined },
    ])

    const listings = calls.filter(c => !c.url.includes('alt=media'))
    expect(listings).toHaveLength(1)
    const q = new URL(listings[0].url).searchParams.get('q')
    expect(q).toBe('(name=\'a\' or name=\'missing\' or name=\'b\') and trashed=false')
    expect(calls[1].url).toContain('/id-a?alt=media')
    expect(calls[2].url).toContain('/id-b?alt=media')
  })

  it('splits a large batch across several listing queries', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { files: [] } }])
    const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl })
    const names = Array.from({ length: 120 }, (_, i) => `k${i}`)

    const out = await client.getItemsWithMeta(names)
    expect(out).toHaveLength(120)
    expect(out.every(v => v == null)).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('picks the newest of duplicate names, as single reads do', async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        json: {
          files: [
            { id: 'older', name: 'k', modifiedTime: '2024-01-01T00:00:00.000Z' },
            { id: 'newer', name: 'k', modifiedTime: '2024-03-01T00:00:00.000Z' },
          ],
        },
      },
      { text: 'v' },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl })

    await expect(client.getItemsWithMeta(['k'])).resolves.toMatchObject([
      { value: 'v', modifiedAt: Date.parse('2024-03-01T00:00:00.000Z') },
    ])
    expect(calls[1].url).toContain('/newer?alt=media')
  })

  it('re-resolves one name deleted between listing and download, without failing the batch', async () => {
    const { fetchImpl } = fakeFetch([
      { json: { files: [{ id: 'gone', name: 'k' }] } },
      { status: 404 },
      { json: { files: [] } },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl })

    await expect(client.getItemsWithMeta(['k'])).resolves.toEqual([null])
  })

  it('handles a repeated key and an empty batch', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { json: { files: [{ id: 'id', name: 'k' }] } },
      { text: 'v' },
    ])
    const client = new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl })

    await expect(client.getItemsWithMeta([])).resolves.toEqual([])
    const out = await client.getItemsWithMeta(['k', 'k'])
    expect(out.map(r => r?.value)).toEqual(['v', 'v'])
    expect(calls).toHaveLength(2)
  })

  it('is exposed as multiGetWithMeta on the provider', async () => {
    const { fetchImpl } = fakeFetch([
      { json: { files: [{ id: 'id', name: 'k', modifiedTime: '2024-01-01T00:00:00.000Z' }] } },
      { text: 'v' },
    ])
    const provider = createGoogleDriveProvider({ getAccessToken: () => 'token', fetchImpl })
    await expect(provider.multiGetWithMeta!(['k'])).resolves.toMatchObject([{ value: 'v' }])
  })
})
