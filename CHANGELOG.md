# Changelog

## 0.2.0 - 2026-08-20

- **`resolveByUnion`** - a resolver for JSON arrays where two devices adding
  *different* elements between syncs should both survive, rather than one
  write clobbering the other (a list of favorited item ids, dismissed-tip ids).
  `resolveByTimestamp` and `resolveByModifiedAt` pick one candidate whole;
  this instead merges every candidate's array, deduplicated and ordered by
  first appearance, with a `key` option for deduplicating arrays of objects.
  Deletions do not propagate - a plain array has no tombstones - and a
  candidate that is not a JSON array is dropped rather than treated as empty.

## 0.1.0 - 2026-08-20

First release.

### ✨ Features

- **`cloudKitEncrypted`** - CloudKit's own end-to-end encryption, via
  `CKRecord.encryptedValues`. Values are encrypted on device with a key from the
  user's iCloud Keychain, so Apple stores ciphertext and holds no key, and there
  is nothing for the app to manage. Apple platforms only, permanently: the key
  never reaches Apple's servers, so CloudKit Web Services cannot decrypt either.
  Writes to its own record type (`EncryptedKVBlob`) because CloudKit records
  encryption in the schema, so it cannot share `cloudKit`'s.
- **`destinationUri` on `cloudKitAssets.fetch` and `cloudKitBackup.restore`.**
  They used to write into the app's temporary directory under a name derived
  from the record - which iOS may reclaim, and which the user cannot reach - so
  there was no way to fetch a backup somewhere it could be handed to a share
  sheet or a "Save to Files" flow. `googleDriveFiles.fetch` and
  `icloudDocuments.fetch` already took a destination; these now match. Parent
  directories are created.
- **`store.getAllItems()`** - keys and values as one object, the shape every
  key-value library being migrated from exposes and the one a debug screen or
  a data export actually wants.
- **`icloudKVGetAllItems()`** - every key and value in the iCloud key-value
  store in one bridge hop, rather than `getAllKeys()` plus a read per key. Not
  on the provider contract, because no other backend can do it without fetching
  every record.
- **`icloudDocuments`** - files in the user's own iCloud Drive, visible in
  Files.app. The one thing no `CKRecord` or `CKAsset` API can do: a `CKAsset`
  lives in a private database the user cannot see, open or share. Apple
  platforms only, since iCloud Drive has no REST surface. The config plugin
  gains `iCloudDocuments`, which writes both the `CloudDocuments` entitlement
  and the `NSUbiquitousContainers` Info.plist entry that makes the folder
  actually appear.
- **Batch operations** - `multiGet`, `multiSet`, `multiRemove` and `clear` on
  the store, and `getRecords`/`saveRecords`/`deleteRecords` on the CloudKit REST
  client. `/records/lookup` and `/records/modify` have always taken arrays, so
  reading 200 keys was 200 round trips and 200 chances to be throttled.
- **React hooks**, from `react-native-cloud-sync/hooks`: `useCloudItem`,
  `useAccountStatus`, `usePendingWrites`, `useRemoteChange`, `useQuota`. A
  separate entry point so the main one stays free of a React import.
- **Automatic outbox draining** - `autoFlush` flushes on app foreground and on a
  timer. Deliberately not network-aware, so the package does not force a NetInfo
  dependency on every consumer.
- **`onRemoteChange` / `onAccountChange` on the facade**, merging every
  configured provider - previously only raw providers exposed them, so the
  recommended entry point could not be subscribed to at all.
- **Google Drive change detection** - `googleDrive.onRemoteChange` polls Drive's
  change cursor, so a non-Apple platform can learn that another device wrote.
  Polling starts with the first subscriber and stops with the last.
- **`resolveByModifiedAt`** - resolves on the *server's* modification time,
  which CloudKit and Drive both report and which this package now reads. Removes
  the requirement that values be JSON carrying a timestamp field you remembered
  to update. `resolveFirstOf` composes it with `resolveByTimestamp` for a fleet
  that includes `icloudKV`, which has no per-key timestamp at all.
- **`getQuota()`** - storage usage from Drive's `about.get` and from the iCloud
  key-value store against its 1 MB ceiling.
- **Cancellation** - `ERR_CANCELLED` finally has a producer. `cloudKitAssets.cancel`
  and `cloudKitBackup.cancel` cancel a native `CKOperation`; `googleDriveFiles`
  takes an abort signal, checked between chunks so it lands during the transfer.
- **Timeouts** - `timeoutMs` on the store and on both REST clients. React
  Native's `fetch` has none of its own, so an unanswered socket hung the
  operation forever - including `isAvailable()`, which runs before everything
  else. `ERR_TIMEOUT` is retryable, so a hung write is queued rather than lost.
- **Key validation** - one key has to be an `NSUbiquitousKeyValueStore` key, a
  CloudKit `recordName` and a Drive filename at once. Illegal keys now raise
  `ERR_INVALID_KEY` before the request instead of returning as `BAD_REQUEST` ->
  `ERR_CONTAINER_MISCONFIGURED`, which sent people to look at their
  entitlements. `sanitizeKey` is exported for keys you do not control.
- **[Encryption guide](docs/encryption.md)** - what each backend already
  encrypts and under whose keys, why Drive's `appDataFolder` is obscurity rather
  than confidentiality, and how to hold your own key.
- **`codec`** - a two-way value transform, the seam for encrypting at rest.
  Drive's `appDataFolder` is plaintext to anything holding the OAuth token. No
  cipher is bundled: key management is the part that decides whether this is
  worth anything.
- **Conditional CloudKit writes** - `saveRecordIfUnchanged` sends the record
  change tag, so a genuine concurrent edit raises `ERR_CONFLICT` with
  `serverValue` instead of being silently clobbered. That error previously could
  not fire, which made the documented merge path unreachable.
- **More than one account** - `createGoogleDriveProvider` and
  `createCloudKitProvider` return providers that own their credentials, instead
  of reading a process-wide singleton.
- **The iCloud key-value store's other two limits are enforced.** Only the 1 MB
  per-key ceiling was checked; the 1 MB *total* and the 1024-key cap were not,
  and those are the ones that actually bite - exceeding them is silent.
- **Availability memoisation** - `isAvailable()` was called for every provider
  before every operation, which is a bridge hop for `icloudKV` and a
  `getAccessToken` call for `googleDrive`. Now cached for `availabilityTtlMs`
  (3s default).
- **`migrate()` reports what happened** - `copied` / `skipped` / `failed`, plus
  `filter`, `onProgress` and `continueOnError`. It no longer aborts on the first
  bad key, which left the user half migrated with no record of how far it got.
- **`discardPendingWrites()`**, so a "pending sync" UI can let the user give up
  on a stuck write.
- **The Jest native mock ships** as `react-native-cloud-sync/jest-mock`. The
  testing docs pointed at a file that was never in `files`.
- **The in-memory provider gained** `available`, `name`, `quota`, per-key faults
  (`only`), `setAvailable()` and `cacheClears` - enough to test the signed-out
  fleet, multi-provider tiering and account switches.

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
- **`cloudKitAssets.fetch`/`cloudKitBackup.restore` report download progress.**
  The native download used a plain completion-handler fetch with no progress
  callback at all, so a large asset (a database export, say) gave no signal
  until the whole transfer had already landed. It now reports real byte
  progress from the first callback, using a size the upload side stashes
  alongside the asset.

- **`cloudKitBackup`** - a `save`/`restore` helper built on `cloudKitAssets`
  for the common single-blob case (a database export, an archive), with
  progress scoped to just that transfer instead of the global, unfiltered
  `cloudKitAssets.onProgress` feed. See
  [the CloudKit guide](docs/providers/cloudkit.md#backuprestore-helper).
- **`googleDriveFiles`** - the Android/web equivalent of `cloudKitAssets`, for
  a file too large to hold in memory as a JS string the way `googleDrive.setItem`
  does. Uploads with Drive's resumable protocol and reads/writes in fixed
  chunks (8 MiB by default, configurable), so a 500 MB transfer never sits in
  memory whole and a chunk that drops mid-flight is retried against Drive's
  real offset instead of restarting from byte 0. Reads and writes go through a
  `GoogleDriveFileAdapter` you supply via the new `configureGoogleDriveFiles` -
  this package still has no filesystem dependency of its own. See
  [the Google Drive guide](docs/providers/google-drive.md#large-files) and
  [the cross-platform recipe](docs/recipes.md#cross-platform-large-file-backup)
  for pairing it with `cloudKitBackup`.
- **`bytesToBase64`/`base64ToBytes` are exported.** The
  `GoogleDriveFileAdapter` contract is base64 in and base64 out, while every
  modern filesystem API is byte-oriented - so the codec that bridges them now
  ships from the package entry rather than making each adapter author find one.
  Dependency-free and Hermes-safe, which `Buffer` and `atob`/`btoa` are not.
- **`WriteMode` is exported.** It is the type of `CloudStoreOptions.writeMode`,
  so callers threading the value through their own functions had to re-declare
  the union by hand.

### 🛡️ Correctness

Failure modes found and closed while building this, listed because they are the
exact paths this package exists to keep shut - and because most of them are
still live in the libraries it replaces. "Previously" here means earlier in this
repository's own history, not in any published version.

- **Google Drive picked arbitrarily between files sharing a name.** Drive names
  are not unique - it is a file store with ids - so two devices creating the
  same key while both are offline genuinely produce two files, and the list
  order Drive returns is unspecified. Taking the first match let two devices
  settle on different files and diverge permanently with nothing reported
  anywhere. Now ordered by modification time with the id as a tiebreak, so
  every device agrees; `onDuplicateName: 'error'` raises `ERR_CONFLICT`
  instead.
- **`cloudKit.onRemoteChange` accepted listeners it could never call.** The only
  `remoteChange` the native layer emits is tagged `icloudKV`, and the filter
  looked for `cloudKit` - so it was a subscription that silently never fired,
  which a caller cannot tell apart from "nothing has changed". Removed rather
  than faked: `cloudKit.onRemoteChange` is now `undefined` and checkable.
  Implementing it needs a custom zone (the default zone has no change tokens)
  or an APNs `CKDatabaseSubscription`.
- **An account change was delivered twice.** `icloudKV` and `cloudKit` both
  observe the same two system notifications and relabel them, so a store
  configured with both handed one system event to app listeners twice.
- **Key validation applied CloudKit's rules to every provider.** The record-name
  alphabet and the reserved `_` prefix are CloudKit restrictions;
  `NSUbiquitousKeyValueStore` keys are plain strings with no character rules,
  and Drive file names are nearly as permissive. Checking them unconditionally
  rejected keys that had been in production for years - a real app syncing only
  through the key-value store uses `auth/anonymousUserId/v1`, which would have
  started throwing `ERR_INVALID_KEY`. Every rule is now scoped to the provider
  that imposes it.
- **The `codec` documentation had the ordering backwards.** It said encoding ran
  after tiering picked a destination; it runs before, so a value is routed by
  the size it will actually occupy. The behaviour was right, the docs were
  wrong, and the difference matters for anyone sizing an inflating cipher
  against `kvMaxBytes`. Now pinned by tests.
- **`cloudKitEncrypted` was missing from the store's built-in provider map**,
  so naming it in `providers` raised "Unknown provider" - caught by its own
  test before release.
- **`store.getItem()` no longer resolves `null` when nothing was reachable.**
  `null` is documented as meaning "the key does not exist" and nothing else, and
  the first-launch recipe branches on it by seeding empty state - so a
  signed-out user took that branch and overwrote their real backup on the next
  write. When no configured provider is available the read now raises
  `ERR_NOT_SIGNED_IN`, matching what `setItem` and `removeItem` already did.
  `null` still means an absent key whenever at least one provider answered.
- **A queued write can no longer overwrite a newer successful one.** An offline
  `setItem(k, v1)` queued v1; a later online `setItem(k, v2)` succeeded
  directly; the next flush wrote v1 back over v2. A successful write or delete
  now invalidates anything queued for the same key and provider.
- **`flushOutbox()` no longer loses writes enqueued while it is running.** It
  snapshotted the queue, awaited the network, then wrote the snapshot back
  wholesale - discarding anything that failed and enqueued itself in between.
  It now merges, and two concurrent flushes join rather than each re-sending
  every entry.
- **`mirror` plus tiering no longer strands a stale copy.** A value that grew
  past `kvMaxBytes` was written to the larger providers and *skipped* on the
  key-value store, which kept the older, smaller copy - and reads prefer that
  provider, so `getItem` served the stale value forever. The skipped provider's
  copy is now removed, once the new value has landed somewhere. Read repair does
  the same instead of silently leaving a copy it could not overwrite.
- **An account switch no longer leaks state into the next account.** On
  `identityChanged` the store drops memoised availability, calls `clearCaches()`
  on every provider (Drive file ids, CloudKit reachability), and abandons the
  outbox - a queued entry carries no account identity, so flushing after a
  switch wrote the previous user's data into the new user's account.
- **The outbox is bounded.** It had no cap, no maximum attempts and no maximum
  age, and every enqueue rewrites the whole blob - so a long offline stretch
  degraded the write path itself. Now `outboxMaxEntries` / `outboxMaxAttempts` /
  `outboxMaxAgeMs`, with every abandoned entry reported through `onDropped`
  rather than vanishing.
- **`cloudKit.isAvailable()` no longer throws on a web build served by a
  non-Metro bundler.** webpack, Vite and Next.js do not resolve the `.web.ts`
  platform extension, and react-native-web exports no `TurboModuleRegistry`, so
  the lookup was a TypeError inside a method documented as safe on a render
  path.
- **`byteLength` no longer relies on `unescape`,** which is deprecated and
  absent in some runtimes.

### 📚 Documentation

- **The CloudKit schema is documented.** Record type `KVBlob`, a `value` String
  field, and an Asset plus `<fieldName>__size` Int per asset field. Nothing said
  what to create in the CloudKit Console, which is the difference between an app
  that works in debug and one that fails on release - Development adds fields on
  first write, Production only ever gets what you deploy.
- **`getAllKeys()` needs a queryable `recordName` index.** It runs a real query
  where the other operations address records by name, and the CloudKit guide
  previously implied no index was needed at all. `migrate()` and any
  delete-everything flow are built on it, so they fail with it.
- **The `expo-file-system` adapter example targets the modern API.** It was
  written against `getInfoAsync`/`readAsStringAsync`, which SDK 54 moved out of
  the default entry point - so it did not run on the SDK the example app pins.
  Now uses `File`/`FileHandle` with a seekable offset.
- **`outboxStorage` must be synchronous.** Three pages suggested an
  AsyncStorage-backed adapter, which cannot satisfy an interface whose
  `getString` returns a string rather than a promise. MMKV is the recommendation.
- **A store with no providers rejects writes** with `ERR_NOT_SIGNED_IN`, which
  is the wrong thing to show someone who turned sync off deliberately. The
  provider-picker recipes now branch before calling instead.
- **The example app has a Files tab** covering large-file backup and restore on
  both paths, including a working `GoogleDriveFileAdapter` - the one API that
  needs host-supplied I/O had no runnable reference.
- **CI checks documentation links and exports.** `yarn check:links` proves every
  internal link, every README link into the published site, and every public
  export still resolves; the site build now throws on a broken anchor rather
  than warning.


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
