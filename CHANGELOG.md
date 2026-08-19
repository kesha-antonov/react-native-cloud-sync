# Changelog

## v0.1.0

Initial release.

### ✨ Features

- **Three providers behind one API.** `icloudKV` wraps `NSUbiquitousKeyValueStore`,
  `cloudKit` wraps the CloudKit private database, and `googleDrive` wraps Drive's
  hidden `appDataFolder`. Each is usable directly, or through `createCloudStore`,
  which adds size tiering, a durable outbox, provider migration and read
  fallthrough.
- **CloudKit from Android and the web.** The same private database an iOS app
  writes to, reached over CloudKit Web Services. The REST client is shared by
  both platforms and needs no crypto, so it avoids the missing-`crypto` problem
  that stalled earlier CloudKit JS attempts in React Native.
- **A typed error contract.** Every failure rejects with a `CloudSyncError`
  carrying a stable `code`, plus `retryAfterMs`, `limitBytes`/`actualBytes` or
  `serverValue` where relevant. `null` is returned for exactly one condition -
  the key does not exist. `isRetryable()` and `requiresUserAction()` classify a
  failure so callers can decide between a silent retry and a user prompt.
- **Full account lifecycle.** All five `CKAccountStatus` values rather than a
  boolean, plus `onAccountChange` with an `identityChanged` flag so an Apple ID
  switch can invalidate user-scoped caches, and `onRemoteChange` with typed
  reasons so another device's write arrives without polling.
- **Automatic size tiering.** Values are routed to the key-value store, a
  CloudKit record field or a chunked `CKAsset` by size, so store limits stop
  leaking into product code.
- **Both React Native architectures**, from 0.71. A single Swift implementation
  sits behind an `#ifdef`'d Objective-C++ bridge that selects a codegen
  TurboModule base class or an `RCTEventEmitter` bridge module.
- **A real testing story.** `createMemoryProvider` is an in-memory provider with
  fault injection, exported from the package as `/testing` and documented, so
  signed-out, offline, quota-exceeded, rate-limited and account-switch paths are
  all testable in Jest without a device.

### 🏗️ Architecture Notes

- Native events are buffered until JavaScript binds its listener. Without this,
  an `NSUbiquityIdentityDidChange` that fires during startup reaches an
  unbound codegen `std::function` and aborts the process - a crash reported
  independently three times against another library in this space.
- No Android native module ships. CloudKit and Drive are both reached over REST
  from TypeScript, which is the same code the web build runs, keeping the auth
  handling and error mapping in exactly one place.
