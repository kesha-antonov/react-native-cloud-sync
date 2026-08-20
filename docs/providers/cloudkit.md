# CloudKit

The user's [private CloudKit database][ckdb] - [records][ckrecord], [custom zones][ckzone] and [binary assets][ckasset]. The only provider here that reaches the *same* data from iOS, Android and the web.

## When to use it

Your app's real data, on Apple platforms, with the option of reaching it elsewhere. Records are bigger than key-value entries (1 MB each rather than 1 MB total) and are queryable.

| | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| Records | native | REST | REST |
| Custom zones | native | – | – |
| Assets (`CKAsset`) | native | – | – |
| Remote change events | native | – | – |
| Auth | implicit | Apple ID sign-in | Apple ID sign-in |

Per-record limit: **1 MB**, excluding assets ([all limits][cklimits]). Oversized writes reject locally with `ERR_PAYLOAD_TOO_LARGE` rather than failing server-side.

## The schema

CloudKit is schema-bound, and the schema is not optional - it is the single most common reason a CloudKit app works in debug and fails the day it ships. This package uses one record type.

| | |
|---|---|
| Record type | `KVBlob` |
| `value` | **String** - holds what `setItem` writes |
| `<fieldName>` | **Asset** - one per `cloudKitAssets` field you use |
| `<fieldName>__size` | **Int(64)** - byte count written alongside each asset |

`cloudKitAssets.save({ recordName: 'avatar', fieldName: 'image' })` therefore needs `image` (Asset) and `image__size` (Int) on `KVBlob`. `cloudKitBackup` defaults to record name `backup` and field name `file`, so it needs `file` and `file__size`. Record *names* are data, not schema - only field names and types have to exist.

The `__size` sidecar is what lets a restore report real progress from the first callback rather than jumping from 0 to 1 at the end.

### Development creates it for you. Production does not.

In the Development environment CloudKit adds fields on first write, so the schema appears by itself while you build. Production never does - it only ever receives what you **Deploy Schema Changes** from the Console. A release build hitting a field that was never deployed fails at runtime on a schema that looked fine all along.

So before your first release: write every field once in Development (or add them by hand), then deploy.

### `getAllKeys()` needs an index

`getItem`, `setItem` and `removeItem` address records by name, which needs no index. `getAllKeys()` is different - it issues a real query (`CKQueryOperation` natively, `/records/query` over REST), and CloudKit refuses to query a record type that has no queryable index.

In the Console, under **Indexes** for `KVBlob`, add:

| Field | Index type |
|---|---|
| `recordName` | **Queryable** |

Then deploy that to Production too. Without it `getAllKeys()` rejects - and because [`migrate()`](../store.md#migration) and the [delete-everything flow](../recipes.md#turning-it-off-and-deleting-what-is-stored) are both built on `getAllKeys()`, they fail with it.

## Setup on Apple platforms

Entitlements only, plus [the schema](#the-schema) above. The container identifier is read from entitlements at runtime, so it never needs repeating in JavaScript and cannot drift out of sync. See [Platform Notes](../PLATFORM_NOTES.md#entitlements).

## Setup on Android and web

Three things in the [CloudKit Console][console] first:

1. A **Client** API token under API Access ([how tokens work][ckauth]). Not a server-to-server key - see [the constraint](#the-constraint-on-android-and-web) below.
2. A **Sign In Callback** set to `cloudkit-<container-id>://callback`.
3. [The schema](#the-schema) and its `recordName` index **deployed to Production**, if you use `environment: 'production'`. Development and Production are separate datastores, so a debug build and a release build do not see each other's data.

Then configure the REST path:

```ts
import { configureCloudKit } from 'react-native-cloud-sync'

configureCloudKit({
  containerIdentifier: 'iCloud.com.your.app',
  apiToken: CLOUDKIT_CLIENT_TOKEN,
  environment: 'production',
  getAuthToken: () => secureStore.get('ckWebAuthToken'),
  onAuthExpired: () => promptAppleSignIn(),
})
```

A Client token only grants what the signed-in user could already do, so it is safe to ship in an app binary. A server-to-server private key is not.

### Getting a `ckWebAuthToken`

1. `GET https://api.apple-cloudkit.com/database/1/<container>/<env>/public/users/caller?ckAPIToken=<token>`
2. That returns **HTTP 421** with a `redirectURL` in a top-level error dict.
3. Load `redirectURL` in a WebView.
4. Intercept navigation to your callback scheme and read `ckWebAuthToken` from the query string.

Intercept at the native page-load level rather than with `onShouldStartLoadWithRequest`, which is not dependable for Android's server-side 302s. A custom `cloudkit-…://` scheme is far more reliably interceptable than an `https` URL.

## Records

```ts
import { cloudKit } from 'react-native-cloud-sync'

await cloudKit.setItem('playlist', JSON.stringify(tracks))

const raw = await cloudKit.getItem('playlist')
// null means no such record. Nothing else returns null.

await cloudKit.removeItem('playlist')

const names = await cloudKit.getAllKeys()
```

Records are stored with the record name as the key, so both platforms fetch by name directly - no query, and no index needed for the three operations above. `getAllKeys()` is the exception: it queries, and so it needs [the `recordName` index](#getallkeys-needs-an-index).

Concurrent writes resolve last-write-wins, identically on native (`.changedKeys`) and over REST (`forceUpdate`), so two devices cannot deadlock on a change-tag conflict.

## Custom zones

Native only; the REST client uses the default zone.

```ts
import { cloudKitZones } from 'react-native-cloud-sync'

await cloudKitZones.create('Projects')
const zones = await cloudKitZones.list()
await cloudKitZones.remove('Projects')
```

## Assets

For anything above the 1 MB record limit - images, audio, exports. The file is streamed from disk as a `CKAsset`, so a large file never has to be held in memory the way a base64 round trip would.

```ts
import { cloudKitAssets } from 'react-native-cloud-sync'

const unsubscribe = cloudKitAssets.onProgress(
  ({ recordName, bytesTransferred, bytesTotal }) => {
    setProgress(bytesTransferred / bytesTotal)
  }
)

await cloudKitAssets.save({
  recordName: 'avatar',
  fieldName: 'image',
  fileUri: localPath,
})

const path = await cloudKitAssets.fetch({
  recordName: 'avatar',
  fieldName: 'image',
})
// null when the record or field does not exist.
```

Progress is reported per record, so it can be attributed when several transfers are in flight.

Assets are an explicit API rather than something the [store facade](../store.md) routes to automatically: you pass a file path, not a string, and there is no way to infer that intent from a `setItem` call.

**Native only.** CloudKit Web Services does expose an asset upload flow, but it is a separate multi-step protocol this package does not implement yet - so on Android and web these reject with `ERR_UNSUPPORTED_PLATFORM` instead of appearing to work. Use `googleDrive` for binaries there.

### Backup/restore helper

`cloudKitBackup` wraps `cloudKitAssets` for the common case of a single named blob - a database export, an archive - with progress reported as a fraction instead of a global, unfiltered event feed:

```ts
import { cloudKitBackup } from 'react-native-cloud-sync'

await cloudKitBackup.save(dbPath, {
  onProgress: ({ fraction }) => setUploadProgress(fraction),
})

const restoredPath = await cloudKitBackup.restore({
  onProgress: ({ fraction }) => setDownloadProgress(fraction),
})
// null when nothing has been backed up yet
```

`save`/`restore` both default to a single well-known record (`recordName: 'backup'`, `fieldName: 'file'`), so most apps never need to pass either - override them to keep more than one backup (e.g. one per exported dataset).

The download side reports real progress from the first callback, not just at completion: `save` stashes the file's byte count alongside the asset, so a subsequent `restore` (even from a different device) knows the total before the transfer starts.

Native only, same as `cloudKitAssets` - on Android and web, use [`googleDriveFiles`](google-drive.md#large-files) instead. [Recipes](../recipes.md#cross-platform-large-file-backup) shows the two paired behind one function.

## Events

```ts
cloudKit.onRemoteChange(({ keys, reason }) => reload(keys))
cloudKit.onAccountChange(({ identityChanged }) => {
  if (identityChanged) clearUserScopedCaches()
})
```

Native only - the REST path has no push channel without APNs. Both are no-ops elsewhere rather than throwing, so the same code runs on every platform.

## The constraint on Android and web

A `ckWebAuthToken` expires after **30 minutes**, or **2 weeks** if the user ticks "Keep me signed in" during sign-in. Apple documents no refresh mechanism.

There is no alternative auth mode:

- A **server-to-server key reaches only the public database.** Apple: *"Use a server-to-server key to access the public database of a container as the developer who created the key."*
- **Sign in with Apple cannot bootstrap it.** Per Apple DTS: *"The unique user identifiers for Sign in with Apple and CloudKit are not linked."*

So the interactive sign-in is not a shortcut this package chose - it is the only mechanism that exists.

Design around it: make CloudKit-on-Android a deliberate import/export, and handle `ERR_AUTH_EXPIRED` by prompting for sign-in rather than retrying. For continuous background sync on Android, use `googleDrive`.

The REST path needs no crypto - two query parameters on a `fetch` - so it is unaffected by the missing-`crypto` problem that stalled earlier CloudKit JS attempts in React Native.

[ckdb]: https://developer.apple.com/documentation/cloudkit/ckdatabase
[ckrecord]: https://developer.apple.com/documentation/cloudkit/ckrecord
[ckzone]: https://developer.apple.com/documentation/cloudkit/ckrecordzone
[ckasset]: https://developer.apple.com/documentation/cloudkit/ckasset
[ckws]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/index.html
[ckauth]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html
[cklimits]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/PropertyMetrics.html
[console]: https://icloud.developer.apple.com/dashboard/

## Batching

Over REST, `/records/lookup` and `/records/modify` both take arrays, so the store's [batch operations](../store.md#batch-operations) really are one request:

```ts
await store.multiGet(['a', 'b', 'c'])     // one request
await store.multiSet(entries)             // one request per 200 records
```

Batched writes use `atomic: false`. A batch is a convenience the caller asked for, not a transaction - one oversized record should not silently discard the other 199. Per-record failures are raised rather than swallowed.

Natively the same calls loop, because `CKModifyRecordsOperation` already coalesces on the framework's own schedule.

## Concurrent writes

The default is last-write-wins, on both platforms: the native provider uses `savePolicy = .changedKeys` and the REST client uses `forceUpdate`, so two devices writing the same record agree on the outcome rather than one of them failing on a change-tag mismatch.

That is right for the common case and wrong when a genuine concurrent edit should be merged instead of destroyed. The REST client can do a conditional write:

```ts
import { configureCloudKit, isCloudSyncError } from 'react-native-cloud-sync'

const client = getCloudKitClient()                       // internal, but see below
const current = await client.getRecordWithMeta('doc')

try {
  await client.saveRecordIfUnchanged('doc', merged, current.recordChangeTag)
} catch (e) {
  if (isCloudSyncError(e) && e.code === 'ERR_CONFLICT')
    await retryWith(e.serverValue)                       // somebody else got there first
}
```

`ERR_CONFLICT` carries `serverValue` precisely so this loop can merge. Before conditional writes existed the error could not fire at all, which made the documented merge path unreachable.

## Cancelling a transfer

```ts
const cancelled = await cloudKitAssets.cancel({ recordName: 'avatar', fieldName: 'image' })
await cloudKitBackup.cancel()                            // the default backup record
```

Identified by record and field rather than by a handle, because that is the pair `onProgress` already reports - a UI showing progress therefore already has what it needs to stop it. The cancelled `save`/`fetch`/`restore` rejects with `ERR_CANCELLED`, which `isCancelled(e)` recognises and which you should not show as an error.

Native only, like the rest of the asset API.
