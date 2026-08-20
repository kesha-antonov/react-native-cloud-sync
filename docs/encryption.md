# Encryption

Whether your data is end-to-end encrypted depends on the backend, and the answer is genuinely different for each one. This page is the short version first, then how to add it yourself where it is missing.

## What you get without doing anything

| Backend | Encrypted in transit | Encrypted at rest | End-to-end |
|---|:---:|:---:|:---:|
| CloudKit private database, plain fields | ✅ | ✅ (Apple's keys) | – |
| CloudKit via `cloudKitEncrypted` | ✅ | ✅ | ✅ **natively** |
| iCloud key-value store | ✅ | ✅ (Apple's keys) | only under [ADP](#advanced-data-protection) |
| iCloud Drive (`icloudDocuments`) | ✅ | ✅ (Apple's keys) | only under [ADP](#advanced-data-protection) |
| Google Drive `appDataFolder` | ✅ | ✅ (Google's keys) | – |

"End-to-end" means the provider stores ciphertext it cannot decrypt. Everything else means the data is encrypted on the wire and on their disks, but the provider holds a key - so it is readable by them, by a legal request, and by anyone who compromises the account.

The two things worth internalising:

- **CloudKit has real, native end-to-end encryption**, and this package exposes it. No key management, no passphrase, nothing to lose.
- **Google Drive does not, at all.** `appDataFolder` is hidden from the user's Drive UI, which is not the same as private - anything holding the OAuth token can read it, including your own app's backend if you ever put one in the path. If you want E2E on Drive, you build it.

## CloudKit's native encryption

Apple encrypts `CKRecord` fields written through `encryptedValues` on device, with a key from the user's iCloud Keychain. Apple's servers store ciphertext and never see the key.

```ts
import { cloudKitEncrypted } from 'react-native-cloud-sync'

await cloudKitEncrypted.setItem('auth.refreshToken', token)
const token = await cloudKitEncrypted.getItem('auth.refreshToken')
```

Or through the facade:

```ts
const secrets = createCloudStore({ providers: ['cloudKitEncrypted'] })
```

This is the best option when it fits, because the hardest part of end-to-end encryption - getting the key onto the user's other devices without ever putting it on a server - is already solved by the iCloud Keychain.

### What it costs

None of these are limitations this package could lift.

**Apple platforms only, permanently.** The key is in the iCloud Keychain, which CloudKit Web Services cannot reach. A value written here is not "hard to read" from Android and web - it is *unreadable*, which is what end-to-end means. `cloudKitEncrypted.isAvailable()` returns false there, and every operation rejects with `ERR_UNSUPPORTED_PLATFORM`.

**Do not mix it into a store with a plaintext provider:**

```ts
// Wrong. The Drive copy is plaintext, so the encryption bought you nothing.
createCloudStore({ providers: ['cloudKitEncrypted', 'googleDrive'], writeMode: 'mirror' })
```

If the same data has to be readable off Apple platforms, use the [codec](#doing-it-yourself) instead - a key you manage works everywhere, at the cost of you managing it.

**Values are not queryable.** CloudKit cannot index an encrypted field, so there is no server-side filtering or sorting on the value. `getAllKeys()` still works, because it queries record *names*.

**Keys are not encrypted.** Record names are visible to Apple; only values are protected. `settings.theme` is fine as a key; `patient.7f3a-diagnosis-hiv` is not. Put nothing sensitive in a key - this is true of the codec approach too, for the same reason: `getAllKeys()`, tiering and read repair all need to work on cleartext keys.

**Separate record type.** It writes to `EncryptedKVBlob`, not the `KVBlob` that `cloudKit` uses. CloudKit records encryption in the schema, so a field cannot be encrypted for one write and plain for another - the two providers would collide on a field-type conflict if they shared a type. Practically: `cloudKit` and `cloudKitEncrypted` are separate stores, and moving data between them is a `migrate()`.

### Advanced Data Protection

Separate from the above, and not something your app controls. [ADP][adp] is a user-facing iCloud setting that extends end-to-end encryption to most iCloud categories - including iCloud Drive and iCloud backups. When a user turns it on, `icloudDocuments` files and iCloud device backups become E2E encrypted; when they leave it off (the default), Apple holds those keys.

There is no public API to detect or request it, so treat it as a bonus rather than a guarantee. `cloudKitEncrypted` is E2E either way, which is the point of using it.

## Google Drive has none

`appDataFolder` gives you obscurity, not confidentiality:

- hidden from the user's Drive UI, so they will not stumble on it or delete it by accident;
- scoped to your app's OAuth client, so another app cannot request it;
- but stored under Google's keys, readable by Google, and readable by anything holding a valid access token.

Google Workspace has a client-side encryption feature, but it is an admin-configured enterprise product tied to an external key service. It is not available to consumer accounts and not reachable from the `drive.appdata` scope, so it is not an option for a mobile app.

So on Drive, end-to-end encryption is something you add.

## Doing it yourself

`createCloudStore` takes a `codec` - a two-way value transform applied at the boundary between the store and its providers.

```ts
const store = createCloudStore({
  providers: ['googleDrive'],
  codec: {
    encode: (value, key) => encrypt(value, key),
    decode: (value, key) => decrypt(value, key),
  },
})
```

The provider only ever sees ciphertext; your app only ever sees plaintext. Both halves may be async, which every real crypto library is.

This package deliberately ships **no cipher**. Key management is the part that decides whether encryption is worth anything, and bundling AES would make the problem look solved when the hard half is untouched. Bring a library you chose - `react-native-quick-crypto`, `expo-crypto` plus a Keychain-backed key, `libsodium`.

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

Those last three rows are the ones that catch people. A codec that inflates a value by 40% can push it over a tiering threshold, which is handled - the store measures the ciphertext and routes accordingly - but it means your effective `kvMaxBytes` is smaller than it looks.

### Where the key lives

This is the whole problem. Encryption is easy; getting the same key onto the user's second device without putting it somewhere the provider can read is not.

**Option 1: a passphrase the user remembers.** Works on every platform, and the provider never has anything usable.

```ts
import { pbkdf2 } from 'your-crypto-lib'

const key = await pbkdf2(passphrase, salt, { iterations: 600_000, length: 32 })
```

The cost is real and you must design for it: forget the passphrase, lose the data. There is no reset, by construction. Say so plainly in the UI at the moment they set it, not in a settings screen they will never open.

**Option 2: the iCloud Keychain**, for Apple-only apps. A Keychain item marked synchronizable propagates to the user's other Apple devices, end-to-end encrypted, with no passphrase. That is exactly what `cloudKitEncrypted` does internally - so if this is your situation, use that instead of rebuilding it.

**Option 3: a random data key, wrapped by a passphrase-derived key.** The one to reach for if you expect to support a passphrase change, or more than one unlock method later.

```ts
// Once, at setup:
const dataKey = randomBytes(32)                       // never leaves the device unwrapped
const wrapped = await wrap(dataKey, await derive(passphrase))
await store.setItem('crypto.wrappedKey', toBase64(wrapped))   // safe to sync
```

Changing the passphrase then re-wraps 32 bytes instead of re-encrypting every value. Store the wrapped key with `validateKeys` in mind and treat it as the one value you never encrypt with the codec - write it through a second store, or a provider directly, so you are not trying to decrypt the key with itself.

### Tell a wrong key from corrupt data

Store a canary alongside the wrapped key: a known plaintext, encrypted. If it does not decrypt, the passphrase is wrong. Without one, a wrong passphrase and a genuinely damaged payload look identical, and you will show the user the wrong error.

```ts
const canary = await store.getItem('crypto.canary')
if (canary !== 'rncs-ok') return promptPassphraseAgain()
```

Use an authenticated cipher (AES-GCM, XChaCha20-Poly1305) so a wrong key *fails* rather than producing garbage. The store surfaces a `decode` that throws as an error rather than as a value - the test suite pins that - so an authentication-tag mismatch reaches your `catch` instead of becoming corrupt state.

### A worked example

```ts
import { createCloudStore } from 'react-native-cloud-sync'
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from 'your-crypto-lib'

function encryptedStore (dataKey: Uint8Array) {
  return createCloudStore({
    providers: ['googleDrive'],
    outboxStorage: mmkvAdapter,
    codec: {
      encode: async (value) => {
        // A fresh nonce per write. Reusing one across writes is the classic
        // way to destroy GCM's guarantees.
        const nonce = randomBytes(12)
        const ciphertext = await aesGcmEncrypt(value, dataKey, nonce)
        return `${toBase64(nonce)}.${toBase64(ciphertext)}`
      },
      decode: async (stored) => {
        const [nonce, ciphertext] = stored.split('.')
        // Throws on an authentication-tag mismatch, which is what we want -
        // a wrong key must not read as a successful decode.
        return await aesGcmDecrypt(fromBase64(ciphertext), dataKey, fromBase64(nonce))
      },
    },
  })
}
```

One consequence of the fresh nonce: identical plaintext produces different ciphertext each time, so [read repair](store.md#two-way-sync-across-a-mixed-fleet) rewrites bytes even when the value has not changed. Harmless, but it costs a request - turn off `repairOnRead` if it matters and you are not running a mixed fleet.

## Choosing

| | |
|---|---|
| Apple-only, sensitive data | `cloudKitEncrypted`. Nothing to manage, nothing to lose. |
| Cross-platform, sensitive data | `codec` with a passphrase-derived key |
| Cross-platform, mildly sensitive | Drive's `appDataFolder` on its own may be enough - decide deliberately rather than by default |
| Files rather than values | Encrypt before handing the path to `icloudDocuments` / `googleDriveFiles` |

And the question worth asking before any of it: does this data need to leave the device at all? The cheapest way to protect a secret in a sync library is not to sync it.

[adp]: https://support.apple.com/en-us/102651
