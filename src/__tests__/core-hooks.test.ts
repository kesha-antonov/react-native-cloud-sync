import { act, renderHook, waitFor } from '@testing-library/react-native'

import { createCloudStore, type CloudStore } from '../store'
import { createMemoryProvider, type MemoryProvider } from '../providers/memory'
import type { AccountStatus, CloudProvider } from '../types'
import { useAccountStatus, useCloudCollection, useCloudItem, useCloudItems } from '../hooks'

function setup(provider: MemoryProvider): CloudStore {
  const store = createCloudStore({ providers: [provider.name] })
  store.registerProvider(provider)
  return store
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useCloudItem', () => {
  it('clears loading when setValue overtakes the initial read', async () => {
    const mem = createMemoryProvider({ initial: { k: '"old"' } })
    const store = setup(mem)
    const gate = deferred<string | null>()
    const realGet = store.getItem
    store.getItem = async (key) => {
      await gate.promise
      return await realGet(key)
    }

    const { result } = await renderHook(() => useCloudItem<string>(store, 'k'))
    expect(result.current.loading).toBe(true)

    await act(async () => {
      await result.current.setValue('new')
    })
    gate.resolve(null)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.value).toBe('new')
  })

  it('does not show the previous key\'s value while the new key loads', async () => {
    const mem = createMemoryProvider({ initial: { a: '"A"', b: '"B"' } })
    const store = setup(mem)

    const { result, rerender } = await renderHook(
      ({ k }: { k: string }) => useCloudItem<string>(store, k, { initialValue: 'none' }),
      { initialProps: { k: 'a' } }
    )
    await waitFor(() => expect(result.current.value).toBe('A'))

    const gate = deferred<void>()
    const realGet = store.getItem
    store.getItem = async (key) => {
      await gate.promise
      return await realGet(key)
    }
    await rerender({ k: 'b' })

    expect(result.current.value).toBe('none')
    gate.resolve()
    await waitFor(() => expect(result.current.value).toBe('B'))
  })
})

describe('useCloudItems', () => {
  it('does not record an answer for a key that left the list mid-fetch', async () => {
    const mem = createMemoryProvider({ initial: { a: '1', b: '2' } })
    const store = setup(mem)
    const gate = deferred<void>()
    const realMultiGet = store.multiGet
    let held = false
    store.multiGet = async (keys) => {
      if (!held) {
        held = true
        await gate.promise
      }
      return await realMultiGet(keys)
    }

    const { result, rerender } = await renderHook(
      ({ keys }: { keys: string[] }) => useCloudItems<number>(store, keys),
      { initialProps: { keys: ['a', 'b'] } }
    )
    await rerender({ keys: ['a'] })
    await act(async () => {
      gate.resolve()
      await gate.promise
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.values).toEqual({ a: 1 })
  })
})

describe('useCloudCollection', () => {
  it('keeps a key created while the initial listing was in flight', async () => {
    const mem = createMemoryProvider({ initial: { 'note:1': '"one"' } })
    const store = setup(mem)
    const gate = deferred<void>()
    const realList = store.getAllKeys
    let held = false
    store.getAllKeys = async () => {
      // The listing reads the backend *before* the local write lands, then
      // waits - so its answer does not contain the new key.
      const keys = await realList()
      if (!held) {
        held = true
        await gate.promise
      }
      return keys
    }

    const { result } = await renderHook(() => useCloudCollection<string>(store, 'note:'))

    await act(async () => {
      await result.current.setValue('note:2', 'two')
    })
    await act(async () => {
      gate.resolve()
      await gate.promise
    })

    await waitFor(() => expect(result.current.keys).toContain('note:1'))
    expect(result.current.keys).toContain('note:2')
  })
})

describe('useAccountStatus', () => {
  it('does not let an older status query overwrite a newer account event', async () => {
    const mem = createMemoryProvider()
    const gate = deferred<AccountStatus>()
    const provider: CloudProvider = {
      ...mem,
      getAccountStatus: () => gate.promise,
    }

    const { result } = await renderHook(() => useAccountStatus(provider))
    await act(() => {
      mem.emitAccountChange({ status: 'noAccount' })
    })
    expect(result.current.status).toBe('noAccount')

    await act(async () => {
      gate.resolve('available')
      await gate.promise
    })
    expect(result.current.status).toBe('noAccount')
  })
})
