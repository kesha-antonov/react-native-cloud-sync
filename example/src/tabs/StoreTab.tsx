import { useMemo, useRef, useState } from 'react'
import { ScrollView, Text } from 'react-native'

import {
  createCloudStore,
  createMemoryProvider,
  DEFAULT_TIERING,
  type OutboxEntry,
} from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { Field } from '../components/Field'
import { TabHeader } from '../components/Header'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { colors, styles, tabTint } from '../theme'
import { useLog } from '../useLog'

export function StoreTab() {
  const log = useLog()
  const [key, setKey] = useState('demo/store')
  const [value, setValue] = useState('facade value')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<OutboxEntry[]>([])

  // `log` is a fresh object every render (useLog returns a new literal each
  // time, and its own `entries` array changes on every logged operation) - so
  // depending on it here would recreate the store, and the two memory
  // providers backing it, on almost every render. Each write would then land
  // in an instance the very next read had already discarded, silently: every
  // getItem after a setItem would report null, exactly as if the facade were
  // dropping data. A ref sidesteps that without needing `log` as a dependency
  // at all - onError still reaches the latest log methods (fail is itself
  // stable via useCallback), it just does so through a ref instead of a
  // closure that would force a recreation.
  const logRef = useRef(log)
  logRef.current = log

  // Two memory providers standing in for a small-capacity and a large-capacity
  // backend, so tiering and migration are demonstrable without credentials.
  // Created exactly once for the component's lifetime.
  //
  // Named 'icloudKV' and 'googleDrive' rather than the more obvious 'memory' -
  // and that naming is load-bearing, not cosmetic. `tiering: 'auto'` only
  // imposes a size ceiling on a provider actually named 'icloudKV' (kvMaxBytes)
  // or 'cloudKit' (recordMaxBytes); every other name is unlimited by design, so
  // Drive - which really does store whole files with no cap of its own - is a
  // safe destination of last resort. A memory double named plain 'memory' is
  // therefore invisible to tiering: nothing ever routes away from it regardless
  // of size, which silently turned this into a demo of a single unbounded
  // store rather than of tiering at all - the 128 KB write landed in "small"
  // and "large" stayed empty. Borrowing the real name is what makes the
  // 64 KB threshold actually apply to this double.
  const { store, small, large } = useMemo(() => {
    const small = createMemoryProvider({ name: 'icloudKV' })
    const largeBase = createMemoryProvider({ name: 'googleDrive' })

    const store = createCloudStore({
      providers: ['icloudKV', 'googleDrive'],
      tiering: 'auto',
      onError: e => logRef.current.fail('outbox', e),
    })
    store.registerProvider(small)
    store.registerProvider(largeBase)
    return { store, small, large: largeBase }
  }, [])

  const refresh = () => setPending(store.pendingWrites())

  const run = (label: string, fn: () => Promise<unknown>) => () => {
    setBusy(true)
    log.info(label)
    fn()
      .then(r => log.ok(`${label} -> ${JSON.stringify(r) ?? 'ok'}`))
      .catch(e => log.fail(label, e))
      .finally(() => {
        setBusy(false)
        refresh()
      })
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <TabHeader
        eyebrow="Facade"
        title="Store facade"
        tint={tabTint.store}
        description="One API over several providers, with size tiering, a durable outbox and
          migration. Reads fall through the provider list, so a value written on another
          device by a different backend is still found."
      />

      <Section
        title="Tiering"
        tint={tabTint.store}
        subtitle={`Values at or below ${DEFAULT_TIERING.kvMaxBytes} bytes go to the key-value store; `
          + `larger ones are routed to a record-capable provider automatically. Size limits `
          + `stop being the app's problem.`}
      >
        <Field testID="store-field-key" label="key" value={key} onChangeText={setKey} />
        <Field testID="store-field-value" label="value" value={value} onChangeText={setValue} multiline />
        <ButtonRow>
          <Button
            testID="store-btn-setItemSmall"
            label="setItem (small)"
            busy={busy}
            onPress={run('setItem', () => store.setItem(key, value))}
          />
          <Button
            testID="store-btn-setItemLarge"
            label="setItem (128 KB)"
            busy={busy}
            onPress={run('setItem 128KB', () => store.setItem(key, 'x'.repeat(128 * 1024)))}
          />
          <Button
            testID="store-btn-getItem"
            label="getItem"
            busy={busy}
            onPress={run('getItem', () => store.getItem(key))}
          />
          <Button
            testID="store-btn-getAllKeys"
            label="getAllKeys"
            busy={busy}
            onPress={run('getAllKeys', () => store.getAllKeys())}
          />
        </ButtonRow>
        <Text style={styles.body}>
          small provider:
          {' '}
          {JSON.stringify(small.dump()).slice(0, 90)}
          {'\n'}
          large provider:
          {JSON.stringify(large.dump()).slice(0, 90)}
        </Text>
      </Section>

      <Section
        title="Outbox"
        tint={tabTint.store}
        badge={pending.length > 0 ? `${pending.length} pending` : undefined}
        subtitle="A write that fails for a retryable reason is queued and retried with backoff,
          rather than being lost. Failures the user must act on - quota exceeded, signed
          out - are surfaced immediately instead, because retrying those forever would
          just hide them."
      >
        <ButtonRow>
          <Button
            testID="store-btn-flush"
            label="Flush"
            busy={busy}
            onPress={run('flushOutbox', () => store.flushOutbox())}
          />
          <Button testID="store-btn-refresh" label="Refresh" onPress={refresh} />
        </ButtonRow>
        <Text style={[styles.body, { color: pending.length > 0 ? colors.warn : colors.textDim }]}>
          {pending.length === 0
            ? 'Queue empty.'
            : pending
              .map(e => `${e.key} -> ${e.provider} (attempt ${e.attempts})`)
              .join('\n')}
        </Text>
      </Section>

      <Section title="Migration" tint={tabTint.store}>
        <ButtonRow>
          <Button
            testID="store-btn-migrate"
            label="icloudKV -> googleDrive"
            busy={busy}
            onPress={run('migrate', () => store.migrate({ from: 'icloudKV', to: 'googleDrive' }))}
          />
        </ButtonRow>
        <Text style={styles.body}>Copies every key. The source is left intact.</Text>
      </Section>

      <Section title="Log" tint={tabTint.store}>
        <LogView entries={log.entries} />
        <ButtonRow>
          <Button testID="store-btn-clear" label="Clear" onPress={log.clear} />
        </ButtonRow>
      </Section>
    </ScrollView>
  )
}
