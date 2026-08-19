import { createMemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'

describe('fault injection', () => {
  it('injects a typed failure that callers can branch on', async () => {
    const mem = createMemoryProvider({
      faults: { getItem: { code: ErrorCode.NOT_SIGNED_IN } },
    })
    await expect(mem.getItem('k')).rejects.toMatchObject({ code: ErrorCode.NOT_SIGNED_IN })
  })

  it('can fail a fixed number of times and then succeed', async () => {
    const mem = createMemoryProvider({
      initial: { k: 'v' },
      faults: { getItem: { code: ErrorCode.NETWORK_UNAVAILABLE, times: 2 } },
    })

    await expect(mem.getItem('k')).rejects.toMatchObject({ code: ErrorCode.NETWORK_UNAVAILABLE })
    await expect(mem.getItem('k')).rejects.toMatchObject({ code: ErrorCode.NETWORK_UNAVAILABLE })
    await expect(mem.getItem('k')).resolves.toBe('v')
  })

  it('counts calls so retry logic can be asserted', async () => {
    const mem = createMemoryProvider()
    await mem.setItem('a', '1')
    await mem.setItem('b', '2')
    await mem.getItem('a')

    expect(mem.calls.setItem).toBe(2)
    expect(mem.calls.getItem).toBe(1)
  })
})

describe('account lifecycle', () => {
  it('reports all five account states, not a boolean', async () => {
    const mem = createMemoryProvider({ accountStatus: 'temporarilyUnavailable' })
    // "temporarily unavailable" must be distinguishable from "no account":
    // one means retry silently, the other means prompt the user to sign in.
    await expect(mem.getAccountStatus()).resolves.toBe('temporarilyUnavailable')
  })

  it('delivers an identity-change event, the case that leaks user data', () => {
    // MagisteriaApp stores an anonymous user id in iCloud and never observes
    // NSUbiquityIdentityDidChange, so switching Apple ID silently keeps the
    // previous user's identity. Apps need to see this to clear scoped state.
    const mem = createMemoryProvider()
    const seen: { identityChanged: boolean; status: string }[] = []
    const unsubscribe = mem.onAccountChange?.((e) => {
      seen.push({ identityChanged: e.identityChanged, status: e.status })
    })

    mem.emitAccountChange({ status: 'available', identityChanged: true })

    expect(seen).toEqual([{ identityChanged: true, status: 'available' }])
    unsubscribe?.()
  })

  it('stops delivering after unsubscribe', () => {
    const mem = createMemoryProvider()
    const seen: unknown[] = []
    const unsubscribe = mem.onRemoteChange?.(e => seen.push(e))

    mem.emitRemoteChange({ keys: ['a'] })
    unsubscribe?.()
    mem.emitRemoteChange({ keys: ['b'] })

    expect(seen).toHaveLength(1)
  })
})

describe('remote change events', () => {
  it('carries the typed reason', () => {
    const mem = createMemoryProvider()
    const seen: string[] = []
    mem.onRemoteChange?.(e => seen.push(e.reason))

    mem.emitRemoteChange({ keys: ['k'], reason: 'quotaViolation' })
    mem.emitRemoteChange({ keys: ['k'], reason: 'initialSync' })

    expect(seen).toEqual(['quotaViolation', 'initialSync'])
  })
})
