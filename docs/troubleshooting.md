# Troubleshooting

## "The native module doesn't seem to be linked"

Run `pod install` and rebuild; restarting Metro isn't enough. Expo Go can't load custom native modules, so use a development build.

## Writes appear to work but nothing reaches iCloud

Check `getAccountStatus()`. A signed-out device accepts writes locally but never uploads them, with no error.

```ts
const status = await icloudKV.getAccountStatus()
if (status !== 'available') promptSignIn(status)
```

## `ERR_CONTAINER_MISCONFIGURED`

Natively, check in order:

1. `Info.plist` has `RNCloudSyncContainerIdentifier`. Without it CloudKit is disabled. The Expo config plugin writes it; bare projects add it by hand ([Platform Notes](PLATFORM_NOTES.md#entitlements)).
2. The app has the iCloud entitlement.
3. The container identifier matches the container in the CloudKit Console.

Over REST, CloudKit's `ACCESS_DENIED` also maps here: the user lacks rights to the record type, zone or database. Check the security roles in the Console; signing in again won't help.

## `getAllKeys()` fails on CloudKit, but reads and writes work

The record type has no queryable index. Add a **Queryable** index on `recordName` for `KVBlob` in the CloudKit Console and deploy it to Production ([the schema](providers/cloudkit.md#getallkeys-needs-an-index)). `migrate()` and `clear()` use `getAllKeys()` and fail too.

## CloudKit works in debug and fails in the release build

Development creates schema fields on first write; Production only has what you **Deploy Schema Changes**. See [the schema](providers/cloudkit.md#development-creates-it-for-you-production-does-not).

## Nothing appears on the other device

Check that both devices use the same iCloud account and the same environment (Development and Production are separate datastores), and that the record type exists there.

## Android CloudKit stops working after a while

Expected: see [the constraint](providers/cloudkit.md#the-constraint-on-android-and-web). On `ERR_AUTH_EXPIRED`, prompt for sign-in instead of retrying.

If it stops after exactly one request, check that the token is persisted, not re-read from an empty store.

## The Apple ID sign-in WebView does nothing on Android

- The **Sign In Callback** in the CloudKit Console must exactly match the scheme you intercept: `cloudkit-<container-id>://callback`.
- `onShouldStartLoadWithRequest` misses Android's server-side 302 redirects. Intercept at the native page-load level instead.

## Queued writes disappear when the app restarts

The outbox defaults to in-memory. Pass `outboxStorage` backed by MMKV or another **synchronous** store; see [the outbox](store.md#making-it-durable).

## `getItem` returns null but the data definitely exists

`null` means the key doesn't exist in the configured providers. Check:

- Availability: `getItem` only falls through providers where `isAvailable()` is true.
- Key names: Drive keys are file names, CloudKit keys are record names. Make sure you use the same string.

## Reads are slow on Google Drive

File ids are cached after the first lookup, but a cold start pays one query per key. For many keys at launch, prefer one larger blob. See [Performance notes](providers/google-drive.md#performance-notes).

## An oversized write fails locally

By design: `ERR_PAYLOAD_TOO_LARGE` (with `limitBytes` and `actualBytes`) is raised before the request. Use a larger provider, or let the [facade](store.md#tiering) route by size.

## Everything works on iOS and nothing works on web

`icloudKV` has no browser implementation and rejects with `ERR_UNSUPPORTED_PLATFORM`. Branch on `isAvailable()`, or use the facade with `googleDrive` in the list.

## `ERR_INVALID_KEY` on a key that used to work

Keys are now validated before the request against every configured provider. `settings/theme` is fine for the key-value store but illegal as a CloudKit record name ([keys](store.md#keys)).

Rename the key, run it through `sanitizeKey`, or pass `validateKeys: false`.

## `getItem` throws `ERR_NOT_SIGNED_IN` where it used to return null

Intentional: see [absent vs broken](errors.md#distinguishing-absent-from-broken). `null` now means "at least one provider answered and none had the key". When nothing was reachable, you get an error.

To restore the old behaviour at one call site:

```ts
const value = await store.getItem(key).catch(() => null)
```

First check what that call site does with `null`.

## Queued writes vanish after the user switches account

Intentional: see [account switches](store.md#account-switches). Outbox entries carry no account identity, so they are dropped on `identityChanged` instead of flushed into the new account.

If those writes must survive, keep the value locally (MMKV) and write it again for the new account if it still belongs there.

## A transfer hangs forever

React Native's `fetch` has no timeout. The REST clients default to 30s (CloudKit) and 60s (Drive); `createCloudStore({ timeoutMs })` also bounds native calls.

`ERR_TIMEOUT` means the wait was abandoned; the operation may still be in flight, so it is retryable.

## The iCloud Drive folder does not appear in Files.app

Entitlements alone sync files but leave the folder hidden. Add the Info.plist entry from [iCloud Drive setup](providers/icloud-drive.md#setup), and mind the `CFBundleShortVersionString` caching gotcha there.

## An iCloud Drive file reads as empty

It's a placeholder: the file exists in the account but isn't downloaded to this device. Call `icloudDocuments.fetch({ name })` first; see [iCloud Drive](providers/icloud-drive.md#fetch-before-you-read).
