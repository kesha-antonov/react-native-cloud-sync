# Testing

Cloud storage is hard to test on a simulator (the most-used alternative [gave up on it](https://github.com/kuatsu/react-native-cloud-storage/issues/41)). This package ships an in-memory provider with fault injection:

```ts
import { createMemoryProvider } from 'react-native-cloud-sync/testing'
```

## Basics

```ts
const provider = createMemoryProvider({
  initial: { 'user/id': '42' },
  accountStatus: 'available',
  latencyMs: 0,
})

await provider.getItem('user/id')   // '42'
```

```ts
const store = createCloudStore({ providers: ['memory'] })
store.registerProvider(provider)
```

## Injecting failures

```ts
import { ErrorCode } from 'react-native-cloud-sync'

const provider = createMemoryProvider({
  faults: { setItem: { code: ErrorCode.QUOTA_EXCEEDED } },
})

await expect(store.setItem('k', 'v')).rejects.toMatchObject({
  code: ErrorCode.QUOTA_EXCEEDED,
})
```

At runtime:

```ts
provider.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE })
provider.setFault('getItem', null)   // clear
```

### Failures that heal

```ts
// Fail twice, then succeed.
provider.setFault('setItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 2 })

await store.setItem('k', 'v')        // queued
await store.flushOutbox()            // still failing
await store.flushOutbox()            // still failing
await store.flushOutbox()            // drains
```

### Rate limiting with a server hint

```ts
provider.setFault('setItem', {
  code: ErrorCode.RATE_LIMITED,
  retryAfterMs: 90_000,
})
```

Use it to check that backoff honours the server's hint.

## Simulating other devices

```ts
provider.emitRemoteChange({ keys: ['user/id'], reason: 'serverChange' })
```

An account switch:

```ts
provider.emitAccountChange({ status: 'available', identityChanged: true })
// Assert that every user-scoped cache was dropped.
```

## Asserting call counts

```ts
expect(provider.calls.setItem).toBe(1)   // no blind second write
```

Proves a retry did not happen, for example that a quota failure surfaced instead of queuing.

## Inspecting state

| Member | Purpose |
|---|---|
| `dump()` | Backing map, bypassing fault injection |
| `seed(data)` | Replace data without going through `setItem` |
| `reset()` | Clear data, faults and listeners |
| `calls` | Per-operation call counts |

## Simulating a signed-out fleet

Hard to reproduce on a device:

```ts
const provider = createMemoryProvider({ available: false, initial: { backup: 'real data' } })

// Not null - null would read as "no backup exists", and the documented
// first-launch recipe seeds empty state on null.
await expect(store.getItem('backup')).rejects.toMatchObject({
  code: ErrorCode.NOT_SIGNED_IN,
})
```

`setAvailable(false)` simulates a sign-out mid-test.

## Faults scoped to one key

Real backends fail per record, so one bad key can fail while the rest of a batch succeeds:

```ts
const provider = createMemoryProvider({
  faults: {
    setItem: { code: ErrorCode.QUOTA_EXCEEDED, only: key => key === 'huge' },
  },
})
```

This also keeps interleaving tests deterministic, since other keys don't consume the `times` budget.

## Several providers at once

```ts
const apple = createMemoryProvider({ name: 'icloudKV' })
const drive = createMemoryProvider({ name: 'googleDrive' })

const store = createCloudStore({ providers: ['icloudKV', 'googleDrive'], writeMode: 'mirror' })
store.registerProvider(apple)
store.registerProvider(drive)
```

`name` makes each double stand in for a real provider, so tiering, mirroring and read repair behave as in production.

## Asserting that batching happened

The double counts one call per batch, not per key:

```ts
const before = provider.calls.getItem
await store.multiGet(['a', 'b', 'c'])
expect(provider.calls.getItem).toBe(before + 1)
```

## Account switches

```ts
provider.emitAccountChange({ status: 'available', identityChanged: true })

expect(store.pendingWrites()).toHaveLength(0)   // the previous user's writes are gone
expect(provider.cacheClears).toBe(1)            // and the provider was told to forget
```

`cacheClears` counts how often the store told the provider to drop cached state.

## Mocking the native module

To test a real provider, use the native-module mock this package's own suite uses:

```js
// jest.config.js
module.exports = {
  setupFiles: ['react-native-cloud-sync/jest-mock'],
}
```

It exposes `jest.fn()` methods and an event registry, so tests can fire native events:

```ts
const harness = (global as any).__RNCloudSync

harness.setPlatform('android')                       // exercise the REST branches
harness.emit('accountChange', { status: 'available', identityChanged: true })
harness.setAppState('active')                        // trigger the store's auto-flush
harness.reset()
```

It avoids `jest.requireActual('react-native')`: the real index loads DevMenu, whose `TurboModuleRegistry.getEnforcing` call throws under Jest.
