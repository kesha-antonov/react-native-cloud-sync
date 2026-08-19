# Changelog

## Unreleased

### 🐛 Bug Fixes

- **A read no longer destroys a newer copy it failed to fetch.** With a
  `resolve` function, read repair wrote the winner back to every provider the
  read had *asked*, including one whose `getItem` threw. If the provider that
  blipped held the newer value, a transient network error silently overwrote it.
  Only providers that actually answered are repaired now.
- **Native error detail reaches JavaScript.** React Native nests an `NSError`'s
  dictionary under `e.userInfo` rather than spreading it, so `retryAfterMs`,
  `limitBytes`, `actualBytes` and `serverValue` were all dropped on iOS. The
  outbox therefore ignored CloudKit's `retryAfter` hint, and a `ERR_CONFLICT`
  never carried the `serverValue` it is documented to carry.
- **A mirrored `removeItem` with no provider available now rejects** with
  `ERR_NOT_SIGNED_IN` instead of resolving successfully having deleted nothing.
- **`getAllKeys()` no longer truncates.** Neither the CloudKit REST client nor
  the native `CKQueryOperation` path followed the pagination handle
  (`continuationMarker` / query cursor), so both stopped at the first page.
  Since `migrate()` is built on `getAllKeys()`, a migration could quietly copy
  part of the data and report success.
- **`tiering.recordMaxBytes` is honoured.** It was documented and defaulted but
  never read, so the threshold did nothing.
- **A Google Drive file deleted from another device recovers.** File ids are
  memoised, and a stale one surfaced as `ERR_UNKNOWN` forever because nothing
  evicted it - the key became permanently unreadable and unwritable. A 404 now
  drops the memo, re-resolves the name, and reports a genuine absence as `null`.
- **The outbox drops a queued write that starts failing for a reason the user
  must act on**, after reporting it through `onError`. Re-queueing it retried
  forever, never drained and never surfaced, which is the opposite of what
  `setItem` does with the same failure.
- **CloudKit's `isAvailable()` is memoised on Android and web.** It is
  documented as safe on a render path, and the store calls it before every
  provider read - so the unmemoised probe doubled the request count of every
  `getItem`.
- **Events keep firing after a reload (iOS).** React Native briefly holds two
  module instances; the outgoing one's `dealloc` tore down the *replacement's*
  emit callback and notification observers.
- **`getConstants().hasICloudEntitlement` can be false.** It was derived from an
  identifier that falls back to `iCloud.<bundle id>`, so it was `true` for every
  app with a bundle id - including one with no iCloud capability at all.
- **The Expo config plugin merges `icloud-container-identifiers`** instead of
  overwriting it, so a container the app already declared is no longer dropped.

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
- **Automatic size tiering.** Values are routed to the key-value store or a
  CloudKit record field by size, so store limits stop leaking into product code.
  Binary assets are a separate explicit API - you pass a file path, not a
  string, so there is nothing for `setItem` to infer.
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
