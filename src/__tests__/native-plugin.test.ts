// Required rather than imported: the plugin is outside this package's TS
// `rootDir`, and a static import pulls it into the typecheck of `src/`.
type CloudSyncPlugin = (config: Record<string, unknown>, options: unknown) => unknown
// eslint-disable-next-line @typescript-eslint/no-require-imports
const withCloudSync = (require('../../plugin/src') as { default: CloudSyncPlugin }).default

type Mod = (c: Record<string, unknown>) => Promise<{ modResults: Record<string, unknown> }>

async function runMod(
  options: Record<string, unknown>,
  kind: 'infoPlist' | 'entitlements'
): Promise<Record<string, unknown> | undefined> {
  const config = withCloudSync(
    { name: 'App', slug: 'app', ios: { bundleIdentifier: 'com.example.app' } },
    options
  ) as { mods?: { ios?: Record<string, Mod> } }
  const mod = config.mods?.ios?.[kind]
  if (mod == null) return undefined
  const out = await mod({
    ...config,
    modResults: {},
    modRequest: { platform: 'ios', modName: kind, projectRoot: '/', platformProjectRoot: '/ios', introspect: true },
  })
  return out.modResults
}

describe('config plugin', () => {
  it('hands a custom container identifier to native code through Info.plist', async () => {
    const plist = await runMod({ containerIdentifier: 'iCloud.com.example.shared' }, 'infoPlist')
    expect(plist?.RNCloudSyncContainerIdentifier).toBe('iCloud.com.example.shared')
    // Documents are off by default, so no Files.app folder.
    expect(plist?.NSUbiquitousContainers).toBeUndefined()
  })

  it('writes the same identifier to the entitlements', async () => {
    const ent = await runMod({ containerIdentifier: 'iCloud.com.example.shared' }, 'entitlements')
    expect(ent?.['com.apple.developer.icloud-container-identifiers']).toEqual([
      'iCloud.com.example.shared',
    ])
  })

  it('still declares NSUbiquitousContainers when documents are on', async () => {
    const plist = await runMod({ iCloudDocuments: true }, 'infoPlist')
    expect(plist?.RNCloudSyncContainerIdentifier).toBe('iCloud.com.example.app')
    expect(plist?.NSUbiquitousContainers).toHaveProperty(['iCloud.com.example.app'])
  })

  it('declares only the documents container when CloudKit is off', async () => {
    // Native code builds a CKContainer from RNCloudSyncContainerIdentifier, and
    // doing that without the CloudKit service traps inside CloudKit.
    const plist = await runMod({ cloudKit: false, iCloudDocuments: true }, 'infoPlist')
    expect(plist?.RNCloudSyncContainerIdentifier).toBeUndefined()
    expect(plist?.RNCloudSyncDocumentsContainerIdentifier).toBe('iCloud.com.example.app')
  })

  it('leaves Info.plist alone for a key-value-store-only setup', async () => {
    const plist = await runMod({ cloudKit: false }, 'infoPlist')
    expect(plist?.RNCloudSyncContainerIdentifier).toBeUndefined()
  })
})
