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

## Setup on Apple platforms

Entitlements only. The container identifier is read from them at runtime, so it never needs repeating in JavaScript and cannot drift out of sync. See [Platform Notes](../PLATFORM_NOTES.md#entitlements).

## Setup on Android and web

Three things in the [CloudKit Console][console] first:

1. A **Client** API token under API Access ([how tokens work][ckauth]). Not a server-to-server key - see [the constraint](#the-constraint-on-android-and-web) below.
2. A **Sign In Callback** set to `cloudkit-<container-id>://callback`.
3. Your schema **deployed to Production**, if you use `environment: 'production'`. Development and Production are separate datastores, so a debug build and a release build do not see each other's data.

Then configure the REST path:

```ts
import { configureCloudKit } from '@kesha-antonov/react-native-cloud-sync'

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
import { cloudKit } from '@kesha-antonov/react-native-cloud-sync'

await cloudKit.setItem('portfolio', JSON.stringify(holdings))

const raw = await cloudKit.getItem('portfolio')
// null means no such record. Nothing else returns null.

await cloudKit.removeItem('portfolio')

const names = await cloudKit.getAllKeys()
```

Records are stored with the record name as the key, so both platforms can fetch by name directly with no queryable index in the schema.

Concurrent writes resolve last-write-wins, identically on native (`.changedKeys`) and over REST (`forceUpdate`), so two devices cannot deadlock on a change-tag conflict.

## Custom zones

Native only; the REST client uses the default zone.

```ts
import { cloudKitZones } from '@kesha-antonov/react-native-cloud-sync'

await cloudKitZones.create('Projects')
const zones = await cloudKitZones.list()
await cloudKitZones.remove('Projects')
```

## Assets

For anything above the 1 MB record limit - images, audio, exports. The file is streamed from disk as a `CKAsset`, so a large file never has to be held in memory the way a base64 round trip would.

```ts
import { cloudKitAssets } from '@kesha-antonov/react-native-cloud-sync'

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
