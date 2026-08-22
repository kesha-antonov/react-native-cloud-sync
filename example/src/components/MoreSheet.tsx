import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { SFSymbol } from 'sf-symbols-typescript'

import { colors, fontFamily, radius, space } from '../theme'
import { IconSymbol } from './IconSymbol'

export interface MoreItem<K extends string = string> {
  key: K
  label: string
  tint: string
  icon: SFSymbol
}

interface Props<K extends string> {
  visible: boolean
  items: readonly MoreItem<K>[]
  activeKey: K
  onSelect: (key: K) => void
  onClose: () => void
}

/**
 * The overflow surface for tabs that don't fit in the fixed tab bar.
 *
 * HIG tab bars are a fixed row, not a scroller, and cap at five visible
 * items - a sixth-and-beyond item is what UIKit's own `UITabBarController`
 * folds into an automatic "More" screen (a plain table of the rest). This is
 * that pattern, hand-rolled: a page-sheet modal with one inset-grouped list,
 * a row per overflow tab, and a checkmark on whichever one is currently
 * showing (this is a flat picker, not a drill-in, so a checkmark reads
 * better than a chevron that promises another screen behind each row).
 */
export function MoreSheet<K extends string>({ visible, items, activeKey, onSelect, onClose }: Props<K>) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={s.sheet} edges={['top', 'bottom']}>
        <View style={s.header}>
          <Text style={s.title}>More</Text>
          <Pressable
            testID="more-done"
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={({ pressed }) => [s.done, pressed && s.donePressed]}
          >
            <Text style={s.doneText}>Done</Text>
          </Pressable>
        </View>

        <View style={s.list}>
          {items.map((item, i) => {
            const isActive = item.key === activeKey
            return (
              <Pressable
                key={item.key}
                testID={`more-item-${item.key}`}
                onPress={() => onSelect(item.key)}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: isActive }}
                style={({ pressed }) => [
                  s.row,
                  i > 0 && s.rowBorder,
                  pressed && s.rowPressed,
                ]}
              >
                <IconSymbol name={item.icon} color={item.tint} size={22} />
                <Text style={[s.rowLabel, isActive && { color: item.tint }]}>{item.label}</Text>
                {isActive && <IconSymbol name="checkmark" color={item.tint} size={18} weight="semibold" />}
              </Pressable>
            )
          })}
        </View>
      </SafeAreaView>
    </Modal>
  )
}

const s = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontFamily: fontFamily.ui800,
    letterSpacing: -0.3,
  },
  done: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  donePressed: {
    opacity: 0.6,
  },
  doneText: {
    color: colors.accent,
    fontSize: 16,
    fontFamily: fontFamily.ui600,
  },
  list: {
    marginHorizontal: space.lg,
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 50,
    paddingHorizontal: space.md + 2,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.panelAlt,
  },
  rowLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontFamily: fontFamily.ui500,
  },
})
