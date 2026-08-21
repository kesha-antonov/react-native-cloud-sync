# CloudKit

The user's [private CloudKit database][ckdb] - [records][ckrecord], [custom zones][ckzone], [binary assets][ckasset]. The only provider here reaching the *same* data from iOS, Android and the web.

## When to use it

Your app's real data on Apple platforms, with the option of reaching it elsewhere - records are bigger than key-value entries (1 MB each, not 1 MB total) and queryable.

| | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| Records | native | REST | REST |
| Custom zones | native | – | – |
| Assets (`CKAsset`) | native | REST (15 MB cap) | REST (15 MB cap) |
| Remote change events | native | – | – |
| Auth | implicit | Apple ID sign-in | Apple ID sign-in |

Per-record limit: **1 MB**, excluding assets ([all limits][cklimits]). Oversized writes reject locally with `ERR_PAYLOAD_TOO_LARGE` rather than failing server-side.

## The schema

CloudKit is schema-bound and the schema isn't optional - the single most common reason a CloudKit app works in debug and fails the day it ships. This package uses one record type.

| | |
|---|---|
| Record type | `KVBlob` |
| `value` | **String** - holds what `setItem` writes |
| `<fieldName>` | **Asset** - one per `cloudKitAssets` field you use |
| `<fieldName>__size` | **Int(64)** - byte count written alongside each asset |

`cloudKitAssets.save({ recordName: 'avatar', fieldName: 'image' })` therefore needs `image` (Asset) and `image__size` (Int) on `KVBlob`; `cloudKitBackup` defaults to `backup`/`file`, needing `file`/`file__size`. Record *names* are data, not schema - only field names and types must exist.

The `__size` sidecar is what lets a restore report real progress from the first callback rather than jumping from 0 to 1 at the end.

### Development creates it for you. Production does not.

Development adds fields on first write, so the schema appears by itself while you build; Production only gets what you **Deploy Schema Changes** from the Console, so a release build hitting an undeployed field fails at runtime on a schema that looked fine all along. Before your first release: write every field once in Development (or by hand), then deploy.

### `getAllKeys()` needs an index

`getItem`, `setItem` and `removeItem` address records by name, needing no index - `getAllKeys()` differs, issuing a real query (`CKQueryOperation` natively, `/records/query` over REST), and CloudKit refuses to query a record type with no queryable index.

In the Console, under **Indexes** for `KVBlob`, add:

| Field | Index type |
|---|---|
| `recordName` | **Queryable** |

Deploy that to Production too - without it `getAllKeys()` rejects, and since [`migrate()`](../store.md#migration) and the [delete-everything flow](../recipes.md#turning-it-off-and-deleting-what-is-stored) are both built on it, they fail too.

## Setup on Apple platforms

Entitlements only, plus [the schema](#the-schema) above - the container identifier is read from entitlements at runtime, so it never needs repeating in JavaScript and can't drift out of sync. See [Platform Notes](../PLATFORM_NOTES.md#entitlements).

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

A Client token only grants what the signed-in user could already do, so it's safe to ship in an app binary - a server-to-server private key isn't.

### Getting a `ckWebAuthToken`

1. `GET https://api.apple-cloudkit.com/database/1/<container>/<env>/public/users/current?ckAPIToken=<token>`
2. That returns **HTTP 421** with a `redirectURL` in a top-level error dict.
3. Load `redirectURL` in a WebView.
4. Intercept navigation to your callback scheme and read `ckWebAuthToken` from the query string.

Intercept at the native page-load level, not with `onShouldStartLoadWithRequest` - it's undependable for Android's server-side 302s. A custom `cloudkit-…://` scheme is far more reliably interceptable than an `https` URL.

## Records

```ts
import { cloudKit } from 'react-native-cloud-sync'

await cloudKit.setItem('playlist', JSON.stringify(tracks))

const raw = await cloudKit.getItem('playlist')
// null means no such record. Nothing else returns null.

await cloudKit.removeItem('playlist')

const names = await cloudKit.getAllKeys()
```

Records are stored with the record name as the key, so both platforms fetch by name directly (no query, no index needed) except `getAllKeys()`, which queries and needs [the `recordName` index](#getallkeys-needs-an-index).

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

For anything above the 1 MB record limit - images, audio, exports - streamed from disk natively as a `CKAsset`, so a large file never has to be held in memory the way a base64 round trip would.

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
  destinationUri: `${documentsDir}/avatar.png`, // required on Android/web, see below
})
// null when the record or field does not exist.
```

Progress is reported per record, so it can be attributed when several transfers are in flight.

Assets are an explicit API, not something the [store facade](../store.md) routes to automatically - you pass a file path, not a string.

### On Android and web

`save`/`fetch` go through CloudKit Web Services' own asset-upload protocol - request a single-use upload URL, POST the bytes, attach the returned descriptor to the record. Three things follow:

- **15 MB per asset, hard limit** - CloudKit Web Services' own ceiling, narrower than the general 50 MB `CKAsset` limit and unrelated to the 1 MB *record* limit above. Oversized files reject locally with `ERR_PAYLOAD_TOO_LARGE`; use [`googleDriveFiles`](google-drive.md#large-files) for anything bigger on Android/web.
- **Needs a file adapter.** Reads/writes the local file through the same `GoogleDriveFileAdapter` contract [`googleDriveFiles`](google-drive.md#large-files) uses - one `configureGoogleDriveFiles(adapter)` call covers both, even without touching `googleDrive`.
- **`destinationUri` is required on `fetch`.** Natively, omitting it falls back to the app's temporary directory; REST has no such directory to reach without a native module, so it rejects with `ERR_UNSUPPORTED_PLATFORM` instead of guessing a path.

Two things stay native-only, both rejecting `ERR_UNSUPPORTED_PLATFORM`: a custom `zoneName` ([no REST zone support](#custom-zones)), and `cancel()`, which resolves `false` since a REST transfer has no in-flight handle to stop yet.

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

Same platform behavior as `cloudKitAssets` above, including the 15 MB cap on Android/web - a database export near that size needs [`googleDriveFiles`](google-drive.md#large-files) instead, and `restore()` without `destinationUri` needs a native module. [Recipes](../recipes.md#cross-platform-large-file-backup) pairs the two behind one function.

## Events

```ts
cloudKit.onRemoteChange(({ keys, reason }) => reload(keys))
cloudKit.onAccountChange(({ identityChanged }) => {
  if (identityChanged) clearUserScopedCaches()
})
```

Native only - the REST path has no push channel without APNs. Both are no-ops elsewhere rather than throwing, so the same code runs on every platform.

## The constraint on Android and web

A `ckWebAuthToken` expires after **30 minutes**, or **2 weeks** with "Keep me signed in" ticked at sign-in. Apple documents no refresh mechanism, and there's no alternative auth mode:

- A **server-to-server key reaches only the public database.** Apple: *"Use a server-to-server key to access the public database of a container as the developer who created the key."*
- **Sign in with Apple can't bootstrap it.** Per Apple DTS: *"The unique user identifiers for Sign in with Apple and CloudKit are not linked."*

So interactive sign-in isn't a shortcut this package chose - it's the only mechanism that exists.

Design around it: make CloudKit-on-Android a deliberate import/export, handle `ERR_AUTH_EXPIRED` by prompting for sign-in rather than retrying, and use `googleDrive` for continuous background sync there.

The REST path needs no crypto - two query parameters on a `fetch` - so it's unaffected by the missing-`crypto` problem that stalled earlier CloudKit JS attempts in React Native.

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

Batched writes use `atomic: false` - a batch is a convenience, not a transaction, so one oversized record shouldn't silently discard the other 199. Per-record failures are raised, not swallowed.

Natively the same calls loop, since `CKModifyRecordsOperation` already coalesces on the framework's own schedule.

## Concurrent writes

The default is last-write-wins on both platforms: native uses `savePolicy = .changedKeys`, REST uses `forceUpdate`, so two devices writing the same record agree on the outcome rather than one failing on a change-tag mismatch.

Right for the common case, wrong when a genuine concurrent edit should be merged instead of destroyed. The REST client can do a conditional write:

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

`ERR_CONFLICT` carries `serverValue` precisely so this loop can merge - before conditional writes existed, the error could never fire, so the documented merge path was unreachable.

## Cancelling a transfer

```ts
const cancelled = await cloudKitAssets.cancel({ recordName: 'avatar', fieldName: 'image' })
await cloudKitBackup.cancel()                            // the default backup record
```

Identified by record and field, not a handle - the same pair `onProgress` reports, so a UI already showing progress has what it needs to stop it. The cancelled call rejects with `ERR_CANCELLED`, which `isCancelled(e)` recognises and shouldn't be shown as an error.

Native only, like the rest of the asset API.
