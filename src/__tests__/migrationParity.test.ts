import { createCloudStore, type CloudStore } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import { cloudKit } from '../providers/cloudKit'
import { GoogleDriveClient } from '../internal/googleDriveRest'
import { ErrorCode } from '../errors'
import type { AccountChangeEvent } from '../types'

/**
 * Behaviour the libraries people are migrating from provide, checked here so a
 * swap does not quietly lose something. Each case comes from reading a specific
 * competitor's public API, not from guessing at what might be useful.
 */

function withProviders(providers: MemoryProvider[], extra: Record<string, unknown> = {}): CloudStore {
  const store = createCloudStore({
    providers: providers.map(p => p.name),
    availabilityTtlMs: 0,
    ...extra,
  })
  for (const p of providers) store.registerProvider(p)
  return store
}

describe('getAllItems, which every key-value library being migrated from has', () => {
  it('returns keys and values as one object', async () => {
    const mem = createMemoryProvider({ initial: { a: '1', b: '2' } })
    await expect(withProviders([mem]).getAllItems()).resolves.toEqual({ a: '1', b: '2' })
  })

  it('is empty rather than rejecting when there is nothing stored', async () => {
    await expect(withProviders([createMemoryProvider()]).getAllItems()).resolves.toEqual({})
  })

  it('merges across providers, like getAllKeys does', async () => {
    const a = createMemoryProvider({ name: 'a', initial: { x: '1' } })
    const b = createMemoryProvider({ name: 'b', initial: { y: '2' } })
    await expect(withProviders([a, b]).getAllItems()).resolves.toEqual({ x: '1', y: '2' })
  })
})

describe('an account event reaching app listeners once, not once per provider', () => {
  it('collapses the same system notification relabelled by two providers', () => {
    // On Apple platforms icloudKV and cloudKit both observe the same two
    // notifications and relabel them - correctly, since an Apple ID change
    // matters to both - so without dedupe one event is delivered twice.
    const first = createMemoryProvider({ name: 'icloudKV' })
    const second = createMemoryProvider({ name: 'cloudKit' })
    const store = withProviders([first, second])

    const seen: AccountChangeEvent[] = []
    store.onAccountChange(e => seen.push(e))

    first.emitAccountChange({ status: 'available', identityChanged: true })
    second.emitAccountChange({ status: 'available', identityChanged: true })

    expect(seen).toHaveLength(1)
  })

  it('still delivers a genuinely different event', () => {
    const mem = createMemoryProvider()
    const store = withProviders([mem])

    const seen: AccountChangeEvent[] = []
    store.onAccountChange(e => seen.push(e))

    mem.emitAccountChange({ status: 'available', identityChanged: true })
    mem.emitAccountChange({ status: 'noAccount', identityChanged: false })

    expect(seen.map(e => e.status)).toEqual(['available', 'noAccount'])
  })
})

describe('cloudKit does not offer a change subscription it cannot honour', () => {
  it('leaves onRemoteChange undefined rather than never calling the listener', () => {
    // It used to be present and filter for `provider === 'cloudKit'`, while the
    // only native `remoteChange` emitted is tagged `icloudKV` - so it accepted
    // listeners and could never call them. Absent is checkable; silent is not.
    expect(cloudKit.onRemoteChange).toBeUndefined()
  })

  it('still reports account changes, which do fire', () => {
    expect(cloudKit.onAccountChange).toBeDefined()
  })
})

describe('Drive files that share a name', () => {
  function makeClient(files: unknown[], onDuplicateName?: 'newest' | 'error') {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files }),
        text: () => Promise.resolve('body'),
        headers: new Headers(),
      } as unknown as Response)) as unknown as typeof fetch

    return new GoogleDriveClient({ getAccessToken: () => 'token', fetchImpl, onDuplicateName })
  }

  const DUPES = [
    { id: 'older', name: 'k', modifiedTime: '2024-01-01T00:00:00.000Z' },
    { id: 'newer', name: 'k', modifiedTime: '2024-06-01T00:00:00.000Z' },
  ]

  it('picks the newest, so every device agrees which file is the key', async () => {
    // Drive names are not unique. Taking whichever the API listed first is
    // unspecified, so two devices can settle on two different files and
    // diverge permanently with nothing reported anywhere.
    const client = makeClient(DUPES)
    await expect(client.getItemWithMeta('k')).resolves.toMatchObject({
      modifiedAt: Date.parse('2024-06-01T00:00:00.000Z'),
    })
  })

  it('reaches the same answer whatever order the API returns them in', async () => {
    const forward = makeClient(DUPES)
    const reversed = makeClient([...DUPES].reverse())

    const a = await forward.getItemWithMeta('k')
    const b = await reversed.getItemWithMeta('k')
    expect(a?.modifiedAt).toBe(b?.modifiedAt)
  })

  it('can be told to raise a conflict instead of picking', async () => {
    await expect(makeClient(DUPES, 'error').getItem('k')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      serverErrorCode: 'DUPLICATE_NAME',
    })
  })

  it('does not treat a single match as a duplicate', async () => {
    const client = makeClient([{ id: 'only', name: 'k' }], 'error')
    await expect(client.getItem('k')).resolves.toBe('body')
  })
})
