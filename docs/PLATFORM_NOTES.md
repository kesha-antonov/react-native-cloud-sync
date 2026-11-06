# Platform Notes

## Support matrix

| | iOS | macOS / Catalyst | Android | Web |
|---|:---:|:---:|:---:|:---:|
| `icloudKV` | native | native | - | - |
| `cloudKit` | native | native | REST | REST |
| `googleDrive` | REST | REST | REST | REST |

## iOS

### Entitlements

Three keys. The Expo config plugin writes them; in a bare project add them by hand:

```xml
<key>com.apple.developer.icloud-container-identifiers</key>
<array><string>iCloud.com.your.app</string></array>
<key>com.apple.developer.icloud-services</key>
<array><string>CloudKit</string></array>
<key>com.apple.developer.ubiquity-kvstore-identifier</key>
<string>$(TeamIdentifierPrefix)$(CFBundleIdentifier)</string>
```

Entitlements cannot be read at runtime, so the native side reads the CloudKit container from `Info.plist` key `RNCloudSyncContainerIdentifier`. The plugin writes it when `cloudKit` is on; in a bare project add it yourself:

```xml
<key>RNCloudSyncContainerIdentifier</key>
<string>iCloud.com.your.app</string>
```

There is no `iCloud.<bundle id>` fallback. Without the key, CloudKit is off for the build: every `cloudKit` / `cloudKitEncrypted` call rejects with `ERR_CONTAINER_MISCONFIGURED` and `isAvailable()` resolves false. This keeps key-value-store-only apps from crashing: creating a `CKContainer` the app is not entitled to traps inside CloudKit.

The plugin's `containerIdentifier` (default `iCloud.<bundle id>`) must be `iCloud.` plus a reverse-DNS name: letters, digits, `-` and `_` separated by dots. Anything else, such as a wildcard or a `$(...)` build setting, fails the prebuild.

iCloud Drive has its own optional key, `RNCloudSyncDocumentsContainerIdentifier`. See [iCloud Drive setup](providers/icloud-drive.md#setup).

### `synchronize()` is not a round trip

`icloudKVSync()` maps to `NSUbiquitousKeyValueStore.synchronize()`. It schedules an upload and returns without waiting. A resolved promise means queued, not stored.

### Development vs Production

Separate CloudKit datastores: a debug build and a TestFlight build do not see each other's data. See [the schema](providers/cloudkit.md#development-creates-it-for-you-production-does-not).

### iCloud Drive

Needs the **CloudDocuments** service and an `NSUbiquitousContainers` Info.plist entry in addition to the CloudKit entitlement. The config plugin writes both when `iCloudDocuments: true` (off by default, since it adds a folder to the user's iCloud Drive). See [iCloud Drive setup](providers/icloud-drive.md#setup) for the keys and the `CFBundleShortVersionString` caching issue.

### Mac Catalyst

Supported. Catalyst builds from the iOS slice, and both CloudKit and `NSUbiquitousKeyValueStore` are available.

CI compiles this package for the Catalyst triple (`arm64-apple-ios*-macabi`) along with the iOS device and simulator triples. CI does not build a whole app for Catalyst: React Native does not officially support it, so whether your app links depends on your other pods.

## Android

### CloudKit works, with one hard constraint

Android reaches CloudKit over CloudKit Web Services, with an API token plus the user's `ckWebAuthToken`. That token expires after **30 minutes**, or **2 weeks** with "Keep me signed in", with no refresh and no other auth mode (see [the constraint](providers/cloudkit.md#the-constraint-on-android-and-web)).

Plan CloudKit on Android as a user-initiated import/export. Use `googleDrive` for continuous sync.

### Sign-in flow

See [Getting a `ckWebAuthToken`](providers/cloudkit.md#getting-a-ckwebauthtoken): an Apple ID sign-in in a WebView with a custom `cloudkit-<container-id>://callback` scheme.

### No native Android module

The package ships no Android native module. CloudKit and Drive are reached over REST from JavaScript, the same code the web build uses, so auth handling and error mapping live in one place.

As a result, `icloudKV` and `icloudDocuments` (Apple OS features with no REST API) do not exist on Android. On Android, use `googleDrive` for background sync and `cloudKit` for a deliberate "bring my iPhone data over" import.

## Web

Google Drive and CloudKit both work in a browser via plain `fetch`.

`icloudKV` has no browser equivalent and rejects with `ERR_UNSUPPORTED_PLATFORM`. Branch on `isAvailable()`, or use `createCloudStore` with `googleDrive` in the provider list.

### Bundlers other than Metro

`icloudKV.web.ts` relies on Metro's platform extensions. webpack, Vite or Next.js builds of react-native-web load the native module instead, and react-native-web exports no `TurboModuleRegistry`.

This is handled: native-module resolution is defensive, and both Apple-only providers read `Platform?.OS`. On any bundler, `icloudKV` reports unavailable and `cloudKit` uses its REST path.

## Architectures

Both supported, from React Native 0.71:

- **New Architecture**: a codegen TurboModule.
- **Legacy Architecture**: an `RCTEventEmitter` bridge module.

One Swift implementation sits behind both; the `.mm` file picks a base class with `#ifdef RCT_NEW_ARCH_ENABLED` and forwards. Event names differ per architecture (`onRemoteChange` vs `remoteChange`); the JS layer hides that.

Native events that fire before the first JS listener are buffered and delivered on subscribe. They are coalesced (latest account status and transfer progress only, remote-change key lists merged) and capped at 64. On the Legacy Architecture, events that fire after every listener is removed are dropped, not replayed.

React Native 0.82 removed the Legacy Architecture, so that path matters only on 0.81 and below.

> **CI coverage.** The example app is Expo SDK 57 on React Native 0.86, which cannot run the
> Legacy Architecture. CI builds the example for the New Architecture, and separately builds
> a generated bare React Native 0.81 fixture (the last version with the Legacy Architecture)
> with this package and `RCT_NEW_ARCH_ENABLED=0`. That compiles the `#ifndef` half of the bridge.
