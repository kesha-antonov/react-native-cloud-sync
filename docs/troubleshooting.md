# Troubleshooting

## "The native module doesn't seem to be linked"

Run `pod install` and rebuild - restarting Metro isn't enough. Expo Go can't load custom native modules; you need a development build.

## Writes appear to work but nothing reaches iCloud

Check `getAccountStatus()` first - a signed-out device accepts writes locally but never uploads them, and nothing failed, so there's no error to catch.

```ts
const status = await icloudKV.getAccountStatus()
if (status !== 'available') promptSignIn(status)
```

## `ERR_CONTAINER_MISCONFIGURED`

Either the app has no iCloud entitlement, or the container identifier in the entitlements file doesn't match the container that exists in the CloudKit Console.

## `getAllKeys()` fails on CloudKit, but reads and writes work

The record type has no queryable index. Add a **Queryable** index on `recordName` for `KVBlob` in the CloudKit Console, and deploy it to Production - see [the schema](providers/cloudkit.md#getallkeys-needs-an-index). `migrate()` and any "delete everything" flow are built on `getAllKeys()`, so they fail with it too.

## CloudKit works in debug and fails in the release build

Development creates schema fields on first write; Production only ever gets what you explicitly **Deploy Schema Changes**. A field you never deployed does not exist there. See [the schema](providers/cloudkit.md#development-creates-it-for-you-production-does-not).

## Nothing appears on the other device

Same root cause as above (separate datastores) - also confirm both devices are on the same iCloud account, and that the schema record type exists in the environment you are pointing at.

## Android CloudKit stops working after a while

Expected - see [the constraint](providers/cloudkit.md#the-constraint-on-android-and-web). Handle `ERR_AUTH_EXPIRED` by prompting for sign-in again rather than retrying.

If it stops after exactly one request, that is a different problem - check that the token is being persisted rather than re-read from an empty store.

## The Apple ID sign-in WebView does nothing on Android

Two likely causes:

- The **Sign In Callback** in the CloudKit Console doesn't exactly match the scheme you intercept. Use `cloudkit-<container-id>://callback`.
- You're intercepting with `onShouldStartLoadWithRequest`, which isn't dependable for Android's server-side 302 redirects. Intercept at the native page-load level instead.

## Queued writes disappear when the app restarts

The outbox defaults to in-memory. Pass `outboxStorage` backed by MMKV, or by any store with a **synchronous** `getString` - see [the outbox](store.md#making-it-durable) for why AsyncStorage needs a cache-in-front wrapper instead.

## `getItem` returns null but the data definitely exists

`null` means the key does not exist *in the providers you configured*. Two things to check:

- Provider order. `getItem` falls through the list, but only through providers that report `isAvailable()`.
- Key mismatch. Drive keys are file names; CloudKit keys are record names. They are not automatically the same string unless you make them so.

## Reads are slow on Google Drive

See [Performance notes](providers/google-drive.md#performance-notes) - ids are cached after the first lookup, but a cold start pays one query per key. Reading many keys at launch? Prefer one larger blob over many small ones.

## An oversized write fails locally

Deliberate: `ERR_PAYLOAD_TOO_LARGE` carries `limitBytes` and `actualBytes`, raised before the request goes out. Move that key to a larger-capacity provider, or let the [facade](store.md#tiering) route it by size.

## Everything works on iOS and nothing works on web

`icloudKV` has no browser implementation and rejects with `ERR_UNSUPPORTED_PLATFORM`. Use `isAvailable()` to branch, or route through the facade with `googleDrive` in the provider list.

## `ERR_INVALID_KEY` on a key that used to work

Key validation now runs before the request. One key string has to be an `NSUbiquitousKeyValueStore` key, a CloudKit `recordName` and a Drive filename at once, and the three disagree - `settings/theme` is fine for the first two and illegal as a record name.

Rename the key, run it through `sanitizeKey`, or pass `validateKeys: false` if you are certain.

## `getItem` throws `ERR_NOT_SIGNED_IN` where it used to return null

Intentional - see [absent vs broken](errors.md#distinguishing-absent-from-broken). `null` now means only "at least one provider answered and none had this key"; when *nothing* was reachable you get an error instead.

If you genuinely want the old behaviour at one call site, catch it:

```ts
const value = await store.getItem(key).catch(() => null)
```

Think about what that call site does with `null` first.

## Queued writes vanish after the user switches account

Also intentional - see [account switches](store.md#account-switches): an outbox entry carries no account identity, so it's dropped on `identityChanged` rather than flushed into the new account.

Write local-first if those writes need to survive: keep the value in MMKV, and re-queue it against the new account if it still belongs there.

## A transfer hangs forever

React Native's `fetch` has no timeout of its own - the REST clients default to 30s (CloudKit) and 60s (Drive), and `createCloudStore({ timeoutMs })` bounds native calls too.

`ERR_TIMEOUT` means the wait was abandoned, not that the operation failed - it may still be in flight, which is why it is retryable.

## The iCloud Drive folder does not appear in Files.app

Entitlements alone get files syncing but leave the folder invisible - see [iCloud Drive setup](providers/icloud-drive.md#setup) for the Info.plist entry (and the `CFBundleShortVersionString` caching gotcha) that fixes it.

## An iCloud Drive file reads as empty

It's a placeholder: the file exists in the account but has no local bytes on this device, so opening the path gives you nothing rather than an error. Call `icloudDocuments.fetch({ name })` first - see [iCloud Drive](providers/icloud-drive.md#fetch-before-you-read).
