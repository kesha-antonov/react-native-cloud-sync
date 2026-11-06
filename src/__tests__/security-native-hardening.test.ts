import { readFileSync } from 'fs'
import { join } from 'path'

import { icloudDocuments } from '../providers/icloudDocuments'

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

// Required rather than imported: the plugin is outside this package's TS
// `rootDir`, and a static import pulls it into the typecheck of `src/`.
type CloudSyncPlugin = (config: Record<string, unknown>, options: unknown) => unknown
// eslint-disable-next-line @typescript-eslint/no-require-imports
const withCloudSync = (require('../../plugin/src') as { default: CloudSyncPlugin }).default

type Mod = (c: Record<string, unknown>) => Promise<{ modResults: Record<string, unknown> }>

async function runEntitlements(
  options: Record<string, unknown>,
  bundleIdentifier = 'com.example.app'
): Promise<Record<string, unknown>> {
  const config = withCloudSync(
    { name: 'App', slug: 'app', ios: { bundleIdentifier } },
    options
  ) as { mods: { ios: Record<string, Mod> } }
  const out = await config.mods.ios.entitlements({
    ...config,
    modResults: {},
    modRequest: {
      platform: 'ios',
      modName: 'entitlements',
      projectRoot: '/',
      platformProjectRoot: '/ios',
      introspect: true,
    },
  })
  return out.modResults
}

describe('config plugin container identifier', () => {
  it.each([
    'iCloud.*',
    'iCloud.com.example.*',
    '$(TeamIdentifierPrefix)com.example.app',
    'com.example.app',
    'iCloud.',
    'iCloud.com..app',
    'iCloud.com.example.app\n<key>x</key>',
  ])('rejects %j instead of writing it into the entitlements', async (containerIdentifier) => {
    await expect(runEntitlements({ containerIdentifier })).rejects.toThrow(
      /Invalid iCloud container identifier/
    )
  })

  it('accepts ordinary identifiers, explicit or derived from the bundle id', async () => {
    const explicit = await runEntitlements({ containerIdentifier: 'iCloud.com.example-co.my_app' })
    expect(explicit['com.apple.developer.icloud-container-identifiers']).toEqual([
      'iCloud.com.example-co.my_app',
    ])
    const derived = await runEntitlements({})
    expect(derived['com.apple.developer.icloud-container-identifiers']).toEqual([
      'iCloud.com.example.app',
    ])
  })
})

describe('icloudDocuments.fetch timeout', () => {
  it.each([Number.NaN, -1, '1000' as unknown as number])(
    'rejects %p before reaching native code',
    async (timeoutMs) => {
      await expect(icloudDocuments.fetch({ name: 'a.json', timeoutMs })).rejects.toThrow(RangeError)
      expect(rn.module.docFetch).not.toHaveBeenCalled()
    }
  )

  it('passes valid timeouts through, including Infinity (clamped natively)', async () => {
    await icloudDocuments.fetch({ name: 'a.json', timeoutMs: 0 })
    await icloudDocuments.fetch({ name: 'a.json', timeoutMs: Number.POSITIVE_INFINITY })
    await icloudDocuments.fetch({ name: 'a.json' })
    expect(rn.module.docFetch.mock.calls.map((c: unknown[]) => c[2])).toEqual([
      0,
      Number.POSITIVE_INFINITY,
      60_000,
    ])
  })
})

// Source-level guards for native and CI invariants that cannot run under Jest.
// The Swift behaviour itself is exercised on a Mac; these keep the fixes from
// being quietly reverted.
const root = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('native source invariants', () => {
  const swift = read('ios/CloudSyncImpl.swift')

  it('never builds the default asset path from the record name', () => {
    expect(swift).not.toMatch(/appendingPathComponent\("rncs-\\\(recordName\)/)
    expect(swift).toMatch(/SHA256\.hash/)
  })

  it('validates CloudKit identifiers before they reach CloudKit initialisers', () => {
    for (const fn of ['validateRecordType', 'validateRecordName', 'validateZoneName', 'validateFieldName'])
      expect(swift).toContain(`static func ${fn}(`)
    // Every record ID goes through the validating helper.
    expect(swift).not.toMatch(/(?<!try )recordID\(recordName, zoneName\)/)
  })

  it('checks the record type on reads', () => {
    expect(swift).toMatch(/record\.recordType != recordType/)
  })
})

describe('release workflow', () => {
  const release = read('.github/workflows/release.yml')
  const [buildJob, publishJob] = release.split(/\n {2}publish:\n/)

  it('keeps install and build scripts away from the OIDC token', () => {
    expect(buildJob).not.toMatch(/^\s+id-token:\s*write/m)
    expect(publishJob).toMatch(/^\s+id-token:\s*write/m)
    expect(publishJob).not.toMatch(/yarn install|npm ci|actions\/checkout/)
  })

  it('does not restore the shared Actions cache into the publishing pipeline', () => {
    expect(release).not.toMatch(/^\s+cache:\s*yarn/m)
  })
})
