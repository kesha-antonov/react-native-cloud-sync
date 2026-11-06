# CloudKit

The user's [private CloudKit database][ckdb]: [records][ckrecord], [custom zones][ckzone], [binary assets][ckasset]. The only provider that reaches the same data from iOS, Android and the web.

## When to use it

Your app's real data on Apple platforms, optionally reachable elsewhere. Records hold more than key-value entries (1 MB each, not 1 MB total) and are queryable.

| | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| Records | native | REST | REST |
| Custom zones | native | - | - |
| Assets (`CKAsset`) | native | REST (15 MB cap) | REST (15 MB cap) |
| Remote change events | native | - | - |
| Auth | implicit | Apple ID sign-in | Apple ID sign-in |

Per-record limit: 1 MB, excluding assets ([all limits][cklimits]). Oversized writes reject locally with `ERR_PAYLOAD_TOO_LARGE`.

## The schema

CloudKit is schema-bound. A missing schema is the most common reason a CloudKit app works in debug and fails in release. This package uses one record type:

| | |
|---|---|
| Record type | `KVBlob` |
| `value` | String - holds what `setItem` writes |
| `<fieldName>` | Asset - one per `cloudKitAssets` field you use |
| `<fieldName>__size` | Int(64) - byte count written with each asset |

Example: `cloudKitAssets.save({ recordName: 'avatar', fieldName: 'image' })` needs `image` (Asset) and `image__size` (Int) on `KVBlob`. `cloudKitBackup` defaults to `backup`/`file`, so it needs `file` and `file__size`. Record names are data, not schema; only field names and types must exist.

The `__size` field lets a restore report real progress from the first callback.

### Development creates it for you. Production does not.

Development adds fields on first write. Production only has what you deploy with **Deploy Schema Changes** in the Console; a release build that writes an undeployed field fails at runtime. Before your first release, write every field once in Development (or add it by hand), then deploy.

### `getAllKeys()` needs an index

`getItem`, `setItem` and `removeItem` address records by name and need no index. `getAllKeys()` runs a query (`CKQueryOperation` natively, `/records/query` over REST), and CloudKit refuses to query a record type without a queryable index.

In the Console, under **Indexes** for `KVBlob`, add:

| Field | Index type |
|---|---|
| `recordName` | **Queryable** |

Deploy it to Production too. Without it `getAllKeys()` rejects, and so do [`migrate()`](../store.md#migration) and the [delete-everything flow](../recipes.md#turning-it-off-and-deleting-what-is-stored), which use it.

## Setup on Apple platforms

Entitlements plus [the schema](#the-schema). The container identifier goes in `Info.plist` as `RNCloudSyncContainerIdentifier`, not in JavaScript; the Expo config plugin writes it, a bare project adds it by hand. Without it CloudKit is disabled: every call rejects with `ERR_CONTAINER_MISCONFIGURED`, `isAvailable()` resolves false, and nothing falls back to `iCloud.<bundle id>`. See [Platform Notes](../PLATFORM_NOTES.md#entitlements).

## Setup on Android and web

In the [CloudKit Console][console]:

1. Create a **Client** API token under API Access ([how tokens work][ckauth]). Not a server-to-server key; see [the constraint](#the-constraint-on-android-and-web).
2. Set the **Sign In Callback** to `cloudkit-<container-id>://callback`.
3. If you use `environment: 'production'`, deploy [the schema](#the-schema) and its `recordName` index to Production. Development and Production are separate datastores; debug and release builds do not see each other's data.

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

A Client token grants only what the signed-in user can already do, so it is safe to ship in the app binary. A server-to-server private key is not.

### Getting a `ckWebAuthToken`

1. `GET https://api.apple-cloudkit.com/database/1/<container>/<env>/public/users/current?ckAPIToken=<token>`
2. The response is **HTTP 421** with a `redirectURL` in a top-level error dict.
3. Load `redirectURL` in a WebView.
4. Intercept navigation to your callback scheme and read `ckWebAuthToken` from the query string.

Intercept at the native page-load level. `onShouldStartLoadWithRequest` is unreliable for Android's server-side 302s. A custom `cloudkit-...://` scheme is easier to intercept reliably than an `https` URL.

## Records

```ts
import { cloudKit } from 'react-native-cloud-sync'

await cloudKit.setItem('playlist', JSON.stringify(tracks))

const raw = await cloudKit.getItem('playlist')
// null means no such record. Nothing else returns null.

await cloudKit.removeItem('playlist')

const names = await cloudKit.getAllKeys()
```

The key is the record name, so reads fetch by name with no query. Only `getAllKeys()` queries and needs [the `recordName` index](#getallkeys-needs-an-index).

Keys starting with `rncs-enc.` are reserved for [`cloudKitEncrypted`](../encryption.md#cloudkits-native-encryption). Record names are unique across record types, so `cloudKit` rejects these keys with `ERR_INVALID_KEY` and omits them from `getAllKeys()`.

Natively, identifiers CloudKit would crash on reject with `ERR_INVALID_KEY`:

- record and zone names: 1 to 255 characters (UTF-16 units)
- record types and field names: ASCII letters, digits and `_`, not starting with a digit, at most 255 characters (249 for an asset field, to leave room for `__size`)
- field names CloudKit reserves for metadata (`recordID`, `recordType`, `creationDate`, `creatorUserRecordID`, `modificationDate`, `lastModifiedUserRecordID`, `recordChangeTag`)

Reads check the record type: a record with the requested name that is not a `KVBlob` rejects with `ERR_INVALID_KEY` (native and REST).

Concurrent writes are last-write-wins on both paths (native `.changedKeys`, REST `forceUpdate`), so two devices never deadlock on a change-tag conflict. See [Concurrent writes](#concurrent-writes).

## Custom zones

Native only; the REST client uses the default zone.

```ts
import { cloudKitZones } from 'react-native-cloud-sync'

await cloudKitZones.create('Projects')
const zones = await cloudKitZones.list()
await cloudKitZones.remove('Projects')
```

## Assets

For anything above the 1 MB record limit: images, audio, exports. Natively the file streams from disk as a `CKAsset` and is never held in memory.

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

Progress is reported per record, so concurrent transfers can be told apart. Assets are an explicit API; the [store facade](../store.md) does not route to them.

Rules:

- `recordName` must not start with the [reserved](#records) `rncs-enc.` prefix; `save` and `fetch` reject it with `ERR_INVALID_KEY`.
- Natively, `destinationUri` must name a file. An existing file is replaced; a directory is never deleted (the call rejects). A symlink is replaced as a link; its target is left alone.
- Without `destinationUri` (native only), the file lands at `tmp/rncs-asset-<hash>`, one stable name per zone, record and field. iOS may clear it at any time; copy it somewhere permanent.
- Over REST, CloudKit's asset upload and download URLs must be HTTPS. Anything else rejects with `ERR_UNKNOWN` and `serverErrorCode: 'UNTRUSTED_URL'`.

### On Android and web

`save` and `fetch` use CloudKit Web Services' asset protocol: request a single-use upload URL, POST the bytes, attach the returned descriptor to the record. As a result:

- **15 MB per asset, hard limit.** This is the Web Services ceiling (native `CKAsset` allows 50 MB). Oversized files reject locally with `ERR_PAYLOAD_TOO_LARGE`; use [`googleDriveFiles`](google-drive.md#large-files) for bigger files.
- **Needs a file adapter.** Local files go through the same `GoogleDriveFileAdapter` as [`googleDriveFiles`](google-drive.md#large-files). One `configureGoogleDriveFiles(adapter)` call covers both, even if you never use `googleDrive`.
- **`destinationUri` is required on `fetch`.** REST has no temporary directory to fall back to, so omitting it rejects with `ERR_UNSUPPORTED_PLATFORM`.

Native only, rejecting with `ERR_UNSUPPORTED_PLATFORM` over REST: a custom `zoneName` ([no REST zone support](#custom-zones)). `cancel()` resolves `false` over REST, since a REST transfer has no in-flight handle.

### Backup/restore helper

`cloudKitBackup` wraps `cloudKitAssets` for a single named blob (a database export, an archive) and reports progress as a fraction:

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

Both default to `recordName: 'backup'`, `fieldName: 'file'`. Override them to keep more than one backup.

`save` stores the byte count next to the asset, so `restore` (even on another device) reports real progress from the first callback.

Platform behavior matches `cloudKitAssets`, including the 15 MB cap on Android/web (use [`googleDriveFiles`](google-drive.md#large-files) for larger exports) and the required `destinationUri` there. [Recipes](../recipes.md#cross-platform-large-file-backup) wraps both behind one function.

## Availability and account state

```ts
// False when not signed in, restricted, or no container is declared.
if (!(await cloudKit.isAvailable()))
  return

const status = await cloudKit.getAccountStatus()
// 'available' | 'noAccount' | 'restricted'
// 'temporarilyUnavailable' | 'couldNotDetermine'
```

Natively you get all five [`CKAccountStatus`][ckstatus] states:

- `temporarilyUnavailable`: retry silently
- `noAccount`: prompt the user
- `couldNotDetermine`: do nothing yet

Without a [declared container](#setup-on-apple-platforms), `getAccountStatus()` rejects with `ERR_CONTAINER_MISCONFIGURED` and `isAvailable()` resolves false.

REST has no account-status endpoint: `getAccountStatus()` reports `available` once `configureCloudKit` has been called, `noAccount` before.

## Errors specific to CloudKit

| Code | Cause |
|---|---|
| `ERR_AUTH_EXPIRED` | REST `AUTHENTICATION_REQUIRED` / `AUTHENTICATION_FAILED`; `onAuthExpired` fires |
| `ERR_CONTAINER_MISCONFIGURED` | No declared container natively; REST `BAD_REQUEST` / `ZONE_NOT_FOUND`; or REST `ACCESS_DENIED` (the user lacks rights to the record type, zone or database, set by security roles in the Console). Not an auth failure: `onAuthExpired` does not fire |
| `ERR_ACCOUNT_UNAVAILABLE` | `CKError.accountTemporarilyUnavailable` |

When a single-record native write or fetch fails inside a `partialFailure`, you get the record's own error (quota, size limit, conflict) with its `retryAfterMs` and `serverValue`, not `ERR_UNKNOWN`. See [Error handling](../errors.md).

## Events

```ts
cloudKit.onRemoteChange(({ keys, reason }) => reload(keys))
cloudKit.onAccountChange(({ identityChanged }) => {
  if (identityChanged) clearUserScopedCaches()
})
```

Native only; REST has no push channel without APNs. Elsewhere both are no-ops, not errors, so the same code runs everywhere.

## The constraint on Android and web

A `ckWebAuthToken` expires after **30 minutes**, or **2 weeks** if "Keep me signed in" was ticked. Apple documents no refresh, and there is no other auth mode:

- A **server-to-server key reaches only the public database.** Apple: *"Use a server-to-server key to access the public database of a container as the developer who created the key."*
- **Sign in with Apple cannot bootstrap it.** Per Apple DTS: *"The unique user identifiers for Sign in with Apple and CloudKit are not linked."*

Interactive sign-in is the only mechanism. Design around it:

- treat CloudKit on Android as a deliberate import/export
- handle `ERR_AUTH_EXPIRED` by prompting for sign-in, not retrying
- use `googleDrive` for continuous background sync there

The REST path needs no crypto (two query parameters on a `fetch`), so it avoids the missing-`crypto` problem that blocked earlier CloudKit JS attempts in React Native.

[ckdb]: https://developer.apple.com/documentation/cloudkit/ckdatabase
[ckrecord]: https://developer.apple.com/documentation/cloudkit/ckrecord
[ckzone]: https://developer.apple.com/documentation/cloudkit/ckrecordzone
[ckasset]: https://developer.apple.com/documentation/cloudkit/ckasset
[ckws]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/index.html
[ckauth]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html
[cklimits]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/PropertyMetrics.html
[console]: https://icloud.developer.apple.com/dashboard/
[ckstatus]: https://developer.apple.com/documentation/cloudkit/ckaccountstatus

## Batching

Over REST, `/records/lookup` and `/records/modify` take arrays, so the store's [batch operations](../store.md#batch-operations) are real batches:

```ts
await store.multiGet(['a', 'b', 'c'])     // one request
await store.multiSet(entries)             // one request per 200 records
```

Batched writes use `atomic: false`: a batch is a convenience, not a transaction, so one oversized record does not discard the other 199. Per-record failures are raised, not swallowed.

Natively the calls loop; `CKModifyRecordsOperation` already coalesces on its own schedule.

## Concurrent writes

The default is last-write-wins (native `savePolicy = .changedKeys`, REST `forceUpdate`), so two devices writing the same record agree instead of one failing on a change-tag mismatch.

Conditional writes (save only if the record is unchanged since you read it) are not part of the public API yet. To avoid losing a concurrent edit, store data that merges cleanly, for example one record per item instead of one big document.

## Cancelling a transfer

```ts
const cancelled = await cloudKitAssets.cancel({ recordName: 'avatar', fieldName: 'image' })
await cloudKitBackup.cancel()                            // the default backup record
```

Transfers are identified by record and field (the same pair `onProgress` reports), not by a handle. The cancelled call rejects with `ERR_CANCELLED`; `isCancelled(e)` recognises it, and it should not be shown as an error.

Native only, like the rest of the asset API.
