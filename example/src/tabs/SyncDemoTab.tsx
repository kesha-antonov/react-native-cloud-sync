import { useCallback, useEffect, useState } from 'react'
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  cloudKit,
  createCloudStore,
  googleDrive,
  icloudKV,
  isGoogleDriveConfigured,
  resolveByTimestamp,
  type CloudProvider,
  type CloudStore,
  type ProviderName,
} from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { TabHeader } from '../components/Header'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { colors, mono, styles, tabTint } from '../theme'
import { deviceId } from '../deviceId'
import { useLog } from '../useLog'

const SHARED_KEY = 'demo/shared-counter'

const PROVIDERS: { name: ProviderName; provider: CloudProvider; note: string }[] = [
  { name: 'icloudKV', provider: icloudKV, note: 'Apple only' },
  { name: 'cloudKit', provider: cloudKit, note: 'iOS native · Android/web REST' },
  { name: 'googleDrive', provider: googleDrive, note: 'every platform' },
]

/**
 * "Selected" is one raw provider, or this: the store facade writing to both
 * icloudKV and googleDrive at once. Module scope, like the raw providers
 * above, and for the same reason StoreTab's providers moved out of a
 * component-scoped useMemo with an unstable dependency: creating a store is
 * pure configuration, closes over nothing from render state, and a store
 * created fresh on every render would silently drop every write between one
 * render and the next. There is exactly one of these for the app's lifetime.
 *
 * `resolve: resolveByTimestamp('writtenAt')` is what makes this a genuine
 * two-way demo rather than "icloudKV always wins": without a resolver the
 * facade returns the first non-null value in provider order and stops
 * looking, so an Apple device would keep serving its own stale iCloud copy
 * without ever reading the newer one a non-Apple device wrote to Drive.
 */
const mirrorStore: CloudStore = createCloudStore({
  providers: ['icloudKV', 'googleDrive'],
  writeMode: 'mirror',
  resolve: resolveByTimestamp('writtenAt'),
})

type Selection = ProviderName | 'mirror'

interface Payload {
  count: number
  writtenBy: string
  writtenAt: number
}

/**
 * What each raw backend actually holds, read directly (not through the
 * facade) so mirroring is visibly provable rather than asserted.
 */
interface MirrorCopies {
  icloudKV: string | null
  googleDrive: string | null
}

function summarizeCopy(raw: string | null): string {
  if (raw == null) return '-'
  try {
    const p = JSON.parse(raw) as Payload
    return `count=${p.count} (${p.writtenBy})`
  }
  catch {
    return raw.slice(0, 32)
  }
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
  const [selected, setSelected] = useState<Selection>(
    Platform.OS === 'ios' || Platform.OS === 'macos' ? 'icloudKV' : 'googleDrive'
  )
  const [payload, setPayload] = useState<Payload | null>(null)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState<Partial<Record<ProviderName, boolean>>>({})
  const [mirrorCopies, setMirrorCopies] = useState<MirrorCopies | null>(null)

  const active = selected === 'mirror'
    ? mirrorStore
    : PROVIDERS.find(p => p.name === selected)?.provider ?? icloudKV

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

  // Proof, not assertion: read each backend directly (bypassing the facade)
  // so the "mirror" claim is something you can see rather than take on faith.
  // Reruns whenever the mirrored payload changes, so it tracks every
  // increment/pull/reset without those handlers needing to know it exists.
  useEffect(() => {
    if (selected !== 'mirror') {
      setMirrorCopies(null)
      return
    }
    let cancelled = false
    Promise.all([
      icloudKV.getItem(SHARED_KEY).catch(() => null),
      googleDrive.getItem(SHARED_KEY).catch(() => null),
    ]).then(([kv, drive]) => {
      if (!cancelled) setMirrorCopies({ icloudKV: kv, googleDrive: drive })
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [selected, payload])

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
      <TabHeader
        eyebrow="Live sync"
        title="Sync demo"
        tint={tabTint.sync}
        description="Run this on several devices at once. Increment on one, and the others should
          update on their own - no polling."
      />

      <Section title="Provider" tint={tabTint.sync}>
        <ButtonRow>
          {PROVIDERS.map(p => (
            <Button
              key={p.name}
              label={`${p.name}${available[p.name] === false ? ' (n/a)' : ''}`}
              onPress={() => setSelected(p.name)}
              selected={p.name === selected}
              disabled={p.name === selected}
            />
          ))}
          <Button
            label="mirror (iCloud + Drive)"
            onPress={() => setSelected('mirror')}
            selected={selected === 'mirror'}
            disabled={selected === 'mirror'}
          />
        </ButtonRow>
        <Text style={styles.body}>
          {selected === 'mirror'
            ? 'Every write goes to icloudKV and googleDrive at once; every read returns '
            + 'whichever copy has the newer writtenAt. A device with only one of the two '
            + 'available still succeeds - the write just lands on the one it has.'
            : PROVIDERS.find(p => p.name === selected)?.note}
          {(selected === 'googleDrive' || selected === 'mirror') && !isGoogleDriveConfigured()
            ? ' - configure a token in the Drive tab first'
            : ''}
        </Text>
      </Section>

      <Section title="Shared counter" tint={tabTint.sync}>
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
        {selected === 'mirror' && mirrorCopies != null && (
          <View style={s.mirrorBox}>
            <Text style={s.mirrorLabel}>
              icloudKV:
              {' '}
              {summarizeCopy(mirrorCopies.icloudKV)}
            </Text>
            <Text style={s.mirrorLabel}>
              googleDrive:
              {' '}
              {summarizeCopy(mirrorCopies.googleDrive)}
            </Text>
          </View>
        )}
        <ButtonRow>
          <Button label="Increment" busy={busy} onPress={increment} />
          <Button label="Pull" busy={busy} onPress={pull} />
          <Button label="Reset" tone="danger" busy={busy} onPress={reset} />
        </ButtonRow>
      </Section>

      <Section title="Event log" tint={tabTint.sync}>
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
  mirrorBox: {
    marginTop: 10,
    gap: 3,
  },
  mirrorLabel: {
    color: colors.textDim,
    fontFamily: mono,
    fontSize: 11.5,
  },
})
