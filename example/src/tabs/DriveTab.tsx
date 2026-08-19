import { useState } from 'react'
import { ScrollView, Text, View } from 'react-native'

import { configureGoogleDrive, googleDrive, isGoogleDriveConfigured } from '@kesha-antonov/react-native-cloud-storage'

import { Button, ButtonRow } from '../components/Button'
import { Field } from '../components/Field'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { styles } from '../theme'
import { useLog } from '../useLog'

export function DriveTab() {
  const log = useLog()
  const [token, setToken] = useState('')
  const [key, setKey] = useState('demo/drive.json')
  const [value, setValue] = useState('{"hello":"drive"}')
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState(isGoogleDriveConfigured())

  const configure = () => {
    // The library never owns the consent flow - the host app supplies a token.
    // That keeps it independent of any particular sign-in library and lets the
    // exact same code run in a browser.
    configureGoogleDrive({
      getAccessToken: () => (token.trim() === '' ? null : token.trim()),
      onAuthExpired: () => log.event('onAuthExpired - Drive rejected the token'),
    })
    setConfigured(true)
    log.ok('configureGoogleDrive() done')
  }

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
      <View>
        <Text style={styles.h1}>Google Drive</Text>
        <Text style={styles.body}>
          The hidden appDataFolder - nothing appears in the user&apos;s visible Drive, and
          the data outlives an app uninstall because it belongs to the account. Works
          identically on iOS, Android and web, which makes it the sensible always-on
          backend for cross-platform apps.
        </Text>
      </View>

      <Section
        title="Auth"
        subtitle="Paste an OAuth access token with the drive.appdata scope. In a real app this
          comes from your sign-in library; the library itself stays auth-agnostic."
      >
        <Field label="access token" value={token} onChangeText={setToken} placeholder="ya29..." />
        <ButtonRow>
          <Button label={configured ? 'Reconfigure' : 'Configure'} onPress={configure} />
        </ButtonRow>
      </Section>

      <Section title="Operations">
        <Field label="file name" value={key} onChangeText={setKey} />
        <Field label="contents" value={value} onChangeText={setValue} multiline />
        <ButtonRow>
          <Button label="getItem" busy={busy} onPress={run('getItem', () => googleDrive.getItem(key))} />
          <Button label="setItem" busy={busy} onPress={run('setItem', () => googleDrive.setItem(key, value))} />
          <Button label="removeItem" busy={busy} onPress={run('removeItem', () => googleDrive.removeItem(key))} />
          <Button label="getAllKeys" busy={busy} onPress={run('getAllKeys', () => googleDrive.getAllKeys())} />
          <Button label="isAvailable" busy={busy} onPress={run('isAvailable', () => googleDrive.isAvailable())} />
        </ButtonRow>
        <Text style={styles.body}>
          Reads resolve a name to a file id with one scoped query and then cache it. Listing
          the whole drive and filtering client-side is what makes other implementations take
          minutes on accounts with many files.
        </Text>
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
