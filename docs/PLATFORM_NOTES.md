# Platform Notes

## Support matrix

| | iOS | macOS / Catalyst | Android | Web |
|---|:---:|:---:|:---:|:---:|
| `icloudKV` | native | native | – | – |
| `cloudKit` | native | native | REST | REST |
| `googleDrive` | REST | REST | REST | REST |

## iOS

### Entitlements

Three keys are needed. The Expo config plugin writes them; in a bare project add them by hand:

```xml
<key>com.apple.developer.icloud-container-identifiers</key>
<array><string>iCloud.com.your.app</string></array>
<key>com.apple.developer.icloud-services</key>
<array><string>CloudKit</string></array>
<key>com.apple.developer.ubiquity-kvstore-identifier</key>
<string>$(TeamIdentifierPrefix)$(CFBundleIdentifier)</string>
```

Read from entitlements at runtime, so it never needs repeating in JavaScript.

### `synchronize()` is not a round trip

`icloudKVSync()` maps to `NSUbiquitousKeyValueStore.synchronize()`. It schedules an upload and returns; it does not wait for or confirm one. A resolved promise means **queued**, not **stored**.

### Development vs Production

Separate CloudKit datastores - a debug build and a TestFlight build don't see each other's data. See [the schema](providers/cloudkit.md#development-creates-it-for-you-production-does-not).

### iCloud Drive

Needs the **CloudDocuments** service and an `NSUbiquitousContainers` Info.plist entry beyond the CloudKit entitlement - the config plugin writes both when `iCloudDocuments: true` (off by default, since it puts a folder in the user's iCloud Drive). See [iCloud Drive setup](providers/icloud-drive.md#setup) for the exact keys and the `CFBundleShortVersionString` caching gotcha.

### Mac Catalyst

Supported - Catalyst builds from the iOS slice, and both CloudKit and `NSUbiquitousKeyValueStore` are available there.

CI compiles this package's sources for the Catalyst triple (`arm64-apple-ios*-macabi`) alongside the iOS device and simulator triples, so its own code is known to be Catalyst-clean.

What CI does **not** do is build a whole app for Catalyst. React Native doesn't officially support it, so whether your app links depends on every other pod you use, not this one.

## Android

### CloudKit works, with one hard constraint

Reachable from Android over CloudKit Web Services, using an API token plus a user's `ckWebAuthToken` - which expires after **30 minutes**, or **2 weeks** with "Keep me signed in", with no refresh and no alternative auth mode. See [the constraint](providers/cloudkit.md#the-constraint-on-android-and-web) for why.

So plan CloudKit-on-Android as a deliberate, user-initiated **import/export**, not a silent always-on backup. Use `googleDrive` for continuous sync on Android.

### Sign-in flow

See [Getting a `ckWebAuthToken`](providers/cloudkit.md#getting-a-ckwebauthtoken) - the interactive Apple ID sign-in dance, via a WebView and a custom `cloudkit-<container-id>://callback` scheme, that produces the token above.

### No native Android module

This package ships no Android native module. CloudKit and Drive are both reached over REST from JavaScript, the same code path the web build uses - one implementation, two platforms, and the auth handling and error mapping, where bugs in this area actually live, exist in exactly one place.

That has a real consequence: `icloudKV` and `icloudDocuments` are Apple filesystem and OS features with no REST surface, so they don't exist on Android at any price. `cloudKit` reaches the same private database over CloudKit Web Services, but with the sign-in and token-expiry constraint above.

So on Android, `googleDrive` is the provider for continuous background sync, and `cloudKit` is the provider for a deliberate "bring my iPhone data over" import.

## Web

Google Drive and CloudKit both work in a browser; both are plain `fetch` against REST APIs.

`icloudKV` has no browser equivalent and rejects with `ERR_UNSUPPORTED_PLATFORM`. Use `isAvailable()` to branch, or route through `createCloudStore` with `googleDrive` in the provider list.

### Bundlers other than Metro

`icloudKV.web.ts` relies on Metro's platform-extension resolution. A react-native-web build served by webpack, Vite or Next.js does not do that, so it loads the native module instead - and react-native-web exports no `TurboModuleRegistry` at all.

Handled: native-module resolution is defensive, and both Apple-only providers read `Platform?.OS` rather than assuming the module shape exists. On any bundler, `icloudKV` reports unavailable and `cloudKit` falls through to its REST path.

## Architectures

Both are supported, from React Native 0.71.

- **New Architecture**: a codegen TurboModule.
- **Legacy Architecture**: an `RCTEventEmitter` bridge module.

One Swift implementation sits behind both; the `.mm` file picks a base class with `#ifdef RCT_NEW_ARCH_ENABLED` and forwards. Event names differ per architecture (`onRemoteChange` vs `remoteChange`); the JS layer handles that, so it never reaches your code.

React Native 0.82 removed the Legacy Architecture, so that path matters only on 0.81 and below.

> **CI coverage.** The example app is Expo SDK 57, pinned to React Native 0.86 - a version
> that cannot run the Legacy Architecture at all. So CI builds the example for the New
> Architecture, and separately generates a bare React Native 0.81 fixture - the last version
> that supports the Legacy Architecture - installs this package into it, and builds it with
> `RCT_NEW_ARCH_ENABLED=0`. That is what compiles the `#ifndef` half of the bridge.
