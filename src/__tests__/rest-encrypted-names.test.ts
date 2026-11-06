import { cloudKitEncrypted } from '../providers/cloudKitEncrypted'
import { cloudKit } from '../providers/cloudKit'
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
  harness.setPlatform('ios')
})

describe('cloudKitEncrypted record names', () => {
  it('deleting an encrypted key cannot reach the plain record of the same key', async () => {
    await cloudKit.removeItem('token')
    await cloudKitEncrypted.removeItem('token')

    expect(harness.module.ckDeleteRecord.mock.calls).toEqual([
      ['token', null],
      ['rncs-enc.token', null],
    ])
  })

  it('getAllKeys strips the prefix and skips names outside it', async () => {
    harness.module.ckQueryRecordNames.mockResolvedValueOnce(['rncs-enc.a', 'legacy'])
    await expect(cloudKitEncrypted.getAllKeys()).resolves.toEqual(['a'])
  })

  it('rejects a key too long to carry the prefix', async () => {
    await expect(cloudKitEncrypted.setItem('a'.repeat(250), 'v'))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_KEY })
  })

  it('the plain provider refuses keys in the encrypted namespace', async () => {
    await expect(cloudKit.setItem('rncs-enc.token', 'v'))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_KEY })
    await expect(cloudKit.removeItem('rncs-enc.token'))
      .rejects.toMatchObject({ code: ErrorCode.INVALID_KEY })
    expect(harness.module.ckDeleteRecord).not.toHaveBeenCalled()
  })

  it('the plain provider does not list encrypted record names', async () => {
    harness.module.ckQueryRecordNames.mockResolvedValueOnce(['k', 'rncs-enc.k'])
    await expect(cloudKit.getAllKeys()).resolves.toEqual(['k'])
  })

  it('native multiGetWithMeta returns values without timestamps, in input order', async () => {
    harness.module.ckGetRecord.mockResolvedValueOnce('A').mockResolvedValueOnce(null)
    await expect(cloudKit.multiGetWithMeta!(['a', 'b'])).resolves.toEqual([{ value: 'A' }, null])
  })
})
