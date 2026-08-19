import { assets } from '../providers/cloudKit'
import { ErrorCode } from '../errors'

interface Harness {
  setPlatform: (os: string) => void
  reset: () => void
}

const harness = (globalThis as unknown as { __RNCloudSync: Harness }).__RNCloudSync

// The asset API is native-only. These assert it says so loudly rather than
// resolving undefined and looking like it worked - the failure mode this
// package exists to avoid. The provider reads Platform.OS per call, so
// flipping it here is enough; no module reloading needed.
describe('cloudKitAssets on a non-native platform', () => {
  beforeEach(() => harness.setPlatform('android'))
  afterEach(() => harness.reset())

  it('rejects save with ERR_UNSUPPORTED_PLATFORM', async () => {
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_PLATFORM })
  })

  it('rejects fetch with ERR_UNSUPPORTED_PLATFORM', async () => {
    await expect(
      assets.fetch({ recordName: 'a', fieldName: 'image' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED_PLATFORM })
  })

  it('names Google Drive as the alternative, so the message is actionable', async () => {
    await expect(
      assets.save({ recordName: 'a', fieldName: 'image', fileUri: '/tmp/a.png' })
    ).rejects.toThrow(/googleDrive/)
  })

  it('onProgress returns a no-op unsubscribe rather than throwing', () => {
    const unsubscribe = assets.onProgress(() => undefined)
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })
})
