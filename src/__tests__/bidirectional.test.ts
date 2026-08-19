import { createCloudStore } from '../store'
import { createMemoryProvider } from '../providers/memory'
import { resolveByTimestamp } from '../resolvers'

/**
 * A mixed fleet, modelled honestly:
 *
 * - Apple devices (iPhone, iPad, Mac) reach iCloud AND Drive.
 * - Android and web reach Drive only - iCloud has no API there.
 *
 * The direction that breaks naively is Android -> Apple: an Apple device always
 * finds *something* in iCloud, so a newer value written from Android via Drive
 * is never even looked at.
 */
function fleet() {
  const icloudBase = createMemoryProvider()
  const driveBase = createMemoryProvider()
  const icloud = { ...icloudBase, name: 'icloudKV' as const }
  const drive = { ...driveBase, name: 'googleDrive' as const }

  const apple = (opts: Parameters<typeof createCloudStore>[0]) => {
    const s = createCloudStore(opts)
    s.registerProvider(icloud)
    s.registerProvider(drive)
    return s
  }

  // Android can only reach Drive, so it is configured with only Drive.
  const android = () => {
    const s = createCloudStore({ providers: ['googleDrive'] })
    s.registerProvider(drive)
    return s
  }

  return { icloudBase, driveBase, apple, android }
}

const stamped = (text: string, at: number) => JSON.stringify({ text, updatedAt: at })
const textOf = (raw: string | null) => (raw == null ? null : (JSON.parse(raw) as { text: string }).text)

describe('mixed fleet without a resolver', () => {
  it('serves a stale Apple copy and never sees the Android write', async () => {
    // Documents the default, so nobody is surprised by it: first non-null wins.
    const { apple, android } = fleet()
    const phone = apple({ providers: ['icloudKV', 'googleDrive'], writeMode: 'mirror' })

    await phone.setItem('note', stamped('from-iphone', 1_000))
    await android().setItem('note', stamped('from-android', 2_000))

    expect(textOf(await phone.getItem('note'))).toBe('from-iphone')
  })
})

describe('mixed fleet with a resolver', () => {
  it('Apple sees a newer Android write', async () => {
    const { apple, android } = fleet()
    const phone = apple({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
    })

    await phone.setItem('note', stamped('from-iphone', 1_000))
    await android().setItem('note', stamped('from-android', 2_000))

    expect(textOf(await phone.getItem('note'))).toBe('from-android')
  })

  it('Android sees a newer Apple write', async () => {
    // The other direction, which works because mirror put a copy in Drive.
    const { apple, android } = fleet()
    const phone = apple({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
    })

    await android().setItem('note', stamped('from-android', 1_000))
    await phone.setItem('note', stamped('from-ipad', 2_000))

    expect(textOf(await android().getItem('note'))).toBe('from-ipad')
  })

  it('an older write does not win just because its provider comes first', async () => {
    const { apple, android } = fleet()
    const phone = apple({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
    })

    await android().setItem('note', stamped('newer', 5_000))
    // iCloud is checked first and holds an older copy.
    await phone.setItem('note', stamped('older', 1_000))
    // ...but mirror just overwrote Drive with the older one, so re-seed Drive.
    await android().setItem('note', stamped('newer', 5_000))

    expect(textOf(await phone.getItem('note'))).toBe('newer')
  })

  it('repairs the stale provider so it converges', async () => {
    const { icloudBase, apple, android } = fleet()
    const phone = apple({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
    })

    await phone.setItem('note', stamped('from-iphone', 1_000))
    await android().setItem('note', stamped('from-android', 2_000))

    expect(textOf(icloudBase.dump().note)).toBe('from-iphone')

    await phone.getItem('note')
    // Let the best-effort repair settle.
    await new Promise(r => setTimeout(r, 0))

    // iCloud now carries the winner, so the next read needs no resolution.
    expect(textOf(icloudBase.dump().note)).toBe('from-android')
  })

  it('can be told not to repair', async () => {
    const { icloudBase, apple, android } = fleet()
    const phone = apple({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
      repairOnRead: false,
    })

    await phone.setItem('note', stamped('from-iphone', 1_000))
    await android().setItem('note', stamped('from-android', 2_000))
    await phone.getItem('note')
    await new Promise(r => setTimeout(r, 0))

    expect(textOf(icloudBase.dump().note)).toBe('from-iphone')
  })
})

describe('resolveByTimestamp', () => {
  const resolve = resolveByTimestamp('updatedAt')

  it('picks the highest timestamp regardless of order', () => {
    expect(resolve([
      { provider: 'icloudKV', value: stamped('a', 1) },
      { provider: 'googleDrive', value: stamped('b', 9) },
    ])).toBe(stamped('b', 9))
  })

  it('accepts ISO strings as well as epoch millis', () => {
    const iso = JSON.stringify({ text: 'b', updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(resolve([
      { provider: 'icloudKV', value: stamped('a', 1) },
      { provider: 'googleDrive', value: iso },
    ])).toBe(iso)
  })

  it('prefers a datable value over one it cannot date', () => {
    // A value you cannot date is not evidence against one you can.
    expect(resolve([
      { provider: 'icloudKV', value: 'not json' },
      { provider: 'googleDrive', value: stamped('b', 1) },
    ])).toBe(stamped('b', 1))
  })

  it('falls back to preference order when nothing is datable', () => {
    expect(resolve([
      { provider: 'icloudKV', value: 'plain' },
      { provider: 'googleDrive', value: 'also plain' },
    ])).toBe('plain')
  })

  it('keeps the earlier provider on a tie, so results do not flap', () => {
    expect(resolve([
      { provider: 'icloudKV', value: stamped('a', 5) },
      { provider: 'googleDrive', value: stamped('b', 5) },
    ])).toBe(stamped('a', 5))
  })
})

describe('read repair and providers that failed to answer', () => {
  it('does not overwrite a provider whose read merely failed', async () => {
    // The dangerous case: Drive holds the NEWER copy, but its read blips. The
    // read resolves from the only candidate it could see - iCloud's older copy -
    // and repair used to write that back to every provider it had asked,
    // including the one that never answered. The newer value was destroyed by a
    // transient network error.
    const icloudBase = createMemoryProvider({
      initial: { note: stamped('from-iphone', 1_000) },
    })
    const driveBase = createMemoryProvider({
      initial: { note: stamped('from-android', 5_000) },
      faults: { getItem: { code: 'ERR_NETWORK_UNAVAILABLE' } },
    })

    const phone = createCloudStore({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
    })
    phone.registerProvider({ ...icloudBase, name: 'icloudKV' })
    phone.registerProvider({ ...driveBase, name: 'googleDrive' })

    // The read can only see iCloud, so that is the honest answer.
    expect(textOf(await phone.getItem('note'))).toBe('from-iphone')
    await new Promise(r => setTimeout(r, 0))

    // But Drive must still hold the newer value, so the next successful read
    // resolves to it.
    expect(textOf(driveBase.dump().note)).toBe('from-android')
  })

  it('still repairs providers that answered with a stale value', async () => {
    // The behaviour the guard must not break.
    const icloudBase = createMemoryProvider({
      initial: { note: stamped('from-iphone', 1_000) },
    })
    const driveBase = createMemoryProvider({
      initial: { note: stamped('from-android', 5_000) },
    })

    const phone = createCloudStore({
      providers: ['icloudKV', 'googleDrive'],
      writeMode: 'mirror',
      resolve: resolveByTimestamp('updatedAt'),
    })
    phone.registerProvider({ ...icloudBase, name: 'icloudKV' })
    phone.registerProvider({ ...driveBase, name: 'googleDrive' })

    expect(textOf(await phone.getItem('note'))).toBe('from-android')
    await new Promise(r => setTimeout(r, 0))

    expect(textOf(icloudBase.dump().note)).toBe('from-android')
  })
})
