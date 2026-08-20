/**
 * Large-file backup and restore, on both of the paths that stream from disk:
 * `cloudKitBackup` on Apple platforms and `googleDriveFiles` everywhere else.
 *
 * This is the tab that proves the file adapter, since `googleDriveFiles` is the
 * only API here that needs the host app to supply I/O.
 */

import { useState } from 'react'
import { Platform, ScrollView, Text, View } from 'react-native'

import {
  cloudKitBackup,
  googleDriveFiles,
  isGoogleDriveConfigured,
  isGoogleDriveFilesConfigured,
} from 'react-native-cloud-sync'

import {
  deleteIfPresent,
  fileSize,
  installExpoFileAdapter,
  makeTestFile,
  scratchUri,
} from '../adapters/expoFileAdapter'
import { Button, ButtonRow } from '../components/Button'
import { Field } from '../components/Field'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { styles } from '../theme'
import { useLog } from '../useLog'

const isAppleNative = Platform.OS === 'ios' || Platform.OS === 'macos'

const SOURCE_NAME = 'demo-backup.bin'
const RESTORED_NAME = 'demo-restored.bin'

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function FilesTab() {
  const log = useLog()
  const [sizeMb, setSizeMb] = useState('12')
  const [sourceUri, setSourceUri] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [adapterReady, setAdapterReady] = useState(isGoogleDriveFilesConfigured())

  const installAdapter = () => {
    installExpoFileAdapter()
    setAdapterReady(true)
    log.ok('configureGoogleDriveFiles() done - adapter installed')
  }

  const run = (label: string, fn: () => Promise<unknown>) => () => {
    setBusy(true)
    setProgress(0)
    log.info(label)
    fn()
      .then(r => log.ok(`${label} -> ${JSON.stringify(r) ?? 'ok'}`))
      .catch(e => log.fail(label, e))
      .finally(() => {
        setBusy(false)
        setProgress(null)
      })
  }

  const generate = run(`generate ${SOURCE_NAME}`, async () => {
    const n = Number.parseInt(sizeMb, 10)
    const uri = makeTestFile(SOURCE_NAME, Number.isFinite(n) && n > 0 ? n : 1)
    setSourceUri(uri)
    return mb(fileSize(uri))
  })

  const upload = run('save', async () => {
    if (sourceUri == null) throw new Error('Generate a file first')

    if (isAppleNative) {
      // Streams the file in as a CKAsset - it never becomes a JS string.
      await cloudKitBackup.save(sourceUri, {
        onProgress: e => setProgress(e.fraction),
      })
      return 'uploaded via cloudKitBackup (CKAsset)'
    }

    await googleDriveFiles.save({
      name: SOURCE_NAME,
      fileUri: sourceUri,
      onProgress: e => setProgress(e.fraction),
    })
    return 'uploaded via googleDriveFiles (resumable, chunked)'
  })

  const download = run('restore', async () => {
    if (isAppleNative) {
      // CloudKit hands back its own temp path, so destinationUri is unused here.
      const path = await cloudKitBackup.restore({
        onProgress: e => setProgress(e.fraction),
      })
      return path == null ? 'null (nothing backed up yet)' : `${path} (${mb(fileSize(path))})`
    }

    const destinationUri = scratchUri(RESTORED_NAME)
    deleteIfPresent(destinationUri)

    const path = await googleDriveFiles.fetch({
      name: SOURCE_NAME,
      destinationUri,
      onProgress: e => setProgress(e.fraction),
    })
    return path == null ? 'null (nothing saved yet)' : `${path} (${mb(fileSize(path))})`
  })

  const driveReady = isGoogleDriveConfigured() && adapterReady
  const canTransfer = isAppleNative || driveReady

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.h1}>Large files</Text>
        <Text style={styles.body}>
          Anything too big to hold in memory as a string - a database export, an archive.
          Two providers stream from disk instead of loading the whole file:
          cloudKitBackup on Apple platforms, googleDriveFiles on Android and web.
        </Text>
        <Text style={styles.body}>
          This device will use
          {' '}
          <Text style={styles.mono}>
            {isAppleNative ? 'cloudKitBackup' : 'googleDriveFiles'}
          </Text>
          .
        </Text>
      </View>

      {!isAppleNative && (
        <Section
          title="File adapter"
          subtitle="googleDriveFiles has no filesystem dependency, so the host app supplies chunked
            reads and writes. This installs the modern expo-file-system implementation from
            src/adapters/expoFileAdapter.ts - the same code the docs show."
        >
          <ButtonRow>
            <Button
              label={adapterReady ? 'Reinstall adapter' : 'Install adapter'}
              onPress={installAdapter}
            />
          </ButtonRow>
          <Text style={styles.body}>
            {adapterReady
              ? 'Adapter installed.'
              : 'Not installed - save/fetch will reject with ERR_CONTAINER_MISCONFIGURED.'}
          </Text>
          {!isGoogleDriveConfigured() && (
            <Text style={styles.body}>
              Drive itself is not configured yet either - paste a token on the Drive tab first.
            </Text>
          )}
        </Section>
      )}

      <Section
        title="Source file"
        subtitle="Generates a file of pseudo-random bytes in the cache directory, large enough
          that chunking and progress actually mean something."
      >
        <Field label="size (MB)" value={sizeMb} onChangeText={setSizeMb} placeholder="12" />
        <ButtonRow>
          <Button label="Generate" busy={busy} onPress={generate} />
        </ButtonRow>
        <Text style={styles.body}>
          {sourceUri == null
            ? 'No file generated yet.'
            : `${SOURCE_NAME} - ${mb(fileSize(sourceUri))}`}
        </Text>
      </Section>

      <Section
        title="Transfer"
        subtitle="Progress is a real byte fraction in both directions - the download side knows
          the total before it starts, because the upload stashed it."
      >
        <ButtonRow>
          <Button
            label="save"
            busy={busy}
            disabled={!canTransfer || sourceUri == null}
            onPress={upload}
          />
          <Button label="restore" busy={busy} disabled={!canTransfer} onPress={download} />
        </ButtonRow>
        <Text style={styles.body}>
          {progress == null ? 'Idle.' : `${(progress * 100).toFixed(1)}%`}
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
