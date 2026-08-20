<p align="center">
  <a href="https://www.npmjs.com/package/react-native-cloud-sync"><img src="https://img.shields.io/npm/v/react-native-cloud-sync.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/react-native-cloud-sync"><img src="https://img.shields.io/npm/dm/react-native-cloud-sync.svg" alt="npm downloads" /></a>
  <a href="https://github.com/kesha-antonov/react-native-cloud-sync/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/react-native-cloud-sync.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/platforms-iOS%20%7C%20Android%20%7C%20Web-lightgrey.svg" alt="platforms" />
  <img src="https://img.shields.io/badge/TypeScript-ready-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Expo-compatible-000020.svg" alt="Expo compatible" />
  <img src="https://img.shields.io/badge/New%20Architecture-supported-success.svg" alt="New Architecture supported" />
  <img src="https://img.shields.io/badge/Legacy%20Architecture-supported-success.svg" alt="Legacy Architecture supported" />
</p>

<h1 align="center">react-native-cloud-sync</h1>

<p align="center">
  iCloud key-value store, CloudKit and Google Drive behind one API - on iOS, Android and the web, on both React Native architectures.
</p>

<p align="center">
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/">Documentation</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/comparison">Comparison</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/api">API</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/platform-notes">Platform Notes</a>
</p>

---

## ✨ Features

- ☁️ **Three providers, one API** - [`NSUbiquitousKeyValueStore`][kvs] (iCloud's key-value store), [CloudKit][ck] records and Google Drive [`appDataFolder`][appdata], each usable directly or through a single facade.
- 🍏 **CloudKit from Android and the web** - the same [private database][ckdb] your iOS app writes to, over [CloudKit Web Services][ckws]. No other React Native library offers this.
- 🚨 **Errors you can act on** - every failure is a typed rejection (`ERR_NOT_SIGNED_IN`, `ERR_QUOTA_EXCEEDED`, `ERR_RATE_LIMITED` with `retryAfterMs`, ...). `null` means one thing only: the key does not exist.
- 👤 **Real account lifecycle** - all five [`CKAccountStatus`][ckstatus] values, plus `onAccountChange` with an `identityChanged` flag so you can drop user-scoped caches when the Apple ID changes.
- 🔔 **Remote change events** - `onRemoteChange` with typed reasons, so a write on another device shows up without polling.
- 📦 **Automatic size tiering** - small values to the key-value store, larger to a [`CKRecord`][ckrecord] field. Binary assets go in as a [`CKAsset`][ckasset] through their own API. Store limits stop leaking into your product code.
- 🔁 **Durable outbox** - retryable failures are queued and retried with backoff that honours server retry hints; failures the user must act on surface immediately instead.
- 🧪 **A real testing story** - an in-memory provider with fault injection, exported from the package (`/testing`) and documented, so signed-out, offline, quota-exceeded and account-switch paths are all testable in Jest.
- ⚙️ **Old and new architecture** - React Native 0.71 through 0.86+, with the `#ifdef` bridge to prove it.

## 💡 Why?

Cloud storage in React Native is fragmented into single-provider wrappers, and almost all of them repeat the same handful of defects. Two independent libraries in this space ship a `setItem` that **reports a failed write as a success** - one checks the wrong error variable in its completion block, the other discards the operation result entirely. A third flattens five distinct iCloud account states into one boolean. A fourth has an open issue titled *"Idea: Listening for changes"* whose author replied *"Good idea, let's do it!"*, opened the PR himself, and left it unmerged for six months.

The common thread is that failure paths are treated as an afterthought. A `catch { return null }` makes "not signed in", "offline", "out of storage" and "no such key" indistinguishable - so apps cannot tell the user anything useful, and cannot decide whether to retry.

This library starts from the opposite end: the error contract first, then the providers.

## 📚 Upstream documentation

This package is a wrapper. When something behaves unexpectedly, the answer is usually in Apple's or Google's documentation rather than ours - so here is where to look.

**Apple**

| | |
|---|---|
| [`NSUbiquitousKeyValueStore`][kvs] | The iCloud key-value store, and its 1 MB / 1024-key limits |
| [CloudKit][ck] · [`CKDatabase`][ckdb] · [`CKRecord`][ckrecord] | Records in the user's private database |
| [`CKAsset`][ckasset] · [`CKRecordZone`][ckzone] | Binary assets and custom zones |
| [`CKAccountStatus`][ckstatus] | The five account states this package surfaces verbatim |
| [CloudKit Web Services][ckws] | The REST API behind the Android and web paths |
| [Authentication][ckauth] · [Data size limits][cklimits] · [Error codes][ckerrors] | The three pages worth reading before shipping CloudKit on Android |
| [iCloud entitlements][entitlements] | The keys the config plugin writes |
| [CloudKit Console][console] | Where containers, schemas, API tokens and the sign-in callback live |

**Google**

| | |
|---|---|
| [The `appDataFolder`][appdata] | The hidden per-app folder this package stores into |
| [Drive `files` resource][drivefiles] | The REST endpoints behind the provider |
| [Drive API scopes][drivescopes] | Why `drive.appdata` and not something broader |

[kvs]: https://developer.apple.com/documentation/foundation/nsubiquitouskeyvaluestore
[ck]: https://developer.apple.com/documentation/cloudkit
[ckdb]: https://developer.apple.com/documentation/cloudkit/ckdatabase
[ckrecord]: https://developer.apple.com/documentation/cloudkit/ckrecord
[ckasset]: https://developer.apple.com/documentation/cloudkit/ckasset
[ckzone]: https://developer.apple.com/documentation/cloudkit/ckrecordzone
[ckstatus]: https://developer.apple.com/documentation/cloudkit/ckaccountstatus
[ckws]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/index.html
[ckauth]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/SettingUpWebServices.html
[cklimits]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/PropertyMetrics.html
[ckerrors]: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ErrorCodes.html
[entitlements]: https://developer.apple.com/documentation/bundleresources/entitlements/com_apple_developer_icloud-services
[console]: https://icloud.developer.apple.com/dashboard/
[appdata]: https://developers.google.com/workspace/drive/api/guides/appdata
[drivefiles]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
[drivescopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth

## ⚖️ Comparison

| | **this** | [kuatsu/<br />cloud-storage][kuatsu] | [icloud-kit][ik] | [expo-cloudkit][ec] | [okwasniewski/<br />icloud-storage][ok] | [cloudkit-<br />storage][jp] |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| iCloud key-value store | ✅ | ✅ | ✅ | – | ✅ | – |
| CloudKit records | ✅ | – | ✅ | ✅ | – | ✅ |
| Google Drive | ✅ | ✅ | – | – | – | – |
| iOS | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Android | ✅ | ✅ | – | ❌ [^1] | – | – |
| Web | ✅ | partial [^2] | – | – | – | – |
| **CloudKit on Android/web** | ✅ | – | – | ❌ [^1] | – | – |
| New Architecture | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| **Legacy Architecture** | ✅ | ❌ | ✅ [^3] | ✅ [^3] | ✅ [^3] | ✅ |
| Typed error codes | ✅ | – | partial | ✅ | – | – |
| 5-value account status | ✅ | boolean | boolean | ✅ | – | – |
| Identity-change event | ✅ | ⚠️ [^4] | – | ✅ | – | – |
| Remote-change event | ✅ | ✅ | – | n/a | ❌ [^5] | ✅ |
| Offline write queue | ✅ | – | – | ✅ | – | – |
| Size tiering | ✅ | – | – | – | – | – |
| Binary / assets | ✅ [^9] | ✅ | ❌ [^6] | ✅ | – | – |
| Exported test harness | ✅ | – | – | ⚠️ [^7] | – | – |
| Mac Catalyst | ✅ | – | – | ⚠️ | – | – |
| Actively maintained | ✅ | ✅ | ✅ | ❌ [^8] | ❌ [^5] | ❌ |

[^1]: expo-cloudkit's README states Android returns `CloudKitNotSupportedError` on every call.
[^2]: Text-based Google Drive operations only.
[^3]: Expo Modules API supports both architectures, but these packages require `expo-modules-core`.
[^4]: The event exists and has crashed with `std::bad_function_call` (SIGABRT) when it fires before JS binds the emitter - reported independently three times.
[^5]: One version ever published; the change-listener PR has been open since February.
[^6]: Its field type is `string | number | null`, so binary data cannot be stored at all.
[^7]: A mock factory exists but is not exported from the package entry and is not mentioned in the README.
[^8]: No commits since April; four npm releases shipped with Swift that did not compile.
[^9]: `CKAsset`, streamed from disk, on Apple platforms. Not yet implemented over CloudKit Web Services, so on Android and web asset calls reject with `ERR_UNSUPPORTED_PLATFORM` rather than appearing to work - use [`googleDriveFiles`](https://kesha-antonov.github.io/react-native-cloud-sync/providers/google-drive#large-files) for binaries there, which chunks and resumes the same way `CKAsset` does.

[kuatsu]: https://github.com/kuatsu/react-native-cloud-storage
[ik]: https://github.com/BogdanGeorgian91/react-native-icloud-kit
[ec]: https://github.com/DevLab-Innovations/expo-cloudkit
[ok]: https://github.com/okwasniewski/expo-icloud-storage
[jp]: https://github.com/jacobp100/react-native-cloudkit-storage

## 📖 Documentation

| | |
|---|---|
| [Choosing a provider](https://kesha-antonov.github.io/react-native-cloud-sync/choosing-a-provider) | Which one, what each costs you, and why to let the user pick |
| [iCloud key-value store](https://kesha-antonov.github.io/react-native-cloud-sync/providers/icloud-kv) | Small settings, zero friction, Apple only |
| [CloudKit](https://kesha-antonov.github.io/react-native-cloud-sync/providers/cloudkit) | Records, zones, assets - and the Android/web path |
| [Google Drive](https://kesha-antonov.github.io/react-native-cloud-sync/providers/google-drive) | The always-on cross-platform backend |
| [The store facade](https://kesha-antonov.github.io/react-native-cloud-sync/store) | Tiering, outbox, migration, fallthrough |
| [Error handling](https://kesha-antonov.github.io/react-native-cloud-sync/errors) | The typed contract |
| [Recipes](https://kesha-antonov.github.io/react-native-cloud-sync/recipes) | Backup/restore, migration, offline-first |
| [Testing](https://kesha-antonov.github.io/react-native-cloud-sync/testing) | Fault injection without a device |
| [API reference](https://kesha-antonov.github.io/react-native-cloud-sync/api) | Every export |
| [Platform notes](https://kesha-antonov.github.io/react-native-cloud-sync/platform-notes) | Entitlements, architectures, build config |

## 📋 Requirements

| | Minimum |
|---|---|
| React Native | 0.71 |
| iOS | 15.1 |
| Node | 20 |

Both architectures are supported. React Native 0.82 removed the Legacy Architecture, so that half matters only on 0.81 and below.

### Platform support per provider

|  | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| `icloudKV` | native | – | – |
| `cloudKit` | native | REST | REST |
| `googleDrive` | REST | REST | REST |

Where a provider is unavailable it rejects with `ERR_UNSUPPORTED_PLATFORM` rather than silently doing nothing. [Choosing a provider](https://kesha-antonov.github.io/react-native-cloud-sync/choosing-a-provider) covers the trade-offs.

## 📦 Installation

```sh
npx expo install react-native-cloud-sync
```

Add the config plugin, then rebuild:

```json
{
  "expo": {
    "plugins": [
      ["react-native-cloud-sync", {
        "containerIdentifier": "iCloud.com.your.app"
      }]
    ]
  }
}
```

Bare React Native, and the raw entitlement keys if you manage `ios/` yourself: see [Installation](https://kesha-antonov.github.io/react-native-cloud-sync/installation).

## 🚀 Quick start

### iCloud key-value store

No sign-in, no UI - it uses the account already on the device.

```ts
import { icloudKV } from 'react-native-cloud-sync'

await icloudKV.setItem('settings/theme', 'dark')
const theme = await icloudKV.getItem('settings/theme')
// null means the key does not exist. Nothing else returns null.

icloudKV.onRemoteChange(({ keys }) => reload(keys))
```

[Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/providers/icloud-kv)

### CloudKit

The same private database from iOS, Android and web.

```ts
import { cloudKit, cloudKitAssets } from 'react-native-cloud-sync'

await cloudKit.setItem('playlist', JSON.stringify(tracks))
const raw = await cloudKit.getItem('playlist')

// Anything above the 1 MB record limit goes in as a streamed CKAsset.
await cloudKitAssets.save({ recordName: 'avatar', fieldName: 'image', fileUri })
```

On Android and web this needs an Apple ID sign-in whose token lasts at most two weeks, so treat it as an explicit import rather than background sync. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/providers/cloudkit)

### Google Drive

Identical behaviour on every platform, no periodic re-auth.

```ts
import { configureGoogleDrive, googleDrive } from 'react-native-cloud-sync'

configureGoogleDrive({
  getAccessToken: async () => (await GoogleSignin.getTokens()).accessToken,
})

await googleDrive.setItem('playlist.json', JSON.stringify(tracks))
```

[Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/providers/google-drive)

### All of them at once

```ts
import { createCloudStore } from 'react-native-cloud-sync'

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],       // preference order
  writeMode: 'mirror',                          // write to BOTH, not just the first
  resolve: resolveByTimestamp('updatedAt'),     // read the newest, not the first
  tiering: 'auto',                              // route by size
  outboxStorage: mmkvAdapter,                   // survive restarts
})

await store.setItem('playlist', json)
await store.flushOutbox()                       // on reconnect
```

Those two options are what make sync work in **both** directions across a mixed fleet - an Android phone and an iPad, a browser and a Mac. `mirror` puts a copy in Drive so a non-Apple device has something to read; `resolve` stops an Apple device serving its own stale iCloud copy without ever consulting Drive. Either platform can be the one the user started on. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/store)

### Handling failures

```ts
import { isRetryable, requiresUserAction } from 'react-native-cloud-sync'

try {
  await store.setItem('k', 'v')
} catch (e) {
  if (requiresUserAction(e)) promptUser(e.code)      // signed out, out of storage
  else if (isRetryable(e)) scheduleRetry(e.retryAfterMs)
}
```

[Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/errors)

## 🧪 Testing

```ts
import { createMemoryProvider } from 'react-native-cloud-sync/testing'

const provider = createMemoryProvider({
  faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
})

provider.emitAccountChange({ status: 'available', identityChanged: true })
```

Signed-out, offline, quota-exceeded, rate-limited and account-switch paths, all in Jest without a device. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/testing)

## 🧪 Example App

A playground covering every API, plus a live sync demo built for side-by-side recording:

```sh
cd example
yarn installDevBuild:ios     # or :android
yarn start:web
```

Tabs: **Sync** (shared counter across devices), **iCloud KV**, **CloudKit**, **Drive**, **Store** and **Faults**.

## 🤝 Contributing

Issues and pull requests welcome. Run `yarn lint`, `yarn typecheck` and `yarn test` before opening one.

## 👥 Authors

- [Kesha Antonov](https://github.com/kesha-antonov)

## 📄 License

MIT
