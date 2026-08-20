import {
  type ConfigPlugin,
  withEntitlementsPlist,
  withInfoPlist,
  createRunOncePlugin,
} from '@expo/config-plugins'

const pkg = require('../../package.json') as { name: string; version: string }

export interface CloudSyncPluginOptions {
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
  /**
   * Add the iCloud Documents service, for the `icloudDocuments` provider.
   * Defaults to false.
   *
   * Off by default because it is the one capability here with a user-visible
   * consequence: enabling it puts a folder for this app in the user's iCloud
   * Drive and in Files.app. That should be a deliberate choice, not something
   * installing a package does to somebody's Files.app.
   */
  iCloudDocuments?: boolean
  /**
   * The folder name shown in Files.app when {@link iCloudDocuments} is on.
   * Defaults to the app's display name.
   */
  documentsFolderName?: string
  /**
   * Whether that folder is visible to the user at all. Defaults to true.
   *
   * Set false to sync documents between the user's own devices without showing
   * them in Files.app - the folder still exists, the user just cannot browse
   * it. Rarely what you want; if the files are not for the user, a `CKAsset`
   * is the better home.
   */
  documentsVisibleInFiles?: boolean
}

/**
 * Adds the iCloud entitlements this package needs.
 *
 * Entirely optional: the entitlements are four plist keys, and plenty of
 * projects (including bare workflows with a committed `ios/` directory) prefer
 * to manage that file by hand. The README documents the raw keys for exactly
 * that case - a config plugin should not be the only documented path.
 */
const withCloudSync: ConfigPlugin<CloudSyncPluginOptions | void> = (config, options) => {
  const opts = options ?? {}
  const keyValueStore = opts.keyValueStore ?? true
  const cloudKit = opts.cloudKit ?? true
  const iCloudDocuments = opts.iCloudDocuments ?? false

  const withEntitlements = withEntitlementsPlist(config, (mod) => {
    const bundleId = mod.ios?.bundleIdentifier ?? config.ios?.bundleIdentifier
    const containerIdentifier
      = opts.containerIdentifier ?? (bundleId != null ? `iCloud.${bundleId}` : undefined)

    if (containerIdentifier == null)
      throw new Error(
        '[react-native-cloud-sync] Cannot derive an iCloud container identifier. Set '
        + 'ios.bundleIdentifier in app config, or pass containerIdentifier to the plugin.'
      )

    const entitlements = mod.modResults

    if (cloudKit || iCloudDocuments) {
      // Merge rather than overwrite, for both keys: a project may already
      // declare a second container, or CloudDocuments for an unrelated feature.
      // Assigning the container list outright silently dropped every container
      // the app already had, which breaks that other feature at runtime with no
      // build error to point at.
      const containers = new Set<string>(
        (entitlements['com.apple.developer.icloud-container-identifiers'] as string[] | undefined)
        ?? []
      )
      containers.add(containerIdentifier)
      entitlements['com.apple.developer.icloud-container-identifiers'] = [...containers]

      const services = new Set<string>(
        (entitlements['com.apple.developer.icloud-services'] as string[] | undefined) ?? []
      )
      if (cloudKit) services.add('CloudKit')
      // The `icloudDocuments` provider writes to the ubiquity container's
      // Documents directory, which needs this service. Without it the container
      // URL resolves to nil at runtime and every call fails with
      // ERR_CONTAINER_MISCONFIGURED.
      if (iCloudDocuments) services.add('CloudDocuments')
      entitlements['com.apple.developer.icloud-services'] = [...services]

      if (iCloudDocuments) {
        // Required alongside the service for document-scope access. Merged for
        // the same reason as the list above.
        const ubiquity = new Set<string>(
          (entitlements['com.apple.developer.ubiquity-container-identifiers'] as string[] | undefined)
          ?? []
        )
        ubiquity.add(containerIdentifier)
        entitlements['com.apple.developer.ubiquity-container-identifiers'] = [...ubiquity]
      }
    }

    if (keyValueStore)
      // The token form is what Xcode writes; it resolves at build time and
      // avoids hardcoding the team prefix into source control.
      entitlements['com.apple.developer.ubiquity-kvstore-identifier']
        = '$(TeamIdentifierPrefix)$(CFBundleIdentifier)'

    return mod
  })

  if (!iCloudDocuments) return withEntitlements

  // Entitlements alone get the folder syncing but leave it invisible. Files.app
  // only shows a container that declares `NSUbiquitousContainers` with
  // `NSUbiquitousContainerIsDocumentScopePublic` - which is the whole reason an
  // app reaches for this provider instead of a CKAsset, so writing one without
  // the other would ship a feature that silently does not do its job.
  return withInfoPlist(withEntitlements, (mod) => {
    const bundleId = mod.ios?.bundleIdentifier ?? config.ios?.bundleIdentifier
    const containerIdentifier
      = opts.containerIdentifier ?? (bundleId != null ? `iCloud.${bundleId}` : undefined)
    if (containerIdentifier == null) return mod

    // Merged, not replaced: an app may already declare a second container here
    // for an unrelated document feature, and overwriting the map would break it
    // at runtime with nothing in the build to point at.
    const existing
      = (mod.modResults.NSUbiquitousContainers as Record<string, unknown> | undefined) ?? {}

    const containers: Record<string, unknown> = {
      ...existing,
      [containerIdentifier]: {
        NSUbiquitousContainerIsDocumentScopePublic: opts.documentsVisibleInFiles ?? true,
        NSUbiquitousContainerName:
          opts.documentsFolderName ?? mod.name ?? config.name ?? 'Documents',
        NSUbiquitousContainerSupportedFolderLevels: 'Any',
      },
    }

    // `modResults` is typed as a plist of `JSONValue`, which does not admit an
    // index-signature object even though a nested dictionary is exactly what
    // this key holds.
    mod.modResults.NSUbiquitousContainers = containers as never

    return mod
  })
}

export default createRunOncePlugin(withCloudSync, pkg.name, pkg.version)
