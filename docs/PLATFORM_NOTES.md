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

The container identifier is read from the app's entitlements at runtime, so it never needs repeating in JavaScript - and cannot drift out of sync.

### `synchronize()` is not a round trip

`icloudKVSync()` maps to `NSUbiquitousKeyValueStore.synchronize()`. It schedules an upload and returns; it does not wait for or confirm one. A resolved promise means **queued**, not **stored**.

### Development vs Production

CloudKit keeps entirely separate datastores for Development and Production. A debug build and a TestFlight build do not see each other's data, and a schema created in Development must be deployed to Production before a release build can use it.

### iCloud Drive

The `icloudDocuments` provider needs two things the CloudKit entitlement does not give you: the **CloudDocuments** service on the container, and an `NSUbiquitousContainers` Info.plist entry with `NSUbiquitousContainerIsDocumentScopePublic`. Without the first, the container URL resolves to nil at runtime; without the second, files sync but the folder never appears in Files.app.

The config plugin writes both when `iCloudDocuments: true` - off by default, because turning it on puts a folder for your app in the user's iCloud Drive and that should be deliberate. Raw keys are in [iCloud Drive](providers/icloud-drive.md#setup).

iOS caches `NSUbiquitousContainers` and re-reads it only when `CFBundleShortVersionString` changes, so bump the version when you add it.

### Mac Catalyst

Supported - Catalyst builds from the iOS slice, and both CloudKit and `NSUbiquitousKeyValueStore` are available there.

CI compiles this package's sources for the Catalyst triple (`arm64-apple-ios*-macabi`) alongside the iOS device and simulator triples, so its own code is known to be Catalyst-clean.

What CI does **not** do is build a whole app for Catalyst. React Native does not officially support Catalyst, so whether your app links depends on every other pod you use, not on this one - apps that ship Catalyst generally carry their own Podfile repairs for pods that omit a Catalyst slice.

## Android

### CloudKit works, with one hard constraint

The private database is reachable from Android over CloudKit Web Services, using an API token plus a user's `ckWebAuthToken`. That token expires after **30 minutes**, or **2 weeks** if the user ticks "Keep me signed in" during sign-in. Apple documents no refresh mechanism.

There is no alternative auth mode:

- A **server-to-server key reaches only the public database**. Apple: *"Use a server-to-server key to access the public database of a container as the developer who created the key."*
- **Sign in with Apple is not linked to CloudKit.** Per Apple DTS: *"The unique user identifiers for Sign in with Apple and CloudKit are not linked."*

So plan CloudKit-on-Android as a deliberate, user-initiated **import/export**, not a silent always-on backup. Use `googleDrive` for continuous sync on Android.

### Sign-in flow

1. `GET /database/1/<container>/<env>/public/users/caller?ckAPIToken=<token>`
2. That returns **HTTP 421** with a `redirectURL` in a top-level error dict.
3. Load `redirectURL` in a WebView.
4. Intercept the callback and read `ckWebAuthToken` from the query string.

Set the Sign In Callback in the CloudKit Console to `cloudkit-<container-id>://callback`. A custom scheme is intercepted far more reliably than an `https` URL - `onShouldStartLoadWithRequest` is not dependable for Android's server-side 302s.

### No native Android code

This package ships no Android native module. CloudKit and Drive are both reached over REST from JavaScript, which is the same code path the web build uses. One implementation, two platforms - and the auth handling and error mapping, where bugs in this area actually live, exist in exactly one place.

### No native Android module, and what that costs

Repeating the summary above because it is the thing people are surprised by: `icloudKV` and `icloudDocuments` are Apple filesystem and OS features with no REST surface, so they do not exist on Android at any price. `cloudKit` reaches the *same private database* over CloudKit Web Services, but needs an interactive Apple ID sign-in whose token lasts 30 minutes - or two weeks if the user ticked "Keep me signed in" - with no documented refresh.

So on Android, `googleDrive` is the provider for continuous background sync, and `cloudKit` is the provider for a deliberate "bring my iPhone data over" import. Building an always-on Android backup on CloudKit means asking the user to re-authenticate every fortnight, forever.

## Web

Google Drive and CloudKit both work in a browser; both are plain `fetch` against REST APIs.

`icloudKV` has no browser equivalent and rejects with `ERR_UNSUPPORTED_PLATFORM`. Use `isAvailable()` to branch, or route through `createCloudStore` with `googleDrive` in the provider list.

### Bundlers other than Metro

`icloudKV.web.ts` relies on Metro's platform-extension resolution. A react-native-web build served by webpack, Vite or Next.js does not do that, so it loads the native module instead - and react-native-web exports no `TurboModuleRegistry` at all.

Handled: native-module resolution is defensive, and both Apple-only providers read `Platform?.OS` rather than assuming the module shape exists. On any bundler, `icloudKV` reports unavailable and `cloudKit` falls through to its REST path. You do not need a resolver alias, though one still gives you the smaller bundle.

## Architectures

Both are supported, from React Native 0.71.

- **New Architecture**: a codegen TurboModule.
- **Legacy Architecture**: an `RCTEventEmitter` bridge module.

One Swift implementation sits behind both; the `.mm` file picks a base class with `#ifdef RCT_NEW_ARCH_ENABLED` and forwards. Event names differ per architecture (`onRemoteChange` vs `remoteChange`); the JS layer handles that, so it never reaches your code.

React Native 0.82 removed the Legacy Architecture, so that path matters only on 0.81 and below.

> **CI coverage.** The example app is Expo SDK 57, which pins React Native 0.86 - a version
> that cannot run the Legacy Architecture at all. So CI builds the example for the New
> Architecture, and separately generates a bare React Native 0.81 fixture - the last version
> that supports the Legacy Architecture - installs this package into it, and builds it with
> `RCT_NEW_ARCH_ENABLED=0`. That is what compiles the `#ifndef` half of the bridge.
