import { useRef } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import { colors, mono, radius } from '../theme'

export interface LogEntry {
  id: number
  at: string
  tone: 'info' | 'ok' | 'error' | 'event'
  text: string
}

const TONE: Record<LogEntry['tone'], { color: string; glyph: string }> = {
  info: { color: colors.textDim, glyph: '·' },
  ok: { color: colors.ok, glyph: '✓' },
  error: { color: colors.error, glyph: '✕' },
  event: { color: colors.accent, glyph: '⇄' },
}

/**
 * A raw, append-only log of every call and every native event.
 *
 * This is the point of the demo: with four panes side by side you can see a
 * write on one device produce a `remoteChange` event on another, and you can
 * see exactly which typed error came back when something fails. Each line
 * keeps a tone-colored rail and glyph in addition to colored text, so the
 * tone still reads at a glance even for a wrapped multi-line message. The
 * view auto-scrolls to the newest entry - a log you have to chase after
 * every tap defeats the point of watching it live.
 */
export function LogView({ entries, height = 200 }: { entries: LogEntry[]; height?: number }) {
  const scrollRef = useRef<ScrollView>(null)

  return (
    <View style={[s.wrap, { height }]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={s.content}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {entries.length === 0 && <Text style={s.empty}>No activity yet - run an operation above.</Text>}
        {entries.map((e) => {
          const tone = TONE[e.tone]
          return (
            <View key={e.id} style={s.row}>
              <View style={[s.rail, { backgroundColor: tone.color }]} />
              <Text style={s.line}>
                <Text style={s.time}>
                  {e.at}
                  {'  '}
                </Text>
                <Text style={{ color: tone.color }}>
                  {tone.glyph}
                  {' '}
                  {e.text}
                </Text>
              </Text>
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: {
    backgroundColor: colors.panelSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  content: {
    padding: 8,
    gap: 4,
  },
  empty: {
    color: colors.textFaint,
    fontSize: 12,
    fontStyle: 'italic',
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  rail: {
    width: 2,
    borderRadius: 1,
    marginTop: 3,
    alignSelf: 'stretch',
  },
  line: {
    flex: 1,
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 16,
  },
  time: {
    color: colors.textFaint,
  },
})
