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

### Mac Catalyst

Supported - Catalyst builds from the iOS slice. Both CloudKit and `NSUbiquitousKeyValueStore` are available there.

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

## Web

Google Drive and CloudKit both work in a browser; both are plain `fetch` against REST APIs.

`icloudKV` has no browser equivalent and rejects with `ERR_UNSUPPORTED_PLATFORM`. Use `isAvailable()` to branch, or route through `createCloudStore` with `googleDrive` in the provider list.

## Architectures

Both are supported, from React Native 0.71.

- **New Architecture**: a codegen TurboModule.
- **Legacy Architecture**: an `RCTEventEmitter` bridge module.

One Swift implementation sits behind both; the `.mm` file picks a base class with `#ifdef RCT_NEW_ARCH_ENABLED` and forwards. Event names differ per architecture (`onRemoteChange` vs `remoteChange`); the JS layer handles that, so it never reaches your code.

React Native 0.82 removed the Legacy Architecture, so that path matters only on 0.81 and below.

> **CI coverage.** The example app is Expo SDK 57, which pins React Native 0.86 - a version
> that cannot run the Legacy Architecture at all. CI therefore compiles the New Architecture
> path only. The `#ifdef`'d legacy path is implemented and reviewed but not yet exercised by
> an automated build; if you are on 0.81 or below and hit a problem, please open an issue.
