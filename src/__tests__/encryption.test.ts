import { cloudKitEncrypted } from '../providers/cloudKitEncrypted'
import { cloudKit } from '../providers/cloudKit'
import { createCloudStore } from '../store'
import { createMemoryProvider } from '../providers/memory'
import { ErrorCode } from '../errors'

const harness = (global as unknown as {
  __RNCloudSync: {
    module: Record<string, jest.Mock>
    setPlatform: (os: string) => void
    reset: () => void
  }
}).__RNCloudSync

beforeEach(() => {
  harness.reset()
})

describe('cloudKitEncrypted on Apple platforms', () => {
  beforeEach(() => {
    harness.setPlatform('ios')
  })

  it('writes through CloudKit\'s encrypted field, not the plain one', async () => {
    await cloudKitEncrypted.setItem('token', 'sensitive')

    // The final argument is what routes the value into
    // `CKRecord.encryptedValues`, where Apple cannot read it.
    expect(harness.module.ckSaveRecord).toHaveBeenCalledWith(
      'EncryptedKVBlob', 'token', 'sensitive', null, true
    )
  })

  it('reads from the encrypted side too', async () => {
    harness.module.ckGetRecord.mockResolvedValueOnce('sensitive')
    await expect(cloudKitEncrypted.getItem('token')).resolves.toBe('sensitive')

    // Reading the plain side of an encrypted field returns null, which is
    // indistinguishable from a missing record - so the flag has to match.
    expect(harness.module.ckGetRecord).toHaveBeenCalledWith(
      'EncryptedKVBlob', 'token', null, true
    )
  })

  it('uses its own record type, so it cannot collide with cloudKit\'s schema', async () => {
    await cloudKit.setItem('k', 'plain')
    await cloudKitEncrypted.setItem('k', 'secret')

    const types = harness.module.ckSaveRecord.mock.calls.map(
      (call: unknown[]) => call[0] as string
    )
    // A field is encrypted or plain in the CloudKit *schema*, so sharing a
    // record type would be a field-type conflict the server rejects.
    expect(types).toEqual(['KVBlob', 'EncryptedKVBlob'])
  })

  it('leaves the plain provider unencrypted', async () => {
    await cloudKit.setItem('k', 'plain')
    expect(harness.module.ckSaveRecord).toHaveBeenCalledWith('KVBlob', 'k', 'plain', null, false)
  })

  it('lists keys, because record names are not encrypted', async () => {
    harness.module.ckQueryRecordNames.mockResolvedValueOnce(['a', 'b'])
    await expect(cloudKitEncrypted.getAllKeys()).resolves.toEqual(['a', 'b'])
    expect(harness.module.ckQueryRecordNames).toHaveBeenCalledWith('EncryptedKVBlob', null)
  })
})

describe('cloudKitEncrypted off Apple platforms', () => {
  beforeEach(() => {
    harness.setPlatform('android')
  })

  it('reports unavailable rather than throwing, so callers can branch', async () => {
    await expect(cloudKitEncrypted.isAvailable()).resolves.toBe(false)
  })

  it('rejects a read with ERR_UNSUPPORTED_PLATFORM', async () => {
    await expect(cloudKitEncrypted.getItem('token')).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PLATFORM,
    })
  })

  it('explains why it can never work here, and what to use instead', async () => {
    // The constraint is the point of end-to-end encryption, not a missing
    // feature - so the message has to say so rather than read like a TODO.
    const error = await cloudKitEncrypted.setItem('token', 'v').catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('codec')
    expect((error as Error).message).toContain('iCloud Keychain')
  })

  it('is skipped by the store rather than failing the whole write', async () => {
    const fallback = createMemoryProvider({ name: 'memory' })
    const store = createCloudStore({
      providers: ['cloudKitEncrypted', 'memory'],
      availabilityTtlMs: 0,
    })
    store.registerProvider(fallback)

    // `isAvailable` answering false is what keeps an Apple-only provider from
    // breaking an Android build that lists it.
    await store.setItem('k', 'v')
    expect(fallback.dump()).toEqual({ k: 'v' })
  })
})

describe('the codec seam, for encryption that crosses platforms', () => {
  /**
   * Stands in for a real cipher. What matters here is the shape: the provider
   * only ever sees ciphertext, and the app only ever sees plaintext.
   */
  function reversibleCodec(calls: string[]) {
    return {
      encode: (value: string, key: string) => {
        calls.push(`encode:${key}`)
        return `enc(${value})`
      },
      decode: (value: string, key: string) => {
        calls.push(`decode:${key}`)
        return value.replace(/^enc\((.*)\)$/, '$1')
      },
    }
  }

  it('never lets plaintext reach the provider', async () => {
    const calls: string[] = []
    const mem = createMemoryProvider()
    const store = createCloudStore({
      providers: ['memory'],
      codec: reversibleCodec(calls),
      availabilityTtlMs: 0,
    })
    store.registerProvider(mem)

    await store.setItem('secret', 'plaintext')

    expect(mem.dump()).toEqual({ secret: 'enc(plaintext)' })
    await expect(store.getItem('secret')).resolves.toBe('plaintext')
    expect(calls).toEqual(['encode:secret', 'decode:secret'])
  })

  it('passes the key to the codec, so it can derive a per-key nonce', async () => {
    const calls: string[] = []
    const mem = createMemoryProvider()
    const store = createCloudStore({
      providers: ['memory'],
      codec: reversibleCodec(calls),
      availabilityTtlMs: 0,
    })
    store.registerProvider(mem)

    await store.setItem('a', '1')
    await store.setItem('b', '2')

    expect(calls).toEqual(['encode:a', 'encode:b'])
  })

  it('leaves keys in the clear, because getAllKeys has to keep working', async () => {
    const mem = createMemoryProvider()
    const store = createCloudStore({
      providers: ['memory'],
      codec: reversibleCodec([]),
      availabilityTtlMs: 0,
    })
    store.registerProvider(mem)

    await store.setItem('settings.theme', 'dark')

    // Encrypting keys would make listing, tiering and read repair impossible -
    // so keys are a documented part of the threat model, not an oversight.
    await expect(store.getAllKeys()).resolves.toEqual(['settings.theme'])
  })

  it('queues ciphertext, so a persisted outbox never holds plaintext', async () => {
    const mem = createMemoryProvider({
      faults: { setItem: { code: ErrorCode.NETWORK_UNAVAILABLE } },
    })
    const map = new Map<string, string>()
    const store = createCloudStore({
      providers: ['memory'],
      codec: reversibleCodec([]),
      availabilityTtlMs: 0,
      outboxStorage: {
        getString: k => map.get(k),
        set: (k, v) => { map.set(k, v) },
      },
    })
    store.registerProvider(mem)

    await store.setItem('secret', 'plaintext')

    const raw = map.get('rncs.outbox.v1') ?? ''
    expect(raw).toContain('enc(plaintext)')
    expect(raw).not.toContain('"plaintext"')
  })

  it('supports an async codec, which every real crypto library is', async () => {
    const mem = createMemoryProvider()
    const store = createCloudStore({
      providers: ['memory'],
      availabilityTtlMs: 0,
      codec: {
        encode: value => Promise.resolve(`async(${value})`),
        decode: value => Promise.resolve(value.replace(/^async\((.*)\)$/, '$1')),
      },
    })
    store.registerProvider(mem)

    await store.setItem('k', 'v')
    expect(mem.dump()).toEqual({ k: 'async(v)' })
    await expect(store.getItem('k')).resolves.toBe('v')
  })

  it('surfaces a decode failure instead of returning corrupt plaintext', async () => {
    const mem = createMemoryProvider({ initial: { k: 'not-really-ciphertext' } })
    const store = createCloudStore({
      providers: ['memory'],
      availabilityTtlMs: 0,
      codec: {
        encode: value => value,
        decode: () => {
          throw new Error('authentication tag mismatch')
        },
      },
    })
    store.registerProvider(mem)

    // A wrong key or tampered payload must not read as a successful decode.
    await expect(store.getItem('k')).rejects.toMatchObject({ code: ErrorCode.UNKNOWN })
  })
})
