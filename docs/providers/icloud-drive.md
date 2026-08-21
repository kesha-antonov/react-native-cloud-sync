# iCloud Drive

Files in the user's own iCloud Drive, in a folder they can open in Files.app.

## When to use it

The one thing no `CKRecord`/`CKAsset` API can do, and the most common iCloud request in mobile apps: *put this file where the user can find it.*

A `CKAsset` lives in the app's private CloudKit database, invisible and unshareable - right for an internal backup, wrong for an export somebody asked for. A file written here instead lands in the app's iCloud Drive folder: visible in Files.app, synced across the user's devices, surviving the app being deleted.

| You want | Use |
|---|---|
| An export, a report, a document the user asked for | `icloudDocuments` |
| An internal backup the user never sees | [`cloudKitBackup`](cloudkit.md#backuprestore-helper) |
| The same, on Android or web | [`googleDriveFiles`](google-drive.md#large-files) |

Apple platforms only, and not a gap waiting to be filled: a filesystem feature with no REST surface or browser API, so every call rejects with `ERR_UNSUPPORTED_PLATFORM` elsewhere rather than pretending to work.

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

Off by default - the one capability here with a user-visible consequence, since it puts a folder for your app in somebody's iCloud Drive. That should be deliberate, not something installing a package does to their Files.app.

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

Miss the Info.plist half and files still sync, but the folder never appears in Files.app - usually the whole reason you reached for this. The plugin writes both.

> One gotcha Apple doesn't make obvious: iOS caches `NSUbiquitousContainers`, re-reading it only when the app's **version** changes. Bump `CFBundleShortVersionString` when you add or change it, or the folder stays hidden on a device that already ran the old build.

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

Same distinction as [`icloudKVSync()`](icloud-kv.md#sync-does-not-mean-stored): iOS uploads the file in the background once it's in the container, whether or not your app is running - a resolved promise means the system has it, not the cloud, and no API waits for the actual upload.

## `fetch` before you read

The step that catches people out: a file may exist only as a *placeholder* with no local bytes - the user has it, this device doesn't. Opening that path gives you an empty file, not an error.

```ts
const entries = await icloudDocuments.list()
const entry = entries.find(e => e.name === wanted)

// On this device it may be a stub. Reading that yields nothing.
if (entry?.isDownloaded === false)
  await icloudDocuments.fetch({ name: wanted })
```

`fetch` asks for the download and waits for it, so calling it unconditionally is fine - immediate return for a file that's already local.

Pass `destinationUri` for anything you intend to keep - the system may evict a downloaded copy to reclaim space, turning it back into a placeholder, but a copy outside the container is yours:

```ts
const path = await icloudDocuments.fetch({
  name: 'Export 2024.csv',
  destinationUri: `${FileSystem.documentDirectory}export.csv`,
})
```

A `fetch` that times out raises `ERR_TIMEOUT` - **not** a failed transfer, since iOS keeps downloading in the background, and the retryable classification means "not yet": try again shortly rather than telling the user something broke.

## Progress

Not reported byte by byte: real progress needs an `NSMetadataQuery` and a live run loop, and these calls deliberately run off the main thread. Poll `list()` and watch `isDownloading` instead:

```ts
const tick = setInterval(async () => {
  const entry = (await icloudDocuments.list()).find(e => e.name === wanted)
  setDownloading(entry?.isDownloading ?? false)
}, 500)
```

[`cloudKitAssets`](cloudkit.md#assets) *does* report real byte progress - `CKModifyRecordsOperation` hands it to us; the difference is in the APIs, not the effort.

## Deleting

`remove` deletes from iCloud (every device, and Files.app) and resolves `false` when the file was already gone - the end state the caller asked for.

The user can delete these files themselves from Files.app at any time - that's what "visible" means, so treat a missing file as normal, not corruption.

## Not a `CloudProvider`

`icloudDocuments` can't register with `createCloudStore`: the provider contract is keys to string values, this moves files by path - same reason [`cloudKitAssets`](cloudkit.md#assets)/[`googleDriveFiles`](google-drive.md#large-files) are their own APIs, since `setItem(key, value)` can't express "stream this file from disk".
