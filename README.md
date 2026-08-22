<p align="center">
  <a href="https://www.npmjs.com/package/react-native-cloud-sync"><img src="https://img.shields.io/npm/v/react-native-cloud-sync.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/react-native-cloud-sync"><img src="https://img.shields.io/npm/dm/react-native-cloud-sync.svg" alt="npm downloads" /></a>
  <a href="https://github.com/kesha-antonov/react-native-cloud-sync/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/react-native-cloud-sync.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/platforms-iOS%20%7C%20Android%20%7C%20Web-lightgrey.svg" alt="platforms" />
  <img src="https://img.shields.io/badge/TypeScript-ready-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Expo-compatible-000020.svg" alt="Expo compatible" />
  <img src="https://img.shields.io/badge/New%20Architecture-supported-success.svg" alt="New Architecture supported" />
  <img src="https://img.shields.io/badge/Legacy%20Architecture-supported-success.svg" alt="Legacy Architecture supported" />
  <a href="https://github.com/sponsors/kesha-antonov"><img src="https://img.shields.io/badge/sponsor-%E2%9D%A4-ea4aaa.svg?logo=github-sponsors" alt="Sponsor this project" /></a>
</p>

<h1 align="center">react-native-cloud-sync</h1>

<p align="center">
  iCloud key-value store, CloudKit and Google Drive behind one API - iOS, Android, web, both architectures.
</p>

<p align="center">
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/">Documentation</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/comparison">Comparison</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/api">API</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-sync/platform-notes">Platform Notes</a>
</p>

---

## ✨ Features

- ☁️ Four providers behind one API - [`NSUbiquitousKeyValueStore`][kvs], [CloudKit][ck] records, [iCloud Drive][icdrive] documents, Google Drive [`appDataFolder`][appdata] - directly or through one facade.
- 🍏 CloudKit reaches Android and web too, via [CloudKit Web Services][ckws] - the same [private database][ckdb] your iOS app uses.
- 📂 `icloudDocuments` writes into the user's real iCloud Drive, visible in Files.app - unlike an invisible `CKAsset`.
- 🚨 Every failure is a typed rejection (`ERR_NOT_SIGNED_IN`, `ERR_QUOTA_EXCEEDED`, `ERR_RATE_LIMITED` with `retryAfterMs`, ...); `null` means only "key doesn't exist".
- 👤 All five [`CKAccountStatus`][ckstatus] values surface as-is, plus `onAccountChange` with `identityChanged`, which drops the previous account's caches and queued writes.
- 🔔 `onRemoteChange` fires on every provider and the facade, including Google Drive via its change cursor.
- 📦 Small values go to the key-value store, larger ones to a [`CKRecord`][ckrecord] field, binary as a [`CKAsset`][ckasset] or a resumable Drive upload - sized automatically.
- 🔁 Retryable failures queue into a durable outbox: backoff honours retry hints, auto-drains on foreground, bounded, never overwrites a newer write.
- 🧺 `multiGet`/`multiSet`/`multiRemove`/`clear` batch for real, one request per provider.
- 🪝 React hooks - `useCloudItem`, `useAccountStatus`, `usePendingWrites` from `/hooks` - without the stale-response and unmounted-`setState` bugs.
- 🔐 `cloudKitEncrypted` uses CloudKit's own `encryptedValues` - ciphertext only, no key exposed; elsewhere, a `codec` seam for your own cipher.
- 🧪 An in-memory provider with fault injection, plus the native mock, both exported (`/testing`, `/jest-mock`) - every failure path testable in Jest.
- ⚙️ React Native 0.71 through 0.86+, old and new architecture, with the `#ifdef` bridge to prove it.

## 💡 Why?

Cloud storage in React Native is fragmented into single-provider wrappers repeating the same defects: two ship a `setItem` that **reports a failed write as a success** (one checks the wrong error variable, the other discards the result entirely), and a third flattens five iCloud account states into one boolean.

A `catch { return null }` makes "not signed in", "offline", "out of storage" and "no such key" indistinguishable - apps can't tell the user anything useful, or decide whether to retry.

This library starts from the opposite end: the error contract first, providers second.

## 📚 Upstream documentation

This package is a wrapper: unexpected behavior is usually explained in Apple's or Google's docs, not ours.

**Apple**

| | |
|---|---|
| [`NSUbiquitousKeyValueStore`][kvs] | The iCloud key-value store; 1 MB / 1024-key limits |
| [CloudKit][ck] · [`CKDatabase`][ckdb] · [`CKRecord`][ckrecord] | Records in the user's private database |
| [`CKAsset`][ckasset] · [`CKRecordZone`][ckzone] | Binary assets and custom zones |
| [`CKAccountStatus`][ckstatus] | The five account states this package surfaces verbatim |
| [CloudKit Web Services][ckws] | The REST API behind the Android and web paths |
| [Authentication][ckauth] · [Data size limits][cklimits] · [Error codes][ckerrors] | Worth reading before shipping CloudKit on Android |
| [iCloud entitlements][entitlements] | The keys the config plugin writes |
| [CloudKit Console][console] | Where containers, schemas, API tokens and the sign-in callback live |

**Google**

| | |
|---|---|
| [The `appDataFolder`][appdata] | The hidden per-app folder this package stores into |
| [Drive `files` resource][drivefiles] | The REST endpoints behind the provider |
| [Drive API scopes][drivescopes] | Why `drive.appdata`, not something broader |

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
[icdrive]: https://developer.apple.com/documentation/foundation/filemanager/1411653-url
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
| Android | ✅ | ✅ | – | ❌ [[1]](#note-1) | – | – |
| Web | ✅ | partial [[2]](#note-2) | – | – | – | – |
| **CloudKit on Android/web** | ✅ | – | – | ❌ [[1]](#note-1) | – | – |
| New Architecture | ✅ | ✅ | ✅ | ✅ | ✅ | – |
| **Legacy Architecture** | ✅ | ❌ | ✅ [[3]](#note-3) | ✅ [[3]](#note-3) | ✅ [[3]](#note-3) | ✅ |
| Typed error codes | ✅ | – | partial | ✅ | – | – |
| 5-value account status | ✅ | boolean | boolean | ✅ | – | – |
| Identity-change event | ✅ | ⚠️ [[4]](#note-4) | – | ✅ | – | – |
| Remote-change event | ✅ | ✅ | – | n/a | ❌ [[5]](#note-5) | ✅ |
| Offline write queue | ✅ | – | – | ✅ | – | – |
| Size tiering | ✅ | – | – | – | – | – |
| Binary / assets | ✅ [[9]](#note-9) | ✅ | ❌ [[6]](#note-6) | ✅ | – | – |
| User-visible iCloud Drive files | ✅ | – | – | – | ✅ | – |
| Native end-to-end encryption | ✅ | – | – | – | – | – |
| Batch operations | ✅ | – | – | – | – | – |
| React hooks | ✅ | ✅ | – | – | – | – |
| Encryption seam | ✅ | – | – | – | – | – |
| Exported test harness | ✅ | – | – | ⚠️ [[7]](#note-7) | – | – |
| Mac Catalyst | ✅ | – | – | ⚠️ | – | – |
| Actively maintained | ✅ | ✅ | ✅ | ❌ [[8]](#note-8) | ❌ [[5]](#note-5) | ❌ |

<a id="note-1"></a>**[1]** expo-cloudkit's README: Android throws `CloudKitNotSupportedError` on every call.  
<a id="note-2"></a>**[2]** Google Drive support is text-based only.  
<a id="note-3"></a>**[3]** Via the Expo Modules API - pulls in `expo-modules-core`.  
<a id="note-4"></a>**[4]** Fires before JS binds the emitter, crashing with `std::bad_function_call` (SIGABRT) - hit three times.  
<a id="note-5"></a>**[5]** One version ever shipped; the change-listener PR has sat open since February.  
<a id="note-6"></a>**[6]** Field type is `string | number | null` - can't hold binary data.  
<a id="note-7"></a>**[7]** A mock factory exists, but isn't exported or documented.  
<a id="note-8"></a>**[8]** No commits since April; the last four releases shipped with Swift that didn't compile.  
<a id="note-9"></a>**[9]** `CKAsset` on Apple platforms; CloudKit Web Services' upload-token protocol on Android/web, capped at 15 MB (CloudKit's limit, not this package's). Use [`googleDriveFiles`](https://kesha-antonov.github.io/react-native-cloud-sync/providers/google-drive#large-files) for anything bigger - it chunks and resumes the same way.

[kuatsu]: https://github.com/kuatsu/react-native-cloud-storage
[ik]: https://github.com/BogdanGeorgian91/react-native-icloud-kit
[ec]: https://github.com/DevLab-Innovations/expo-cloudkit
[ok]: https://github.com/okwasniewski/expo-icloud-storage
[jp]: https://github.com/jacobp100/react-native-cloudkit-storage

## 📖 Documentation

| | |
|---|---|
| [Choosing a provider](https://kesha-antonov.github.io/react-native-cloud-sync/choosing-a-provider) | Which one, what it costs, why to let the user pick |
| [iCloud key-value store](https://kesha-antonov.github.io/react-native-cloud-sync/providers/icloud-kv) | Small settings, zero friction, Apple only |
| [CloudKit](https://kesha-antonov.github.io/react-native-cloud-sync/providers/cloudkit) | Records, zones, assets - and the Android/web path |
| [iCloud Drive](https://kesha-antonov.github.io/react-native-cloud-sync/providers/icloud-drive) | Files in the user's own Drive, visible in Files.app |
| [Google Drive](https://kesha-antonov.github.io/react-native-cloud-sync/providers/google-drive) | The always-on cross-platform backend |
| [The store facade](https://kesha-antonov.github.io/react-native-cloud-sync/store) | Tiering, outbox, migration, fallthrough |
| [Error handling](https://kesha-antonov.github.io/react-native-cloud-sync/errors) | The typed contract |
| [Encryption](https://kesha-antonov.github.io/react-native-cloud-sync/encryption) | What's encrypted for you, and how to add your own |
| [React hooks](https://kesha-antonov.github.io/react-native-cloud-sync/hooks) | Binding cloud state to components |
| [Recipes](https://kesha-antonov.github.io/react-native-cloud-sync/recipes) | Backup/restore, migration, offline-first |
| [Testing](https://kesha-antonov.github.io/react-native-cloud-sync/testing) | Fault injection without a device |
| [API reference](https://kesha-antonov.github.io/react-native-cloud-sync/api) | Every export |
| [Platform notes](https://kesha-antonov.github.io/react-native-cloud-sync/platform-notes) | Entitlements, architectures, build config |
| [Troubleshooting](https://kesha-antonov.github.io/react-native-cloud-sync/troubleshooting) | Common problems and what they usually mean |

## 📋 Requirements

| | Minimum |
|---|---|
| React Native | 0.71 |
| iOS | 15.1 |
| Node | 20 |

Both architectures supported; RN 0.82 removed Legacy Architecture, so that half only matters on 0.81 and below.

### Platform support per provider

|  | iOS / macOS | Android | Web |
|---|:---:|:---:|:---:|
| `icloudKV` | native | – | – |
| `cloudKit` | native | REST | REST |
| `cloudKitEncrypted` | native | – | – |
| `icloudDocuments` | native | – | – |
| `googleDrive` | REST | REST | REST |

An unavailable provider rejects with `ERR_UNSUPPORTED_PLATFORM` rather than silently no-op'ing - [Choosing a provider](https://kesha-antonov.github.io/react-native-cloud-sync/choosing-a-provider) covers the trade-offs.

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

Bare React Native and manual `ios/` entitlement keys: see [Installation](https://kesha-antonov.github.io/react-native-cloud-sync/installation).

## 🚀 Quick start

### iCloud key-value store

No sign-in, no UI - uses the device's existing account.

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

Android/web needs an Apple ID sign-in whose token lasts up to two weeks - an explicit import, not background sync. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/providers/cloudkit)

### Sensitive data

CloudKit's own end-to-end encryption - Apple stores ciphertext and holds no key.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
```

Apple-only: the key lives in the user's iCloud Keychain, so nothing server-side can decrypt it. Cross-platform needs the store's `codec` seam instead. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/encryption)

### iCloud Drive

Files the user can open in Files.app - not hidden in a private database.

```ts
import { icloudDocuments } from 'react-native-cloud-sync'

await icloudDocuments.save({ fileUri: localPath, name: 'Export 2024.csv' })

// A listed file may be a placeholder with no local bytes. fetch() downloads it.
const path = await icloudDocuments.fetch({ name: 'Export 2024.csv' })
```

[Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/providers/icloud-drive)

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

Those two options make sync work in **both** directions across a mixed fleet: `mirror` copies to Drive so non-Apple devices can read it; `resolve` stops an Apple device serving a stale iCloud copy without checking Drive. Either platform can be where the user started. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/store)

### In a component

```tsx
import { useCloudItem } from 'react-native-cloud-sync/hooks'

const { value, setValue, loading, error } = useCloudItem<Settings>(store, 'settings')
```

Re-reads on remote writes, drops stale responses, never calls `setState` after unmount. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/hooks)

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
import { ErrorCode } from 'react-native-cloud-sync'
import { createMemoryProvider } from 'react-native-cloud-sync/testing'

const provider = createMemoryProvider({
  faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
})

provider.emitAccountChange({ status: 'available', identityChanged: true })
```

Signed-out, offline and account-switch paths, all in Jest without a device. [Full guide →](https://kesha-antonov.github.io/react-native-cloud-sync/testing)

## 🧪 Example App

A playground covering every API, plus a live sync demo for side-by-side recording:

```sh
cd example
yarn installDevBuild:ios     # or :android
yarn start:web
```

Tabs: **Sync** (shared counter, one-tap mirror mode to iCloud+Drive), **iCloud KV**, **CloudKit**, **Drive**, **Files** (large-file backup/restore via `GoogleDriveFileAdapter`), **Store**, **Faults**.

<p align="center">
  <img src="assets/screenshots/sync.png" width="18%" alt="Sync demo tab - shared counter with mirror provider selection" />&nbsp;&nbsp;<img src="assets/screenshots/icloud-kv.png" width="18%" alt="iCloud key-value store tab" />&nbsp;&nbsp;<img src="assets/screenshots/cloudkit.png" width="18%" alt="CloudKit tab - record read/write and oversized-write handling" />&nbsp;&nbsp;<img src="assets/screenshots/drive.png" width="18%" alt="Google Drive tab - OAuth token configuration and file operations" />&nbsp;&nbsp;<img src="assets/screenshots/store.png" width="18%" alt="Store facade tab - size tiering across providers" />
</p>

## 🤝 Contributing

Issues and pull requests welcome. Run `yarn lint`, `yarn typecheck` and `yarn test` before opening one.

## 👥 Authors

- [Kesha Antonov](https://github.com/kesha-antonov)

## 📄 License

MIT
