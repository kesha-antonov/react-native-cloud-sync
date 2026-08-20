import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import type { SFSymbol } from 'sf-symbols-typescript'

import { DeviceBanner } from './src/components/DeviceBanner'
import { IconSymbol } from './src/components/IconSymbol'
import { MoreSheet } from './src/components/MoreSheet'
import { CloudKitTab } from './src/tabs/CloudKitTab'
import { DriveTab } from './src/tabs/DriveTab'
import { FaultsTab } from './src/tabs/FaultsTab'
import { FilesTab } from './src/tabs/FilesTab'
import { ICloudKVTab } from './src/tabs/ICloudKVTab'
import { StoreTab } from './src/tabs/StoreTab'
import { SyncDemoTab } from './src/tabs/SyncDemoTab'
import { colors, tabTint } from './src/theme'

const TABS = [
  {
    key: 'sync', label: 'Sync', tint: tabTint.sync,
    icon: 'arrow.triangle.2.circlepath' as SFSymbol, render: () => <SyncDemoTab />,
  },
  {
    key: 'kv', label: 'iCloud KV', tint: tabTint.kv,
    icon: 'key.icloud.fill' as SFSymbol, render: () => <ICloudKVTab />,
  },
  {
    key: 'cloudkit', label: 'CloudKit', tint: tabTint.cloudkit,
    icon: 'cloud.fill' as SFSymbol, render: () => <CloudKitTab />,
  },
  {
    key: 'drive', label: 'Drive', tint: tabTint.drive,
    icon: 'externaldrive.fill' as SFSymbol, render: () => <DriveTab />,
  },
  {
    key: 'files', label: 'Files', tint: tabTint.files,
    icon: 'doc.zipper' as SFSymbol, render: () => <FilesTab />,
  },
  {
    key: 'store', label: 'Store', tint: tabTint.store,
    icon: 'shippingbox.fill' as SFSymbol, render: () => <StoreTab />,
  },
  {
    key: 'faults', label: 'Faults', tint: tabTint.faults,
    icon: 'exclamationmark.triangle.fill' as SFSymbol, render: () => <FaultsTab />,
  },
] as const

// HIG's tab bar is a fixed row, not a horizontal scroller, and it caps at
// five visible items - UIKit's own UITabBarController folds anything past
// the fourth item into an automatic "More" screen rather than letting the
// bar itself scroll sideways. The previous pass here used a scrolling row of
// seven pill chips with a scroll-progress track standing in for "there's
// more" - readable once you found it, but not the platform convention, and
// nothing marked which four tabs were "primary" versus "the rest". Following
// the real HIG shape instead: the first four tabs stay pinned, and
// Files/Store/Faults move behind a fifth "More" item that opens a grouped
// list (MoreSheet) - exactly UIKit's own behavior for a >5-item tab bar.
const PRIMARY_TABS = TABS.slice(0, 4)
const OVERFLOW_TABS = TABS.slice(4)

type TabKey = (typeof TABS)[number]['key']

export default function App() {
  const [active, setActive] = useState<TabKey>('sync')
  const [moreOpen, setMoreOpen] = useState(false)
  const current = TABS.find(t => t.key === active) ?? TABS[0]
  const overflowActive = OVERFLOW_TABS.some(t => t.key === active)

  const selectTab = (key: TabKey) => {
    setActive(key)
    setMoreOpen(false)
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={s.root} edges={['top', 'left', 'right']}>
        <View style={s.topBar}>
          <View>
            <Text style={s.brand}>Cloud Sync</Text>
            <Text style={s.brandSub}>react-native-cloud-sync · example</Text>
          </View>
          <DeviceBanner />
        </View>

        <View style={s.body}>{current.render()}</View>

        {/*
          A second, independent SafeAreaView scoped to just the tab bar. The
          outer one deliberately excludes 'bottom' (the tab bar's own
          background should reach the true screen edge, not stop short and
          leave a gap of the page background showing beneath it), but that
          means nothing was accounting for the home-indicator inset on
          notched devices. SafeAreaView instances are independent consumers
          of the same context, so nesting one here adds bottom padding to
          this view only, without disturbing the outer one's edges.
        */}
        <SafeAreaView edges={['bottom']} style={s.tabBarWrap}>
          <View style={s.tabBar}>
            {PRIMARY_TABS.map((t) => {
              const isActive = t.key === active
              return (
                <TabBarItem
                  key={t.key}
                  label={t.label}
                  icon={t.icon}
                  tint={t.tint}
                  isActive={isActive}
                  onPress={() => selectTab(t.key)}
                />
              )
            })}
            <TabBarItem
              label="More"
              icon="ellipsis"
              tint={overflowActive ? current.tint : colors.textDim}
              isActive={overflowActive}
              onPress={() => setMoreOpen(true)}
            />
          </View>
        </SafeAreaView>

        <MoreSheet
          visible={moreOpen}
          items={OVERFLOW_TABS}
          activeKey={active}
          onSelect={selectTab}
          onClose={() => setMoreOpen(false)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

function TabBarItem({
  label,
  icon,
  tint,
  isActive,
  onPress,
}: {
  label: string
  icon: SFSymbol
  tint: string
  isActive: boolean
  onPress: () => void
}) {
  const color = isActive ? tint : colors.textDim
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: isActive }}
      style={({ pressed }) => [s.tab, pressed && s.tabPressed]}
    >
      <IconSymbol name={icon} size={23} color={color} weight={isActive ? 'semibold' : 'regular'} />
      <Text style={[s.tabLabel, { color }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: colors.bgElevated,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  brand: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  brandSub: {
    color: colors.textFaint,
    fontSize: 10.5,
    marginTop: 1,
  },
  body: {
    flex: 1,
  },
  tabBarWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  tab: {
    flex: 1,
    minHeight: 49,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: 6,
    paddingBottom: 4,
    paddingHorizontal: 2,
  },
  tabPressed: {
    opacity: 0.6,
  },
  tabLabel: {
    fontSize: 10.5,
    fontWeight: '600',
  },
})
