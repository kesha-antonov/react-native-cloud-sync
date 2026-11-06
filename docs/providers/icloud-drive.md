# iCloud Drive

Files in the user's own iCloud Drive, in a folder they can open in Files.app.

## When to use it

When the user should be able to find the file: an export, a report, a document they asked for. Files here are visible in Files.app, sync across the user's devices, and survive the app being deleted. A `CKAsset` cannot do this: it lives in the app's private CloudKit database, invisible to the user.

| You want | Use |
|---|---|
| An export, a report, a document the user asked for | `icloudDocuments` |
| An internal backup the user never sees | [`cloudKitBackup`](cloudkit.md#backuprestore-helper) |
| The same, on Android or web | [`googleDriveFiles`](google-drive.md#large-files) |

Apple platforms only, permanently. It is a filesystem feature with no REST or browser API, so every call rejects with `ERR_UNSUPPORTED_PLATFORM` elsewhere.

## Setup

You need two things beyond the CloudKit entitlement. With the config plugin:

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

`iCloudDocuments` is off by default, because it adds a visible folder to the user's iCloud Drive.

If you manage `ios/` yourself, add the entitlements:

```xml
<key>com.apple.developer.icloud-services</key>
<array><string>CloudDocuments</string></array>

<key>com.apple.developer.ubiquity-container-identifiers</key>
<array><string>iCloud.com.your.app</string></array>
```

and the Info.plist entry that makes the folder visible:

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

Without the Info.plist entry, files still sync but the folder never appears in Files.app. The plugin writes both.

Optionally, name the container in Info.plist as `RNCloudSyncDocumentsContainerIdentifier` (the plugin writes it when `iCloudDocuments` is on). Without it, the CloudKit container from `RNCloudSyncContainerIdentifier` is used if declared, else the first ubiquity container in the entitlements. It is a separate key so an app can use iCloud Drive without CloudKit. See [Platform Notes](../PLATFORM_NOTES.md#entitlements).

```xml
<key>RNCloudSyncDocumentsContainerIdentifier</key>
<string>iCloud.com.your.app</string>
```

> iOS caches `NSUbiquitousContainers` and re-reads it only when the app's version changes. Bump `CFBundleShortVersionString` when you add or change it, or the folder stays hidden on devices that ran the old build.

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

## Names

A name is a single file name inside the app's `Documents` folder. These reject with `ERR_INVALID_KEY` before touching the filesystem, so a name cannot escape the folder:

- empty, `.` or `..`
- anything containing `/` or NUL
- the `.x.icloud` form iOS uses for download placeholders

## `save` means "handed to iCloud"

As with [`icloudKVSync()`](icloud-kv.md#sync-does-not-mean-stored), a resolved promise means the system has the file, not the cloud. iOS uploads it in the background, even if your app is not running. No API waits for the upload.

Saving a document onto itself (`save` with the path `fetch` returned and the same `name`) is a no-op, so fetch, edit in place, save is safe.

## `fetch` before you read

A file may exist on this device only as a placeholder with no local bytes. Opening that path gives you an empty file, not an error.

```ts
const entries = await icloudDocuments.list()
const entry = entries.find(e => e.name === wanted)

// On this device it may be a stub. Reading that yields nothing.
if (entry?.isDownloaded === false)
  await icloudDocuments.fetch({ name: wanted })
```

`fetch` requests the download and waits for it. For a file that is already local it returns immediately, so calling it unconditionally is fine.

Pass `destinationUri` for anything you keep. The system may evict a downloaded copy back to a placeholder; a copy outside the container is yours. Missing parent folders are created:

```ts
const path = await icloudDocuments.fetch({
  name: 'Export 2024.csv',
  destinationUri: `${FileSystem.documentDirectory}export.csv`,
})
```

`destinationUri` rules:

- it must name a file; an existing file is replaced, a directory is never deleted (the call rejects)
- a symlink is replaced as a link; its target is left alone
- naming the document's own path is a no-op

Timeouts:

- a timed-out `fetch` rejects with `ERR_TIMEOUT`. The download is not failed: iOS keeps going in the background, so retry shortly instead of reporting an error
- `timeoutMs` defaults to 60000, capped at one hour; `NaN`, a negative number or a non-number throws a `RangeError` before anything starts

## Progress

No byte-level progress: that needs an `NSMetadataQuery` and a live run loop, and these calls run off the main thread. Poll `list()` and watch `isDownloading`:

```ts
const tick = setInterval(async () => {
  const entry = (await icloudDocuments.list()).find(e => e.name === wanted)
  setDownloading(entry?.isDownloading ?? false)
}, 500)
```

[`cloudKitAssets`](cloudkit.md#assets) does report byte progress, because `CKModifyRecordsOperation` provides it.

## Deleting

`remove` deletes from iCloud (every device and Files.app). It resolves `false` when the file was already gone. A file not yet downloaded to this device is removed through its placeholder.

Users can delete these files from Files.app at any time. Treat a missing file as normal, not corruption.

## Not a `CloudProvider`

`icloudDocuments` cannot be registered with `createCloudStore`. The provider contract maps keys to string values; this API moves files by path. [`cloudKitAssets`](cloudkit.md#assets) and [`googleDriveFiles`](google-drive.md#large-files) are separate APIs for the same reason.
