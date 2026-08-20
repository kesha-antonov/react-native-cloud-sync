import { useState } from 'react'
import { Platform, ScrollView, Text } from 'react-native'

import { cloudKit, cloudKitZones } from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { Field } from '../components/Field'
import { TabHeader } from '../components/Header'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { styles, tabTint } from '../theme'
import { useLog } from '../useLog'

const isApple = Platform.OS === 'ios' || Platform.OS === 'macos'

export function CloudKitTab() {
  const log = useLog()
  const [key, setKey] = useState('demo/record')
  const [value, setValue] = useState('{"hello":"cloudkit"}')
  const [zone, setZone] = useState('DemoZone')
  const [busy, setBusy] = useState(false)

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
        eyebrow="Apple · records"
        title="CloudKit"
        tint={tabTint.cloudkit}
        description={isApple
          ? 'Native CloudKit.framework against the private database. No configuration '
          + 'needed - the signed-in iCloud account authenticates implicitly.'
          : 'CloudKit Web Services REST against the same private database. Needs '
            + 'configureCloudKit() with a Client API token and an Apple ID web auth token.'}
      />

      {!isApple && (
        <Section
          title="Heads up on this platform"
          tint={tabTint.cloudkit}
          badge="REST"
          subtitle={
            'A ckWebAuthToken lives 30 minutes, or 2 weeks if the user ticked "Keep me '
            + 'signed in", and Apple documents no refresh. That suits a deliberate '
            + 'import/export ("bring my iPhone data over"), not an always-on backup. '
            + 'Use Google Drive as the continuous backend here.'
          }
        >
          <Text style={styles.body}>
            A server-to-server key cannot substitute: Apple restricts those to the public
            database, and Sign in with Apple identifiers are not linked to CloudKit.
          </Text>
        </Section>
      )}

      <Section title="Record" tint={tabTint.cloudkit}>
        <Field label="recordName" value={key} onChangeText={setKey} />
        <Field label="value" value={value} onChangeText={setValue} multiline />
        <ButtonRow>
          <Button label="getItem" busy={busy} onPress={run('getItem', () => cloudKit.getItem(key))} />
          <Button label="setItem" busy={busy} onPress={run('setItem', () => cloudKit.setItem(key, value))} />
          <Button label="removeItem" busy={busy} onPress={run('removeItem', () => cloudKit.removeItem(key))} />
          <Button label="getAllKeys" busy={busy} onPress={run('getAllKeys', () => cloudKit.getAllKeys())} />
        </ButtonRow>
      </Section>

      <Section
        title="Oversized write"
        tint={tabTint.cloudkit}
        badge="1 MB cap"
        subtitle="CloudKit records are capped at 1 MB excluding assets. The write is rejected
          locally with ERR_PAYLOAD_TOO_LARGE and the byte counts, rather than being sent
          and silently dropped."
      >
        <ButtonRow>
          <Button
            label="Write 1.5 MB"
            busy={busy}
            onPress={run('setItem (1.5 MB)', () => cloudKit.setItem(key, 'x'.repeat(1_500_000)))}
          />
        </ButtonRow>
      </Section>

      <Section
        title="Zones"
        tint={tabTint.cloudkit}
        subtitle={isApple ? undefined : 'Native only - the REST client uses the default zone.'}
      >
        <Field label="zoneName" value={zone} onChangeText={setZone} />
        <ButtonRow>
          <Button label="create" busy={busy} onPress={run('zones.create', () => cloudKitZones.create(zone))} />
          <Button label="list" busy={busy} onPress={run('zones.list', () => cloudKitZones.list())} />
          <Button
            label="remove"
            tone="danger"
            busy={busy}
            onPress={run('zones.remove', () => cloudKitZones.remove(zone))}
          />
        </ButtonRow>
      </Section>

      <Section title="Account" tint={tabTint.cloudkit}>
        <ButtonRow>
          <Button
            label="getAccountStatus"
            busy={busy}
            onPress={run('getAccountStatus', () => cloudKit.getAccountStatus())}
          />
          <Button label="isAvailable" busy={busy} onPress={run('isAvailable', () => cloudKit.isAvailable())} />
        </ButtonRow>
      </Section>

      <Section title="Log" tint={tabTint.cloudkit}>
        <LogView entries={log.entries} />
        <ButtonRow>
          <Button label="Clear" onPress={log.clear} />
        </ButtonRow>
      </Section>
    </ScrollView>
  )
}
