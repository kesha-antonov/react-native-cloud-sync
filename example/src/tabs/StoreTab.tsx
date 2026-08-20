import { useMemo, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'

import {
  createCloudStore,
  createMemoryProvider,
  DEFAULT_TIERING,
  type OutboxEntry,
} from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { Field } from '../components/Field'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { colors, styles } from '../theme'
import { useLog } from '../useLog'

export function StoreTab() {
  const log = useLog()
  const [key, setKey] = useState('demo/store')
  const [value, setValue] = useState('facade value')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<OutboxEntry[]>([])

  // Two memory providers standing in for a small-capacity and a large-capacity
  // backend, so tiering and migration are demonstrable without credentials.
  const { store, small, large } = useMemo(() => {
    const small = createMemoryProvider()
    const largeBase = createMemoryProvider()
    const large = { ...largeBase, name: 'googleDrive' as const }

    const store = createCloudStore({
      providers: ['memory', 'googleDrive'],
      tiering: 'auto',
      onError: e => log.fail('outbox', e),
    })
    store.registerProvider(small)
    store.registerProvider(large)
    return { store, small, large: largeBase }
  }, [log])

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
      <View>
        <Text style={styles.h1}>Store facade</Text>
        <Text style={styles.body}>
          One API over several providers, with size tiering, a durable outbox and
          migration. Reads fall through the provider list, so a value written on another
          device by a different backend is still found.
        </Text>
      </View>

      <Section
        title="Tiering"
        subtitle={`Values at or below ${DEFAULT_TIERING.kvMaxBytes} bytes go to the key-value store; `
          + `larger ones are routed to a record-capable provider automatically. Size limits `
          + `stop being the app's problem.`}
      >
        <Field label="key" value={key} onChangeText={setKey} />
        <Field label="value" value={value} onChangeText={setValue} multiline />
        <ButtonRow>
          <Button label="setItem (small)" busy={busy} onPress={run('setItem', () => store.setItem(key, value))} />
          <Button
            label="setItem (128 KB)"
            busy={busy}
            onPress={run('setItem 128KB', () => store.setItem(key, 'x'.repeat(128 * 1024)))}
          />
          <Button label="getItem" busy={busy} onPress={run('getItem', () => store.getItem(key))} />
          <Button label="getAllKeys" busy={busy} onPress={run('getAllKeys', () => store.getAllKeys())} />
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
        subtitle="A write that fails for a retryable reason is queued and retried with backoff,
          rather than being lost. Failures the user must act on - quota exceeded, signed
          out - are surfaced immediately instead, because retrying those forever would
          just hide them."
      >
        <ButtonRow>
          <Button label="Flush" busy={busy} onPress={run('flushOutbox', () => store.flushOutbox())} />
          <Button label="Refresh" onPress={refresh} />
        </ButtonRow>
        <Text style={[styles.body, { color: pending.length > 0 ? colors.warn : colors.textDim }]}>
          {pending.length === 0
            ? 'Queue empty.'
            : pending
              .map(e => `${e.key} -> ${e.provider} (attempt ${e.attempts})`)
              .join('\n')}
        </Text>
      </Section>

      <Section title="Migration">
        <ButtonRow>
          <Button
            label="memory -> googleDrive"
            busy={busy}
            onPress={run('migrate', () => store.migrate({ from: 'memory', to: 'googleDrive' }))}
          />
        </ButtonRow>
        <Text style={styles.body}>Copies every key. The source is left intact.</Text>
      </Section>

      <Section title="Log">
        <LogView entries={log.entries} />
        <ButtonRow>
          <Button label="Clear" onPress={log.clear} />
        </ButtonRow>
      </Section>
    </ScrollView>
  )
}
