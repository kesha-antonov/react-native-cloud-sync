import {
  type ConfigPlugin,
  withEntitlementsPlist,
  createRunOncePlugin,
} from '@expo/config-plugins'

const pkg = require('../../package.json') as { name: string; version: string }

export interface CloudStoragePluginOptions {
  /**
   * The iCloud container identifier, e.g. `iCloud.com.example.app`.
   * Defaults to `iCloud.<your bundle identifier>`, which is the convention
   * Xcode itself proposes when you add the capability.
   */
  containerIdentifier?: string
  /**
   * Add the key-value store entitlement. Needed for the `icloudKV` provider.
   * Defaults to true.
   */
  keyValueStore?: boolean
  /**
   * Add the CloudKit service entitlement. Needed for the `cloudKit` provider.
   * Defaults to true.
   */
  cloudKit?: boolean
}

/**
 * Adds the iCloud entitlements this package needs.
 *
 * Entirely optional: the entitlements are four plist keys, and plenty of
 * projects (including bare workflows with a committed `ios/` directory) prefer
 * to manage that file by hand. The README documents the raw keys for exactly
 * that case - a config plugin should not be the only documented path.
 */
const withCloudStorage: ConfigPlugin<CloudStoragePluginOptions | void> = (config, options) => {
  const opts = options ?? {}
  const keyValueStore = opts.keyValueStore ?? true
  const cloudKit = opts.cloudKit ?? true

  return withEntitlementsPlist(config, (mod) => {
    const bundleId = mod.ios?.bundleIdentifier ?? config.ios?.bundleIdentifier
    const containerIdentifier
      = opts.containerIdentifier ?? (bundleId != null ? `iCloud.${bundleId}` : undefined)

    if (containerIdentifier == null)
      throw new Error(
        '[react-native-cloud-storage] Cannot derive an iCloud container identifier. Set '
        + 'ios.bundleIdentifier in app config, or pass containerIdentifier to the plugin.'
      )

    const entitlements = mod.modResults

    if (cloudKit) {
      entitlements['com.apple.developer.icloud-container-identifiers'] = [containerIdentifier]
      // Merge rather than overwrite: a project may already declare
      // CloudDocuments for an unrelated feature.
      const services = new Set<string>(
        (entitlements['com.apple.developer.icloud-services'] as string[] | undefined) ?? []
      )
      services.add('CloudKit')
      entitlements['com.apple.developer.icloud-services'] = [...services]
    }

    if (keyValueStore)
      // The token form is what Xcode writes; it resolves at build time and
      // avoids hardcoding the team prefix into source control.
      entitlements['com.apple.developer.ubiquity-kvstore-identifier']
        = '$(TeamIdentifierPrefix)$(CFBundleIdentifier)'

    return mod
  })
}

export default createRunOncePlugin(withCloudStorage, pkg.name, pkg.version)
