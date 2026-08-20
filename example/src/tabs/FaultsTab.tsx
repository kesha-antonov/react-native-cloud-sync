import { useEffect, useMemo, useState } from 'react'
import { ScrollView } from 'react-native'

import {
  createMemoryProvider,
  ErrorCode,
  isRetryable,
  requiresUserAction,
  isCloudSyncError,
} from 'react-native-cloud-sync'

import { Button, ButtonRow } from '../components/Button'
import { TabHeader } from '../components/Header'
import { LogView } from '../components/LogView'
import { Section } from '../components/Section'
import { styles, tabTint } from '../theme'
import { useLog } from '../useLog'

const FAULTS = [
  { code: ErrorCode.NOT_SIGNED_IN, label: 'Not signed in' },
  { code: ErrorCode.NETWORK_UNAVAILABLE, label: 'Offline' },
  { code: ErrorCode.QUOTA_EXCEEDED, label: 'Quota exceeded' },
  { code: ErrorCode.RATE_LIMITED, label: 'Rate limited' },
  { code: ErrorCode.AUTH_EXPIRED, label: 'Auth expired' },
  { code: ErrorCode.CONFLICT, label: 'Conflict' },
] as const

/**
 * The failure paths, on demand.
 *
 * These are the states that decide whether a sync feature is actually reliable,
 * and they are the ones nobody tests - the most-used library in this space
 * gave up on simulator testing entirely and tests on real devices only, which
 * means "quota exceeded" and "account switched mid-session" are effectively
 * never exercised. Here they are one tap away, on any platform.
 */
export function FaultsTab() {
  const log = useLog()
  const [busy, setBusy] = useState(false)
  const provider = useMemo(() => createMemoryProvider({ initial: { 'demo/key': 'seeded' } }), [])

  // Without these, the emit buttons below would do nothing visible.
  useEffect(() => {
    const offAccount = provider.onAccountChange?.((e) => {
      log.event(`accountChange status=${e.status} identityChanged=${String(e.identityChanged)}`)
    })
    const offRemote = provider.onRemoteChange?.((e) => {
      log.event(`remoteChange reason=${e.reason} keys=[${e.keys.join(', ')}]`)
    })
    return () => {
      offAccount?.()
      offRemote?.()
    }
  }, [provider, log])

  const inject = (code: (typeof FAULTS)[number]['code'], label: string) => () => {
    setBusy(true)
    provider.setFault('getItem', { code, retryAfterMs: code === ErrorCode.RATE_LIMITED ? 30_000 : undefined })
    log.info(`injected ${label}`)

    provider
      .getItem('demo/key')
      .then(v => log.ok(`getItem -> ${String(v)}`))
      .catch((e) => {
        log.fail('getItem', e)
        if (isCloudSyncError(e))
          log.event(
            `classification: retryable=${String(isRetryable(e))} `
            + `needsUserAction=${String(requiresUserAction(e))}`
          )
      })
      .finally(() => {
        provider.setFault('getItem', null)
        setBusy(false)
      })
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <TabHeader
        eyebrow="Error contract"
        title="Fault injection"
        tint={tabTint.faults}
        description="Every failure below is a distinct, typed rejection - not a null. Watch the log:
          each one reports its code plus whether it is worth retrying automatically or
          needs the user to do something."
      />

      <Section
        title="Inject a failure"
        tint={tabTint.faults}
        subtitle="Each button installs a fault, performs a read, then clears it."
      >
        <ButtonRow>
          {FAULTS.map(f => (
            <Button key={f.code} label={f.label} busy={busy} onPress={inject(f.code, f.label)} />
          ))}
        </ButtonRow>
      </Section>

      <Section
        title="Transient failure that heals"
        tint={tabTint.faults}
        subtitle="Fails twice, then succeeds - the shape retry and outbox logic has to converge on."
      >
        <ButtonRow>
          <Button
            label="Fail twice then succeed"
            busy={busy}
            onPress={() => {
              provider.setFault('getItem', { code: ErrorCode.NETWORK_UNAVAILABLE, times: 2 })
              log.info('injected offline x2')
              const attempt = (n: number): void => {
                provider
                  .getItem('demo/key')
                  .then(v => log.ok(`attempt ${n} -> ${String(v)}`))
                  .catch((e) => {
                    log.fail(`attempt ${n}`, e)
                    if (n < 3) attempt(n + 1)
                  })
              }
              attempt(1)
            }}
          />
        </ButtonRow>
      </Section>

      <Section
        title="Account switch"
        tint={tabTint.faults}
        subtitle="The event that leaks data between users. An app that caches user-scoped state
          must drop it when identityChanged is true."
      >
        <ButtonRow>
          <Button
            label="Emit identity change"
            onPress={() => provider.emitAccountChange({ status: 'available', identityChanged: true })}
          />
          <Button
            label="Emit remote change"
            onPress={() => provider.emitRemoteChange({ keys: ['demo/key'], reason: 'serverChange' })}
          />
        </ButtonRow>
      </Section>

      <Section title="Log" tint={tabTint.faults}>
        <LogView entries={log.entries} height={220} />
        <ButtonRow>
          <Button label="Clear" onPress={log.clear} />
        </ButtonRow>
      </Section>
    </ScrollView>
  )
}
