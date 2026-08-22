import { useEffect, useState } from 'react'
import { Platform, ScrollView, Text } from 'react-native'

import { icloudKV, icloudKVSync } from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { Field } from '../components/Field'
import { TabHeader } from '../components/Header'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { styles, tabTint } from '../theme'
import { useLog } from '../useLog'

export function ICloudKVTab() {
  const log = useLog()
  const [key, setKey] = useState('demo/greeting')
  const [value, setValue] = useState('hello from ' + Platform.OS)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // The listener nobody wires up. Without it, a change made on another device
    // is invisible for the rest of the session.
    const unsubscribe = icloudKV.onRemoteChange?.((e) => {
      log.event(`remoteChange reason=${e.reason} keys=[${e.keys.join(', ')}]`)
    })
    const unsubscribeAccount = icloudKV.onAccountChange?.((e) => {
      log.event(`accountChange status=${e.status} identityChanged=${String(e.identityChanged)}`)
    })
    return () => {
      unsubscribe?.()
      unsubscribeAccount?.()
    }
  }, [log])

  const run = (label: string, fn: () => Promise<unknown>) => () => {
    setBusy(true)
    log.info(label)
    fn()
      .then(r => log.ok(`${label} -> ${JSON.stringify(r) ?? 'ok'}`))
      .catch(e => log.fail(label, e))
      .finally(() => setBusy(false))
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <TabHeader
        eyebrow="Apple · key-value"
        title="iCloud key-value store"
        tint={tabTint.kv}
        description="NSUbiquitousKeyValueStore. Apple platforms only - on Android and web every call
          rejects with ERR_UNSUPPORTED_PLATFORM rather than silently doing nothing.
          Limits: 1 MB total, 1 MB per key, 1024 keys."
      />

      <Section title="Value" tint={tabTint.kv}>
        <Field testID="kv-field-key" label="key" value={key} onChangeText={setKey} />
        <Field testID="kv-field-value" label="value" value={value} onChangeText={setValue} multiline />
      </Section>

      <Section title="Operations" tint={tabTint.kv}>
        <ButtonRow>
          <Button
            testID="kv-btn-getItem"
            label="getItem"
            busy={busy}
            onPress={run('getItem', () => icloudKV.getItem(key))}
          />
          <Button
            testID="kv-btn-setItem"
            label="setItem"
            busy={busy}
            onPress={run('setItem', () => icloudKV.setItem(key, value))}
          />
          <Button
            testID="kv-btn-removeItem"
            label="removeItem"
            busy={busy}
            onPress={run('removeItem', () => icloudKV.removeItem(key))}
          />
          <Button
            testID="kv-btn-getAllKeys"
            label="getAllKeys"
            busy={busy}
            onPress={run('getAllKeys', () => icloudKV.getAllKeys())}
          />
          <Button testID="kv-btn-sync" label="sync()" busy={busy} onPress={run('sync', () => icloudKVSync())} />
        </ButtonRow>
        <Text style={styles.body}>
          sync() maps to NSUbiquitousKeyValueStore.synchronize(), which schedules an
          upload. It does not confirm one - a resolved sync() means queued, never stored.
        </Text>
      </Section>

      <Section title="Account" tint={tabTint.kv}>
        <ButtonRow>
          <Button
            testID="kv-btn-getAccountStatus"
            label="getAccountStatus"
            busy={busy}
            onPress={run('getAccountStatus', () => icloudKV.getAccountStatus())}
          />
          <Button
            testID="kv-btn-isAvailable"
            label="isAvailable"
            busy={busy}
            onPress={run('isAvailable', () => icloudKV.isAvailable())}
          />
        </ButtonRow>
        <Text style={styles.body}>
          Five states, not a boolean: available, noAccount, restricted,
          temporarilyUnavailable, couldNotDetermine. &quot;Temporarily unavailable&quot; means
          retry silently; &quot;no account&quot; means prompt the user. Collapsing them loses that.
        </Text>
      </Section>

      <Section title="Log" tint={tabTint.kv}>
        <LogView entries={log.entries} />
        <ButtonRow>
          <Button testID="kv-btn-clear" label="Clear" onPress={log.clear} />
        </ButtonRow>
      </Section>
    </ScrollView>
  )
}
