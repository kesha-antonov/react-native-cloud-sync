import { type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { colors, radius, space } from '../theme'

interface Props {
  title: string
  subtitle?: string
  tint?: string
  badge?: string
  children: ReactNode
}

/**
 * A titled card grouping one operation's inputs and actions.
 *
 * The thin left rail normally picks up the active tab's identity color
 * (passed in as `tint`), so scrolling through a tab made of several
 * near-identical cards still reads as "still on this tab" instead of an
 * undifferentiated stack. `badge` is for a short, static callout - a
 * platform limitation, a size cap - that's worth seeing without reading the
 * subtitle every time.
 */
export function Section({ title, subtitle, tint = colors.borderStrong, badge, children }: Props) {
  return (
    <View style={s.card}>
      <View style={[s.rail, { backgroundColor: tint }]} />
      <View style={s.inner}>
        <View style={s.headerRow}>
          <Text style={s.title}>{title}</Text>
          {badge != null && (
            <View style={[s.badge, { backgroundColor: `${tint}26` }]}>
              <Text style={[s.badgeText, { color: tint }]}>{badge}</Text>
            </View>
          )}
        </View>
        {subtitle != null && <Text style={s.subtitle}>{subtitle}</Text>}
        <View style={s.body}>{children}</View>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  rail: {
    width: 3,
  },
  inner: {
    flex: 1,
    padding: space.md + 2,
    gap: space.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  body: {
    gap: space.sm,
    marginTop: 2,
  },
})
