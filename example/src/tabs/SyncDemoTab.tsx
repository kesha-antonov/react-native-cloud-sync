import { useCallback, useEffect, useState } from 'react'
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  cloudKit,
  googleDrive,
  icloudKV,
  isGoogleDriveConfigured,
  type CloudProvider,
  type ProviderName,
} from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { colors, mono, styles } from '../theme'
import { deviceId } from '../deviceId'
import { useLog } from '../useLog'

const SHARED_KEY = 'demo/shared-counter'

const PROVIDERS: { name: ProviderName; provider: CloudProvider; note: string }[] = [
  { name: 'icloudKV', provider: icloudKV, note: 'Apple only' },
  { name: 'cloudKit', provider: cloudKit, note: 'iOS native · Android/web REST' },
  { name: 'googleDrive', provider: googleDrive, note: 'every platform' },
]

interface Payload {
  count: number
  writtenBy: string
  writtenAt: number
}

/**
 * The pane that makes sync visible.
 *
 * Run this side by side - two iOS simulators on one Apple ID, an Android
 * emulator, and a browser - and one tap on any pane should show up on the
 * others. A single screenshot cannot demonstrate a sync library; four panes
 * reacting to one write can.
 */
export function SyncDemoTab() {
  const log = useLog()
  const [selected, setSelected] = useState<ProviderName>(
    Platform.OS === 'ios' || Platform.OS === 'macos' ? 'icloudKV' : 'googleDrive'
  )
  const [payload, setPayload] = useState<Payload | null>(null)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState<Partial<Record<ProviderName, boolean>>>({})

  const active = PROVIDERS.find(p => p.name === selected)?.provider ?? icloudKV

  useEffect(() => {
    let cancelled = false
    Promise.all(
      PROVIDERS.map(async p => [p.name, await p.provider.isAvailable().catch(() => false)] as const)
    )
      .then((pairs) => {
        if (!cancelled) setAvailable(Object.fromEntries(pairs))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const read = useCallback(async () => {
    const raw = await active.getItem(SHARED_KEY)
    if (raw == null) {
      setPayload(null)
      return null
    }
    const parsed = JSON.parse(raw) as Payload
    setPayload(parsed)
    return parsed
  }, [active])

  // Live updates from other devices. This is the whole demo - without it you
  // would have to poll, which is what every library lacking a change event
  // forces on you.
  useEffect(() => {
    const unsubscribe = active.onRemoteChange?.((e) => {
      log.event(`remoteChange reason=${e.reason} keys=[${e.keys.join(', ')}]`)
      if (e.keys.length === 0 || e.keys.includes(SHARED_KEY))
        read()
          .then((p) => {
            if (p != null) log.ok(`pulled count=${p.count} from ${p.writtenBy}`)
          })
          .catch(e2 => log.fail('read after remoteChange', e2))
    })
    const unsubscribeAccount = active.onAccountChange?.((e) => {
      log.event(
        `accountChange status=${e.status} identityChanged=${String(e.identityChanged)}`
        + (e.identityChanged ? ' - drop user-scoped caches' : '')
      )
    })
    return () => {
      unsubscribe?.()
      unsubscribeAccount?.()
    }
  }, [active, log, read])

  const increment = () => {
    setBusy(true)
    log.info(`increment via ${selected}`)
    read()
      .then((current) => {
        const next: Payload = {
          count: (current?.count ?? 0) + 1,
          writtenBy: deviceId(),
          writtenAt: Date.now(),
        }
        return active.setItem(SHARED_KEY, JSON.stringify(next)).then(() => next)
      })
      .then((next) => {
        setPayload(next)
        log.ok(`wrote count=${next.count}`)
      })
      .catch(e => log.fail('increment', e))
      .finally(() => setBusy(false))
  }

  const pull = () => {
    setBusy(true)
    log.info('manual pull')
    read()
      .then(p => log.ok(p == null ? 'no value yet' : `count=${p.count} from ${p.writtenBy}`))
      .catch(e => log.fail('pull', e))
      .finally(() => setBusy(false))
  }

  const reset = () => {
    setBusy(true)
    active
      .removeItem(SHARED_KEY)
      .then(() => {
        setPayload(null)
        log.ok('removed')
      })
      .catch(e => log.fail('remove', e))
      .finally(() => setBusy(false))
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.h1}>Sync demo</Text>
        <Text style={styles.body}>
          Run this on several devices at once. Increment on one, and the others should
          update on their own - no polling.
        </Text>
      </View>

      <Section title="Provider">
        <ButtonRow>
          {PROVIDERS.map(p => (
            <Button
              key={p.name}
              label={`${p.name}${available[p.name] === false ? ' (n/a)' : ''}`}
              onPress={() => setSelected(p.name)}
              disabled={p.name === selected}
            />
          ))}
        </ButtonRow>
        <Text style={styles.body}>
          {PROVIDERS.find(p => p.name === selected)?.note}
          {selected === 'googleDrive' && !isGoogleDriveConfigured()
            ? ' - configure a token in the Drive tab first'
            : ''}
        </Text>
      </Section>

      <Section title="Shared counter">
        <View style={s.counterBox}>
          <Text style={s.counter}>{payload?.count ?? 0}</Text>
          <Text style={s.meta}>
            {payload == null
              ? 'no value yet'
              : `last written by ${payload.writtenBy} at `
                + new Date(payload.writtenAt).toLocaleTimeString()}
          </Text>
          <Text style={s.meta}>
            this device:
            {deviceId()}
          </Text>
        </View>
        <ButtonRow>
          <Button label="Increment" busy={busy} onPress={increment} />
          <Button label="Pull" busy={busy} onPress={pull} />
          <Button label="Reset" tone="danger" busy={busy} onPress={reset} />
        </ButtonRow>
      </Section>

      <Section title="Event log">
        <LogView entries={log.entries} height={240} />
        <ButtonRow>
          <Button label="Clear" onPress={log.clear} />
        </ButtonRow>
      </Section>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  counterBox: {
    alignItems: 'center',
    paddingVertical: 18,
    backgroundColor: colors.bg,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 4,
  },
  counter: {
    color: colors.accent,
    fontSize: 48,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  meta: {
    color: colors.textDim,
    fontFamily: mono,
    fontSize: 11,
  },
})
