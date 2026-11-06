# Encryption

Whether your data is end-to-end encrypted depends on the backend. This page shows what you get by default and how to add encryption where it is missing.

## What you get without doing anything

| Backend | Encrypted in transit | Encrypted at rest | End-to-end |
|---|:---:|:---:|:---:|
| CloudKit private database, plain fields | yes | yes (Apple's keys) | no |
| CloudKit via `cloudKitEncrypted` | yes | yes | **yes, natively** |
| iCloud key-value store | yes | yes (Apple's keys) | only under [ADP](#advanced-data-protection) |
| iCloud Drive (`icloudDocuments`) | yes | yes (Apple's keys) | only under [ADP](#advanced-data-protection) |
| Google Drive `appDataFolder` | yes | yes (Google's keys) | no |

End-to-end means the provider stores ciphertext it cannot decrypt. Otherwise the provider holds a key, so the data is readable by the provider, by a legal request, or by anyone who compromises the account.

In short:

- CloudKit has native end-to-end encryption, exposed here with no key management and no passphrase
- Google Drive has none. `appDataFolder` is hidden, not private: anything holding the OAuth token can read it, including your own backend. For E2E on Drive, you build it

## CloudKit's native encryption

Fields written through `CKRecord.encryptedValues` are encrypted on device with a key from the user's iCloud Keychain. Apple's servers store ciphertext and never see the key.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
const token = await cloudKitEncrypted.getItem('auth.refreshToken')
```

Or through the facade:

```ts
const secrets = createCloudStore({ providers: ['cloudKitEncrypted'] })
```

The best option when it fits: iCloud Keychain already solves the hard part, getting the key to other devices without putting it on a server.

### What it costs

**Apple platforms only, permanently.** The key lives in the iCloud Keychain, which CloudKit Web Services cannot reach, so the data is unreadable from Android and web. There `isAvailable()` returns false and every operation rejects with `ERR_UNSUPPORTED_PLATFORM`. If the data must be readable off Apple platforms, use the [codec](#doing-it-yourself) with a key you manage.

**Do not mix it with a plaintext provider:**

```ts
// Wrong. The Drive copy is plaintext, so the encryption bought you nothing.
createCloudStore({ providers: ['cloudKitEncrypted', 'googleDrive'], writeMode: 'mirror' })
```

**Values are not queryable.** CloudKit cannot index an encrypted field, so there is no server-side filtering or sorting. `getAllKeys()` still works, since it queries record names.

**Keys are not encrypted.** Record names are visible to Apple: `settings.theme` is a fine key, `patient.7f3a-diagnosis-hiv` is not. The codec has the same rule, since `getAllKeys()`, tiering and read repair need cleartext keys.

**Separate record type.** Records are `EncryptedKVBlob`, not `KVBlob`. CloudKit fixes a field's encryption in the schema, so sharing one type would cause field-type conflicts. `cloudKit` and `cloudKitEncrypted` are separate stores; move data between them with `migrate()`.

**Prefixed record names.** Key `token` is stored as record `rncs-enc.token`, because record names are unique across types and a delete through one provider would otherwise remove the other's data. Consequences:

- plain `cloudKit` rejects keys starting with `rncs-enc.`
- a `cloudKitEncrypted` key can be at most 246 characters (CloudKit's 255 minus the prefix); longer rejects with `ERR_INVALID_KEY`
- records written before the prefix existed are not migrated and no longer read back

**Failed writes queue in memory only**, never in `outboxStorage`, because the store holds plaintext until native code encrypts it. A queued write is lost if the app restarts.

**Reads check the record type.** A record under `rncs-enc.<key>` that is not an `EncryptedKVBlob` rejects with `ERR_INVALID_KEY` instead of being read as plaintext.

### Advanced Data Protection

[ADP][adp] is a user-controlled iCloud setting, outside your app's control. When on, it extends end-to-end encryption to most iCloud categories, including iCloud Drive and iCloud backups, so `icloudDocuments` files become E2E encrypted. When off (the default), Apple holds those keys.

There is no public API to detect or request it, so treat it as a bonus. `cloudKitEncrypted` is E2E either way.

## Google Drive has none

`appDataFolder` gives obscurity, not confidentiality. It is:

- hidden from the user's Drive UI, so they will not delete it by accident
- scoped to your app's OAuth client, so another app cannot request it
- stored under Google's keys: readable by Google and by anything holding a valid access token

Google Workspace client-side encryption is admin-configured, enterprise-only and unreachable from the `drive.appdata` scope, so it is not an option for a mobile app. On Drive, you add E2E yourself.

## Doing it yourself

`createCloudStore` takes a `codec`: a two-way value transform between the store and its providers.

```ts
const store = createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: (value, key) => encrypt(value, key),
    decode: (value, key) => decrypt(value, key),
  },
})
```

Providers see only ciphertext; your app sees only plaintext. Both functions may be async. The package ships **no cipher**; use one you choose, such as `react-native-quick-crypto`, `expo-crypto` with a Keychain-backed key, or `libsodium`.

Pass `key` as associated data (AAD) to an AEAD cipher, so ciphertext copied to another key fails to decode. Replay and rollback (the server returning an older ciphertext for the same key) are also the codec's job; the store cannot detect them.

### What it applies to, and what it does not

| | |
|---|---|
| Values | Encrypted |
| Keys | **Not** encrypted - `getAllKeys()`, tiering and read repair all need them |
| The outbox | Holds ciphertext, so a persisted queue never contains plaintext |
| `migrate()` | Moves ciphertext verbatim; migration does not need the key |
| Resolvers | Run on **plaintext** - decoding happens before your `resolve` function |
| Tiering | Routes on the **encrypted** size, because that is what actually gets stored |
| `cloudKitAssets` / `googleDriveFiles` / `icloudDocuments` | Not covered - they move files by path, not values through the store. Encrypt the file yourself before handing it over |

Watch the last three rows. A codec that inflates values by 40% can push them over a tiering threshold, so your effective `kvMaxBytes` is smaller than it looks. See [Encrypting at rest](store.md#encrypting-at-rest).

### Where the key lives

Encryption is easy. Getting the same key onto a second device without the provider seeing it is the hard part.

#### A passphrase the user remembers

Works on every platform; the provider never has anything usable.

```ts
import { pbkdf2 } from 'your-crypto-lib'

const key = await pbkdf2(passphrase, salt, { iterations: 600_000, length: 32 })
```

A forgotten passphrase means lost data, with no reset. Tell the user when they set it, not in a settings screen they never open.

#### The iCloud Keychain, for Apple-only apps

A synchronizable Keychain item reaches the user's other Apple devices end-to-end encrypted, with no passphrase. `cloudKitEncrypted` already does this; use it instead of rebuilding it.

#### A random data key, wrapped by a passphrase-derived key

Use this if you may support passphrase changes or more than one unlock method later.

```ts
// Once, at setup:
const dataKey = randomBytes(32)                       // never leaves the device unwrapped
const wrapped = await wrap(dataKey, await derive(passphrase))
await store.setItem('crypto.wrappedKey', toBase64(wrapped))   // safe to sync
```

Changing the passphrase re-wraps 32 bytes instead of re-encrypting every value. Never encrypt the wrapped key with the codec: write it through a second store or a provider directly, or you would need the key to decrypt the key.

### Tell a wrong key from corrupt data

Store a canary next to the wrapped key: a known plaintext, encrypted. If it does not decrypt, the passphrase is wrong. Without it, a wrong passphrase and damaged data look the same.

```ts
const canary = await store.getItem('crypto.canary')
if (canary !== 'rncs-ok') return promptPassphraseAgain()
```

Use an authenticated cipher (AES-GCM, XChaCha20-Poly1305) so a wrong key fails instead of producing garbage. A throwing `decode` surfaces as an error, not a value (covered by the test suite), so a tag mismatch reaches your `catch`.

### A worked example

```ts
import { createCloudStore } from 'react-native-cloud-sync'
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from 'your-crypto-lib'

function encryptedStore (dataKey: Uint8Array) {
  return createCloudStore({
    providers: ['googleDrive'],
    outboxStorage: mmkvAdapter,
    codec: {
      encode: async (value, key) => {
        // A fresh nonce per write. Reusing one across writes is the classic
        // way to destroy GCM's guarantees.
        const nonce = randomBytes(12)
        // The key as associated data: this ciphertext only decodes under this key.
        const ciphertext = await aesGcmEncrypt(value, dataKey, nonce, key)
        return `${toBase64(nonce)}.${toBase64(ciphertext)}`
      },
      decode: async (stored, key) => {
        const [nonce, ciphertext] = stored.split('.')
        // Throws on an authentication-tag mismatch, which is what we want -
        // a wrong key must not read as a successful decode.
        return await aesGcmDecrypt(fromBase64(ciphertext), dataKey, fromBase64(nonce), key)
      },
    },
  })
}
```

With a fresh nonce, identical plaintext encrypts differently every time, so [read repair](store.md#two-way-sync-across-a-mixed-fleet) rewrites values that did not change. Harmless, but it costs a request; set `repairOnRead: false` if you are not running a mixed fleet.

## Choosing

| | |
|---|---|
| Apple-only, sensitive data | `cloudKitEncrypted`. Nothing to manage, nothing to lose. |
| Cross-platform, sensitive data | `codec` with a passphrase-derived key |
| Cross-platform, mildly sensitive | Drive's `appDataFolder` alone may be enough; decide deliberately |
| Files rather than values | Encrypt before handing the path to `icloudDocuments` / `googleDriveFiles` |

First ask whether the data needs to leave the device at all. The cheapest way to protect a secret is not to sync it.

[adp]: https://support.apple.com/en-us/102651
