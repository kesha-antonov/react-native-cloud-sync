<p align="center">
  <a href="https://badge.fury.io/js/@kesha-antonov%2Freact-native-cloud-storage"><img src="https://badge.fury.io/js/@kesha-antonov%2Freact-native-cloud-storage.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@kesha-antonov/react-native-cloud-storage"><img src="https://img.shields.io/npm/dm/@kesha-antonov/react-native-cloud-storage.svg" alt="npm downloads" /></a>
  <a href="https://github.com/kesha-antonov/react-native-cloud-storage/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@kesha-antonov/react-native-cloud-storage.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/platforms-iOS%20%7C%20Android%20%7C%20Web-lightgrey.svg" alt="platforms" />
  <img src="https://img.shields.io/badge/TypeScript-ready-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Expo-compatible-000020.svg" alt="Expo compatible" />
  <img src="https://img.shields.io/badge/New%20Architecture-supported-success.svg" alt="New Architecture supported" />
  <img src="https://img.shields.io/badge/Legacy%20Architecture-supported-success.svg" alt="Legacy Architecture supported" />
</p>

<h1 align="center">react-native-cloud-storage</h1>

<p align="center">
  iCloud key-value store, CloudKit and Google Drive behind one API - on iOS, Android and the web, on both React Native architectures.
</p>

<p align="center">
  <a href="https://kesha-antonov.github.io/react-native-cloud-storage/">Documentation</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-storage/comparison">Comparison</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-storage/api">API</a> ·
  <a href="https://kesha-antonov.github.io/react-native-cloud-storage/platform-notes">Platform Notes</a>
</p>

---

## ✨ Features

- ☁️ **Three providers, one API** - `NSUbiquitousKeyValueStore`, CloudKit records and Google Drive `appDataFolder`, each usable directly or through a single facade.
- 🍏 **CloudKit from Android and the web** - the same private database your iOS app writes to, over CloudKit Web Services. No other React Native library offers this.
- 🚨 **Errors you can act on** - every failure is a typed rejection (`ERR_NOT_SIGNED_IN`, `ERR_QUOTA_EXCEEDED`, `ERR_RATE_LIMITED` with `retryAfterMs`, ...). `null` means one thing only: the key does not exist.
- 👤 **Real account lifecycle** - all five `CKAccountStatus` values, plus `onAccountChange` with an `identityChanged` flag so you can drop user-scoped caches when the Apple ID changes.
- 🔔 **Remote change events** - `onRemoteChange` with typed reasons, so a write on another device shows up without polling.
- 📦 **Automatic size tiering** - small values to the key-value store, larger to a CloudKit record, larger still to a `CKAsset`. Store limits stop leaking into your product code.
- 🔁 **Durable outbox** - retryable failures are queued and retried with backoff that honours server retry hints; failures the user must act on surface immediately instead.
- 🧪 **A real testing story** - an in-memory provider with fault injection, exported from the package (`/testing`) and documented, so signed-out, offline, quota-exceeded and account-switch paths are all testable in Jest.
- ⚙️ **Old and new architecture** - React Native 0.71 through 0.86+, with the `#ifdef` bridge to prove it.

## 💡 Why?

Cloud storage in React Native is fragmented into single-provider wrappers, and almost all of them repeat the same handful of defects. Two independent libraries in this space ship a `setItem` that **reports a failed write as a success** - one checks the wrong error variable in its completion block, the other discards the operation result entirely. A third flattens five distinct iCloud account states into one boolean. A fourth has an open issue titled *"Idea: Listening for changes"* whose author replied *"Good idea, let's do it!"*, opened the PR himself, and left it unmerged for six months.

The common thread is that failure paths are treated as an afterthought. A `catch { return null }` makes "not signed in", "offline", "out of storage" and "no such key" indistinguishable - so apps cannot tell the user anything useful, and cannot decide whether to retry.

This library starts from the opposite end: the error contract first, then the providers.

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
| Size tiering / chunking | ✅ | – | – | – | – | – |
| Binary / assets | ✅ | ✅ | ❌ [^6] | ✅ | – | – |
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

[kuatsu]: https://github.com/kuatsu/react-native-cloud-storage
[ik]: https://github.com/BogdanGeorgian91/react-native-icloud-kit
[ec]: https://github.com/DevLab-Innovations/expo-cloudkit
[ok]: https://github.com/okwasniewski/expo-icloud-storage
[jp]: https://github.com/jacobp100/react-native-cloudkit-storage

## 📖 Table of Contents

- [Requirements](#-requirements)
- [Installation](#-installation)
- [Usage](#-usage)
- [Advanced Configuration](#-advanced-configuration)
- [API](#-api)
- [Platform Notes](#-platform-notes)
- [Testing](#-testing)
- [Troubleshooting](#-troubleshooting)
- [Example App](#-example-app)
- [Contributing](#-contributing)

## 📋 Requirements

| | Minimum |
|---|---|
| React Native | 0.71 |
| iOS | 15.1 |
| Xcode | 15 |
| Node | 20 |

Both the New and the Legacy architecture are supported. React Native 0.82 removed the Legacy Architecture entirely, so that half matters only if you are on 0.81 or below.

### Platform support per provider

| | iOS | Android | Web |
|---|:---:|:---:|:---:|
| `icloudKV` | native | – | – |
| `cloudKit` | native | REST | REST |
| `googleDrive` | REST | REST | REST |

`icloudKV` rejects with `ERR_UNSUPPORTED_PLATFORM` where it does not exist, rather than silently doing nothing. Every provider exposes `isAvailable()` so you can branch without a `try`/`catch`.

## 📦 Installation

### Expo

```sh
npx expo install @kesha-antonov/react-native-cloud-storage
```

Add the config plugin to `app.json`, then rebuild:

```json
{
  "expo": {
    "plugins": [
      ["@kesha-antonov/react-native-cloud-storage", {
        "containerIdentifier": "iCloud.com.your.app"
      }]
    ]
  }
}
```

```sh
npx expo prebuild --clean
```

### Bare React Native

```sh
yarn add @kesha-antonov/react-native-cloud-storage
cd ios && pod install
```

Then add the iCloud entitlements by hand - the plugin is optional, and a committed `ios/` directory is often easier to manage directly:

```xml
<key>com.apple.developer.icloud-container-identifiers</key>
<array>
  <string>iCloud.com.your.app</string>
</array>
<key>com.apple.developer.icloud-services</key>
<array>
  <string>CloudKit</string>
</array>
<key>com.apple.developer.ubiquity-kvstore-identifier</key>
<string>$(TeamIdentifierPrefix)$(CFBundleIdentifier)</string>
```

## 🚀 Usage

### The key-value store

```ts
import { icloudKV } from '@kesha-antonov/react-native-cloud-storage'

try {
  await icloudKV.setItem('settings/theme', 'dark')

  const theme = await icloudKV.getItem('settings/theme')
  // `null` here means the key does not exist - nothing else.
} catch (e) {
  console.warn(e.code) // ERR_NOT_SIGNED_IN | ERR_QUOTA_EXCEEDED | ...
}
```

### Reacting to other devices

```ts
const unsubscribe = icloudKV.onRemoteChange(({ keys, reason }) => {
  // reason: serverChange | initialSync | quotaViolation | accountChange
  refresh(keys)
})

icloudKV.onAccountChange(({ status, identityChanged }) => {
  // A different Apple ID is now signed in - anything cached for the previous
  // user must be dropped.
  if (identityChanged) clearUserScopedCaches()
})
```

### The facade

```ts
import { createCloudStore } from '@kesha-antonov/react-native-cloud-storage'

const store = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  tiering: 'auto',
  outboxStorage: mmkvAdapter, // persist queued writes across restarts
})

await store.setItem('portfolio', JSON.stringify(holdings))
const raw = await store.getItem('portfolio')

// On reconnect or foreground:
await store.flushOutbox()
```

Reads fall through the provider list, so a value written on another device by a different backend is still found.

### Handling failures

```ts
import { isRetryable, requiresUserAction } from '@kesha-antonov/react-native-cloud-storage'

try {
  await store.setItem('k', 'v')
} catch (e) {
  if (requiresUserAction(e)) promptUser(e.code)   // signed out, out of storage
  else if (isRetryable(e)) scheduleRetry(e.retryAfterMs)
}
```

## ⚙️ Advanced Configuration

### CloudKit on Android and the web

```ts
import { configureCloudKit } from '@kesha-antonov/react-native-cloud-storage'

configureCloudKit({
  containerIdentifier: 'iCloud.com.your.app',
  apiToken: CLOUDKIT_CLIENT_TOKEN,   // a Client token, never a server-to-server key
  environment: 'production',
  getAuthToken: () => secureStore.get('ckWebAuthToken'),
  onAuthExpired: () => promptAppleSignIn(),
})
```

You need three things in the CloudKit Console first:

1. A **Client** API token under API Access. (A server-to-server key will not work - see Platform Notes.)
2. A **Sign In Callback** set to `cloudkit-<container-id>://callback`.
3. Your schema **deployed to Production**, if `environment` is `'production'`. Development and Production are separate datastores.

### Google Drive

```ts
import { configureGoogleDrive } from '@kesha-antonov/react-native-cloud-storage'

configureGoogleDrive({
  getAccessToken: async () => (await GoogleSignin.getTokens()).accessToken,
  onAuthExpired: () => reconnectDrive(),
})
```

The library never owns the consent flow, so it stays independent of any particular sign-in library and the same code runs in a browser.

## 📚 API

| Export | Purpose |
|---|---|
| `icloudKV` | `NSUbiquitousKeyValueStore`, Apple platforms |
| `cloudKit` | CloudKit private database, every platform |
| `cloudKitZones` | Custom zones (native only) |
| `googleDrive` | Drive `appDataFolder`, every platform |
| `createCloudStore` | Facade: tiering, outbox, migration, fallthrough |
| `configureCloudKit` / `configureGoogleDrive` | Credentials for the REST paths |
| `ErrorCode`, `isCloudStorageError`, `isRetryable`, `requiresUserAction` | Error handling |
| `createMemoryProvider` | In-memory provider with fault injection |
| `setLogsEnabled` | Verbose logging, JS and native |

Every provider implements the same shape:

```ts
isAvailable(): Promise<boolean>
getAccountStatus(): Promise<AccountStatus>
getItem(key): Promise<string | null>
setItem(key, value): Promise<void>
removeItem(key): Promise<void>
getAllKeys(): Promise<string[]>
onRemoteChange?(cb): Unsubscribe
onAccountChange?(cb): Unsubscribe
```

Full reference: [`docs/API.md`](docs/API.md).

## 📱 Platform Notes

### CloudKit on Android and the web has a token lifetime you must design around

A `ckWebAuthToken` expires after **30 minutes**, or **2 weeks** if the user ticks "Keep me signed in", and Apple documents no refresh mechanism. There is no way around this:

- A **server-to-server key cannot reach a private database.** Apple: *"Use a server-to-server key to access the **public** database of a container as the developer who created the key."*
- **Sign in with Apple cannot bootstrap it.** Per Apple DTS, *"The unique user identifiers for Sign in with Apple and CloudKit are not linked."*

So an interactive Apple ID sign-in is the only mechanism that exists. Design CloudKit-on-Android as a deliberate **import/export** ("bring my iPhone data to this device"), and use Google Drive as the always-on backend there.

The REST path uses no crypto at all - just two query parameters on a `fetch` - so it is unaffected by the missing-`crypto` problem that killed earlier CloudKit JS attempts in React Native.

### `sync()` does not mean "stored"

`icloudKVSync()` maps to `NSUbiquitousKeyValueStore.synchronize()`, which schedules an upload and returns. A resolved promise means *queued*, never *stored in iCloud*.

More detail: [`docs/PLATFORM_NOTES.md`](docs/PLATFORM_NOTES.md).

## 🧪 Testing

```ts
import { createMemoryProvider } from '@kesha-antonov/react-native-cloud-storage/testing'
import { ErrorCode } from '@kesha-antonov/react-native-cloud-storage'

const provider = createMemoryProvider({
  initial: { 'user/id': '42' },
  faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
})

store.registerProvider(provider)

// Fail twice, then succeed - asserts retry logic converges.
provider.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 2 })

// Simulate another device, or an Apple ID switch.
provider.emitRemoteChange({ keys: ['user/id'], reason: 'serverChange' })
provider.emitAccountChange({ status: 'available', identityChanged: true })
```

This matters because iCloud on the simulator is unreliable enough that the most-used library in this space [stopped testing on it entirely](https://github.com/kuatsu/react-native-cloud-storage/issues/41), which leaves exactly the failure paths that matter least exercised.

## ❓ Troubleshooting

**"The native module doesn't seem to be linked"** - run `pod install` and rebuild the app. Restarting Metro is not enough, and Expo Go cannot load custom native modules.

**Writes appear to work but nothing reaches iCloud** - check `getAccountStatus()`. A signed-out device accepts key-value writes locally and never uploads them.

**`ERR_CONTAINER_MISCONFIGURED`** - the app has no iCloud entitlement, or the container identifier does not match the one in the entitlements file.

**Android CloudKit stops working after a while** - expected; the web auth token expired. Handle `ERR_AUTH_EXPIRED` by prompting for sign-in again.

**Nothing appears on the other device** - Development and Production are separate CloudKit datastores. A debug build and a TestFlight build do not share data.

## 🧪 Example App

A playground covering every API, plus a live sync demo built for side-by-side recording:

```sh
cd example
yarn installDevBuild:ios     # or :android
yarn start:web
```

Tabs: **Sync** (shared counter across devices), **iCloud KV**, **CloudKit**, **Drive**, **Store** (tiering, outbox, migration) and **Faults** (inject every failure on demand).

## 🤝 Contributing

Issues and pull requests are welcome. Run `yarn lint`, `yarn typecheck` and `yarn test` before opening one.

## 👥 Authors

- [Kesha Antonov](https://github.com/kesha-antonov)

## 📄 License

MIT
