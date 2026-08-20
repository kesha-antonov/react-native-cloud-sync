# Troubleshooting

## "The native module doesn't seem to be linked"

Run `pod install` and rebuild the app. Restarting Metro is not enough - the native module is compiled into the binary. Expo Go cannot load custom native modules at all; you need a development build.

## Writes appear to work but nothing reaches iCloud

Check `getAccountStatus()` first. A signed-out device accepts key-value writes locally and simply never uploads them - there is no error to catch, because nothing failed.

```ts
const status = await icloudKV.getAccountStatus()
if (status !== 'available') promptSignIn(status)
```

## `ERR_CONTAINER_MISCONFIGURED`

Either the app has no iCloud entitlement, or the container identifier in the entitlements file does not match the container that exists in the CloudKit Console. The identifier is read from entitlements at runtime, so an app-config mismatch shows up here rather than silently using the wrong container.

## `getAllKeys()` fails on CloudKit, but reads and writes work

The record type has no queryable index. `getItem`/`setItem`/`removeItem` address records by name and need none; `getAllKeys()` runs a query and does. Add a **Queryable** index on `recordName` for `KVBlob` in the CloudKit Console, and deploy it to Production - see [the schema](providers/cloudkit.md#getallkeys-needs-an-index).

`migrate()` and any "delete everything" flow are built on `getAllKeys()`, so they fail with it.

## CloudKit works in debug and fails in the release build

Development creates schema fields on first write; Production only ever gets what you explicitly **Deploy Schema Changes**. A field you never deployed does not exist there. See [the schema](providers/cloudkit.md#development-creates-it-for-you-production-does-not).

## Nothing appears on the other device

Development and Production are separate CloudKit datastores. A debug build and a TestFlight or App Store build do not share data, and a schema created in Development must be deployed to Production before a release build can use it.

Also confirm both devices are on the same iCloud account, and that the schema record type exists in the environment you are pointing at.

## Android CloudKit stops working after a while

Expected. The `ckWebAuthToken` expires after 30 minutes, or 2 weeks if the user ticked "Keep me signed in", and Apple documents no refresh. Handle `ERR_AUTH_EXPIRED` by prompting for sign-in again rather than retrying.

If it stops after exactly one request, that is a different problem - check that the token is being persisted rather than re-read from an empty store.

## The Apple ID sign-in WebView does nothing on Android

Two likely causes:

- The **Sign In Callback** in the CloudKit Console does not exactly match the scheme you intercept. Use `cloudkit-<container-id>://callback`.
- You are intercepting with `onShouldStartLoadWithRequest`, which is not dependable for Android's server-side 302 redirects. Intercept at the native page-load level instead.

## Queued writes disappear when the app restarts

The outbox defaults to in-memory. Pass `outboxStorage` backed by MMKV, or by any store with a **synchronous** `getString` - see [the outbox](store.md#making-it-durable). AsyncStorage cannot be wrapped directly, because `getString` has nowhere to await; the same section shows the cache-in-front pattern that does work.

## `getItem` returns null but the data definitely exists

`null` means the key does not exist *in the providers you configured*. Two things to check:

- Provider order. `getItem` falls through the list, but only through providers that report `isAvailable()`.
- Key mismatch. Drive keys are file names; CloudKit keys are record names. They are not automatically the same string unless you make them so.

## Reads are slow on Google Drive

Each read resolves a file name to an id. This package caches ids after the first lookup, so the second read of a key costs nothing - but a cold start pays one query per key. If you read many keys at launch, prefer one larger blob over many small ones.

## An oversized write fails locally

That is deliberate. `ERR_PAYLOAD_TOO_LARGE` carries `limitBytes` and `actualBytes`, and is raised before the request goes out. Either move that key to a larger-capacity provider, or let the [facade](store.md#tiering) route it by size.

## Everything works on iOS and nothing works on web

`icloudKV` has no browser implementation and rejects with `ERR_UNSUPPORTED_PLATFORM`. Use `isAvailable()` to branch, or route through the facade with `googleDrive` in the provider list.

## `ERR_INVALID_KEY` on a key that used to work

Key validation runs before the request now. One key string has to be an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Drive filename at once, and the three disagree - `settings/theme` is fine for the first two and illegal as a record name.

Rename the key, run it through `sanitizeKey`, or pass `validateKeys: false` if you are certain. The alternative is what happened before: CloudKit answers `BAD_REQUEST`, which maps to `ERR_CONTAINER_MISCONFIGURED`, and you spend an afternoon on your entitlements.

## `getItem` throws `ERR_NOT_SIGNED_IN` where it used to return null

Intentional, and the reason is in [absent vs broken](errors.md#distinguishing-absent-from-broken). `null` now means only "at least one provider answered and none had this key". When *nothing* was reachable you get an error, because code that branches on `null` by seeding fresh state would otherwise overwrite a signed-out user's real backup.

If you genuinely want the old behaviour at one call site, catch it:

```ts
const value = await store.getItem(key).catch(() => null)
```

Think about what that call site does with `null` first.

## Queued writes vanish after the user switches account

Also intentional. An outbox entry carries no account identity, so flushing it after an Apple ID or Google account change would write the previous user's data into the new user's account. The store drops the queue on `identityChanged` and reports each entry through `onDropped` with reason `accountChanged`.

Write local-first if those writes need to survive: keep the value in MMKV, and re-queue it against the new account if it still belongs there.

## A transfer hangs forever

React Native's `fetch` has no timeout of its own. The REST clients now default to 30s (CloudKit) and 60s (Drive), and `createCloudStore({ timeoutMs })` bounds native calls too.

`ERR_TIMEOUT` means the wait was abandoned, not that the operation failed - it may still be in flight, which is why it is retryable and why the outbox holds it.

## The iCloud Drive folder does not appear in Files.app

Entitlements alone get files syncing but leave the folder invisible. You also need the `NSUbiquitousContainers` Info.plist entry - the config plugin writes it when `iCloudDocuments: true`.

If it is present and the folder still does not show, bump `CFBundleShortVersionString`: iOS caches that plist entry and only re-reads it when the app version changes.

## An iCloud Drive file reads as empty

It is a placeholder. The file exists in the account but has no local bytes on this device, and opening the path gives you nothing rather than an error. Call `icloudDocuments.fetch({ name })` first - see [iCloud Drive](providers/icloud-drive.md#fetch-before-you-read).
