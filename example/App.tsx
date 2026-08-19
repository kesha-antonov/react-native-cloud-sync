import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'

import { DeviceBanner } from './src/components/DeviceBanner'
import { CloudKitTab } from './src/tabs/CloudKitTab'
import { DriveTab } from './src/tabs/DriveTab'
import { FaultsTab } from './src/tabs/FaultsTab'
import { ICloudKVTab } from './src/tabs/ICloudKVTab'
import { StoreTab } from './src/tabs/StoreTab'
import { SyncDemoTab } from './src/tabs/SyncDemoTab'
import { colors } from './src/theme'

const TABS = [
  { key: 'sync', label: 'Sync', render: () => <SyncDemoTab /> },
  { key: 'kv', label: 'iCloud KV', render: () => <ICloudKVTab /> },
  { key: 'cloudkit', label: 'CloudKit', render: () => <CloudKitTab /> },
  { key: 'drive', label: 'Drive', render: () => <DriveTab /> },
  { key: 'store', label: 'Store', render: () => <StoreTab /> },
  { key: 'faults', label: 'Faults', render: () => <FaultsTab /> },
] as const

export default function App() {
  const [active, setActive] = useState<(typeof TABS)[number]['key']>('sync')
  const current = TABS.find(t => t.key === active) ?? TABS[0]

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={s.root} edges={['top', 'left', 'right']}>
        <DeviceBanner />
        <View style={s.body}>{current.render()}</View>
        <View style={s.tabBarWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.tabBar}
          >
            {TABS.map(t => (
              <Pressable
                key={t.key}
                onPress={() => setActive(t.key)}
                style={[s.tab, t.key === active && s.tabActive]}
              >
                <Text style={[s.tabLabel, t.key === active && s.tabLabelActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  body: {
    flex: 1,
  },
  tabBarWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.panel,
  },
  tabBar: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: colors.panelAlt,
  },
  tabLabel: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: colors.text,
  },
})
