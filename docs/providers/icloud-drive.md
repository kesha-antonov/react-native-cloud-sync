# iCloud Drive

Files in the user's own iCloud Drive, in a folder they can open in Files.app.

## When to use it

This is the one thing no `CKRecord` or `CKAsset` API can do, and the most common iCloud request in mobile apps: *put this file where the user can find it.*

A `CKAsset` lives in your app's private CloudKit database. The user cannot see it, open it, share it, or hand it to another app - which is right for an internal backup blob and wrong for an export somebody asked for. A file written here lands in your app's folder in iCloud Drive: visible in Files.app, syncing to every device on the same Apple ID, and surviving the app being deleted.

| You want | Use |
|---|---|
| An export, a report, a document the user asked for | `icloudDocuments` |
| An internal backup the user never sees | [`cloudKitBackup`](cloudkit.md#backuprestore-helper) |
| The same, on Android or web | [`googleDriveFiles`](google-drive.md#large-files) |

Apple platforms only, and unlike the other providers that is not a gap waiting to be filled. There is no REST surface for iCloud Drive and no browser API - it is a filesystem feature. Every call rejects with `ERR_UNSUPPORTED_PLATFORM` elsewhere rather than pretending to work.

## Setup

Two things beyond the CloudKit entitlement, and both matter.

With the config plugin:

```json
{
  "expo": {
    "plugins": [
      ["react-native-cloud-sync", {
        "containerIdentifier": "iCloud.com.your.app",
        "iCloudDocuments": true,
        "documentsFolderName": "My App"
      }]
    ]
  }
}
```

Off by default, because it is the one capability here with a user-visible consequence: turning it on puts a folder for your app in somebody's iCloud Drive. That should be a deliberate choice, not something installing a package does to their Files.app.

Managing `ios/` yourself, the entitlements are:

```xml
<key>com.apple.developer.icloud-services</key>
<array><string>CloudDocuments</string></array>

<key>com.apple.developer.ubiquity-container-identifiers</key>
<array><string>iCloud.com.your.app</string></array>
```

and the Info.plist entry that makes the folder *visible* is:

```xml
<key>NSUbiquitousContainers</key>
<dict>
  <key>iCloud.com.your.app</key>
  <dict>
    <key>NSUbiquitousContainerIsDocumentScopePublic</key><true/>
    <key>NSUbiquitousContainerName</key><string>My App</string>
    <key>NSUbiquitousContainerSupportedFolderLevels</key><string>Any</string>
  </dict>
</dict>
```

Miss the Info.plist half and everything still works - files sync between the user's devices - but the folder never appears in Files.app, which is usually the entire reason you reached for this. The plugin writes both.

> One gotcha Apple does not make obvious: iOS caches `NSUbiquitousContainers` and only re-reads it when the app's **version** changes. Bump `CFBundleShortVersionString` when you add or change it, or the folder stays hidden on a device that already ran the old build.

## Operations

```ts
import { icloudDocuments } from 'react-native-cloud-sync'

if (!(await icloudDocuments.isAvailable()))
  return showSignInPrompt()

await icloudDocuments.save({ fileUri: localPath, name: 'Export 2024.csv' })

const files = await icloudDocuments.list()
// [{ name: 'Export 2024.csv', sizeBytes: 8241, isDownloaded: true, isDownloading: false }]

const path = await icloudDocuments.fetch({ name: 'Export 2024.csv' })
await icloudDocuments.remove('Export 2024.csv')
```

## `save` means "handed to iCloud"

Same distinction as [`icloudKVSync()`](icloud-kv.md#sync-does-not-mean-stored). Once the file is in the container, iOS uploads it in the background whether or not your app is running - so a resolved promise means the system has it, not that the cloud does. There is no API that waits for the upload, and any library claiming otherwise is guessing.

## `fetch` before you read

The step that catches people out. A file in iCloud Drive may exist as a *placeholder* with no local bytes: the user has it, this device does not. Opening that path gives you an empty file rather than an error.

```ts
const entries = await icloudDocuments.list()
const entry = entries.find(e => e.name === wanted)

// On this device it may be a stub. Reading that yields nothing.
if (entry?.isDownloaded === false)
  await icloudDocuments.fetch({ name: wanted })
```

`fetch` asks for the download and waits for it, so calling it unconditionally is fine - it returns immediately for a file that is already local.

Pass `destinationUri` for anything you intend to keep. The system may evict a downloaded copy from the container to reclaim space, turning it back into a placeholder; a copy outside the container is yours:

```ts
const path = await icloudDocuments.fetch({
  name: 'Export 2024.csv',
  destinationUri: `${FileSystem.documentDirectory}export.csv`,
})
```

A `fetch` that runs out of time raises `ERR_TIMEOUT`, which is **not** a failed transfer - iOS keeps downloading in the background. That is why the code is classified as retryable: it means "not yet", so try again shortly rather than telling the user something broke.

## Progress

Not reported byte by byte. Real progress for an iCloud Drive download needs an `NSMetadataQuery`, which needs a live run loop, and these calls deliberately run off the main thread. Poll `list()` and watch `isDownloading` if you need to show something:

```ts
const tick = setInterval(async () => {
  const entry = (await icloudDocuments.list()).find(e => e.name === wanted)
  setDownloading(entry?.isDownloading ?? false)
}, 500)
```

[`cloudKitAssets`](cloudkit.md#assets) *does* report real byte progress, because `CKModifyRecordsOperation` hands it to us. The difference is in the APIs, not in the effort - and saying so is better than emitting a fake number.

## Deleting

`remove` deletes from iCloud, which means from every device and from the user's Files.app. It resolves `false` when the file was already gone, since that is the end state the caller asked for.

The user can also delete these files themselves, from Files.app, at any time - that is what "visible to the user" means. Treat a missing file as normal rather than as corruption.

## Not a `CloudProvider`

`icloudDocuments` is not registerable with `createCloudStore`, and cannot be. The provider contract is keys to string values; this moves files by path. Same reason [`cloudKitAssets`](cloudkit.md#assets) and [`googleDriveFiles`](google-drive.md#large-files) are their own APIs - a `setItem(key, value)` signature cannot express "stream this file from disk".
