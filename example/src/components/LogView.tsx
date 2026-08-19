import { ScrollView, StyleSheet, Text, View } from 'react-native'

import { colors, mono } from '../theme'

export interface LogEntry {
  id: number
  at: string
  tone: 'info' | 'ok' | 'error' | 'event'
  text: string
}

const TONE_COLOR: Record<LogEntry['tone'], string> = {
  info: colors.textDim,
  ok: colors.ok,
  error: colors.error,
  event: colors.accent,
}

/**
 * A raw, append-only log of every call and every native event.
 *
 * This is the point of the demo: with four panes side by side you can see a
 * write on one device produce a `remoteChange` event on another, and you can see
 * exactly which typed error came back when something fails.
 */
export function LogView({ entries, height = 200 }: { entries: LogEntry[]; height?: number }) {
  return (
    <View style={[s.wrap, { height }]}>
      <ScrollView contentContainerStyle={s.content}>
        {entries.length === 0 && <Text style={s.empty}>No activity yet.</Text>}
        {entries.map(e => (
          <Text key={e.id} style={s.line}>
            <Text style={s.time}>
              {e.at}
              {' '}
            </Text>
            <Text style={{ color: TONE_COLOR[e.tone] }}>{e.text}</Text>
          </Text>
        ))}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
  },
  content: {
    padding: 8,
    gap: 2,
  },
  empty: {
    color: colors.textDim,
    fontSize: 12,
    fontStyle: 'italic',
  },
  line: {
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 16,
  },
  time: {
    color: colors.border,
  },
})
