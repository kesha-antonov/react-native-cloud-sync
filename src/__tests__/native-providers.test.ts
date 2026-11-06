import { ErrorCode } from '../errors'
import { icloudDocuments } from '../providers/icloudDocuments'
import { icloudKV } from '../providers/icloudKV'
import { icloudKV as icloudKVWeb } from '../providers/icloudKV.web'

const rn = (global as unknown as {
  __RNCloudSync: {
    module: Record<string, jest.Mock>
    setPlatform: (os: string) => void
    reset: () => void
  }
}).__RNCloudSync

afterEach(() => {
  rn.reset()
})

describe('icloudKV account status', () => {
  it('asks the key-value store, never CloudKit', async () => {
    rn.module.kvGetAccountStatus.mockResolvedValue('noAccount')

    await expect(icloudKV.getAccountStatus()).resolves.toBe('noAccount')
    await expect(icloudKV.isAvailable()).resolves.toBe(false)
    // getAccountStatus/isAvailable construct a CKContainer natively, which
    // raises in an app with only the key-value-store entitlement.
    expect(rn.module.getAccountStatus).not.toHaveBeenCalled()
    expect(rn.module.isAvailable).not.toHaveBeenCalled()
  })

  it('reports available when an iCloud identity is present', async () => {
    rn.module.kvGetAccountStatus.mockResolvedValue('available')
    await expect(icloudKV.isAvailable()).resolves.toBe(true)
  })
})

describe('icloudKV off Apple platforms matches the .web build', () => {
  it.each(['android', 'web'])('%s: status resolves, data calls reject', async (os) => {
    rn.setPlatform(os)

    await expect(icloudKV.getAccountStatus()).resolves.toBe('couldNotDetermine')
    await expect(icloudKVWeb.getAccountStatus()).resolves.toBe('couldNotDetermine')
    await expect(icloudKV.isAvailable()).resolves.toBe(false)
    await expect(icloudKVWeb.isAvailable()).resolves.toBe(false)

    await expect(icloudKV.getItem('k')).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PLATFORM,
    })
    // A rejected promise on both builds, never a synchronous throw.
    await expect(icloudKVWeb.getItem('k')).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PLATFORM,
    })
    await expect(icloudKVWeb.setItem('k', 'v')).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PLATFORM,
    })
  })
})

describe('icloudDocuments name validation', () => {
  const bad = ['', '.', '..', 'a/b', '../escape', 'nul\0name', '.Report.pdf.icloud']

  it.each(bad)('rejects %j before reaching native code', async (name) => {
    await expect(icloudDocuments.save({ fileUri: 'file:///tmp/x', name })).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
    await expect(icloudDocuments.fetch({ name })).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
    await expect(icloudDocuments.remove(name)).rejects.toMatchObject({
      code: ErrorCode.INVALID_KEY,
    })
    expect(rn.module.docSave).not.toHaveBeenCalled()
    expect(rn.module.docFetch).not.toHaveBeenCalled()
    expect(rn.module.docRemove).not.toHaveBeenCalled()
  })

  it('accepts an ordinary name, including one with dots in it', async () => {
    rn.module.docRemove.mockResolvedValue(true)
    await expect(icloudDocuments.remove('backup..v2.json')).resolves.toBe(true)
    expect(rn.module.docRemove).toHaveBeenCalledWith('backup..v2.json')
  })
})
