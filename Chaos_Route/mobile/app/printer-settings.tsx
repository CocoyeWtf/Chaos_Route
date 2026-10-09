/* Configuration imprimante Bluetooth portable / Portable Bluetooth printer setup.

   Liste les imprimantes Bluetooth Classic appairees au telephone/tablette,
   permet d'en choisir une et de tester l'impression (ZPL ou TSPL selon le
   protocole declare). Le choix est persiste dans usePrinterStore.
*/

import { useCallback, useEffect, useState } from 'react'
import {
  View, Text, TouchableOpacity, FlatList, ActivityIndicator,
  Alert, StyleSheet, Linking,
} from 'react-native'
import { useFocusEffect } from 'expo-router'
import { COLORS } from '../constants/config'
import {
  isBluetoothModuleAvailable,
  listPairedPrinters,
  printRaw,
  disconnectPrinter,
  requestBluetoothPermissions,
  TEST_ZPL,
  TEST_TSPL,
  type BluetoothPrinter,
} from '../services/bluetoothPrint'
import { usePrinterStore, type PrinterProtocol } from '../stores/usePrinterStore'

/* Heuristique nom de l'imprimante -> protocole / Printer name -> protocol heuristic.
   Utilisateur peut override manuellement apres selection.
*/
function guessProtocol(name: string): PrinterProtocol {
  const n = name.toUpperCase()
  if (n.includes('TSC') || n.includes('ALPHA')) return 'TSPL'
  // Par defaut on tente ZPL (Zebra) / Default ZPL (Zebra)
  return 'ZPL'
}

export default function PrinterSettingsScreen() {
  const savedPrinter = usePrinterStore((s) => s.printer)
  const isPrinterLoading = usePrinterStore((s) => s.isLoading)
  const loadSavedPrinter = usePrinterStore((s) => s.load)
  const setSavedPrinter = usePrinterStore((s) => s.setPrinter)
  const clearSavedPrinter = usePrinterStore((s) => s.clearPrinter)

  const [devices, setDevices] = useState<BluetoothPrinter[]>([])
  const [scanning, setScanning] = useState(false)
  const [testing, setTesting] = useState(false)
  const [moduleAvailable] = useState(() => isBluetoothModuleAvailable())

  useEffect(() => {
    loadSavedPrinter()
  }, [loadSavedPrinter])

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const ok = await requestBluetoothPermissions()
      if (!ok) {
        Alert.alert(
          'Permission refusee',
          'Bluetooth requis pour detecter les imprimantes. Activez les permissions dans les parametres Android.',
          [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Ouvrir parametres', onPress: () => Linking.openSettings() },
          ],
        )
        return
      }
      const list = await listPairedPrinters()
      setDevices(list)
      if (list.length === 0) {
        Alert.alert(
          'Aucune imprimante appairee',
          'Appairez d\'abord votre imprimante portable (Zebra, TSC) dans les parametres Bluetooth d\'Android, puis revenez ici.',
          [
            { text: 'OK' },
            { text: 'Ouvrir Bluetooth', onPress: () => Linking.openSettings() },
          ],
        )
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      Alert.alert('Erreur Bluetooth', msg)
    } finally {
      setScanning(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      if (moduleAvailable) {
        scan()
      }
    }, [moduleAvailable, scan]),
  )

  const handleSelect = useCallback(async (device: BluetoothPrinter) => {
    const protocol = guessProtocol(device.name)
    // La connexion est gardee ouverte entre deux etiquettes (#86) : changer
    // d'imprimante sans la liberer laisserait un socket ouvert vers la
    // precedente. / The link is kept open between labels; release it here.
    await disconnectPrinter()
    await setSavedPrinter({
      address: device.address,
      name: device.name,
      protocol,
    })
  }, [setSavedPrinter])

  const handleSwitchProtocol = useCallback(async () => {
    if (!savedPrinter) return
    const next: PrinterProtocol = savedPrinter.protocol === 'ZPL' ? 'TSPL' : 'ZPL'
    await setSavedPrinter({ ...savedPrinter, protocol: next })
  }, [savedPrinter, setSavedPrinter])

  const handleTestPrint = useCallback(async () => {
    if (!savedPrinter) return
    setTesting(true)
    try {
      const payload = savedPrinter.protocol === 'ZPL' ? TEST_ZPL : TEST_TSPL
      const result = await printRaw(savedPrinter.address, payload)
      if (result.success) {
        Alert.alert(
          'Test envoye',
          `Etiquette de test envoyee a ${savedPrinter.name} (${savedPrinter.protocol}).`,
        )
      } else {
        Alert.alert(
          'Echec du test',
          result.error || 'Impression test echouee. Verifiez que l\'imprimante est allumee et a porte.',
        )
      }
    } finally {
      setTesting(false)
    }
  }, [savedPrinter])

  if (!moduleAvailable) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorTitle}>Module Bluetooth absent</Text>
        <Text style={styles.errorNote}>
          Le module natif d&apos;impression Bluetooth n&apos;est pas encore inclus dans
          cette version de l&apos;app. Une mise a jour est requise pour utiliser
          l&apos;imprimante portable. Contactez votre administrateur.
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {/* Imprimante actuelle / Current printer */}
      {savedPrinter ? (
        <View style={styles.currentBox}>
          <Text style={styles.currentTitle}>Imprimante actuelle</Text>
          <Text style={styles.currentName}>{savedPrinter.name}</Text>
          <Text style={styles.currentAddr}>{savedPrinter.address}</Text>
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.protocolBtn}
              onPress={handleSwitchProtocol}
            >
              <Text style={styles.protocolText}>Protocole : {savedPrinter.protocol}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.testBtn, testing && { opacity: 0.5 }]}
              onPress={handleTestPrint}
              disabled={testing}
            >
              <Text style={styles.testBtnText}>
                {testing ? 'Envoi...' : 'Test impression'}
              </Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => { disconnectPrinter(); clearSavedPrinter() }} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Oublier cette imprimante</Text>
          </TouchableOpacity>
        </View>
      ) : (
        isPrinterLoading ? (
          <ActivityIndicator color={COLORS.primary} />
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>Aucune imprimante selectionnee</Text>
            <Text style={styles.emptyHint}>
              Selectionnez ci-dessous une imprimante appairee a l&apos;appareil.
            </Text>
          </View>
        )
      )}

      {/* Liste imprimantes appairees / Paired printers list */}
      <View style={styles.listHeader}>
        <Text style={styles.listTitle}>Imprimantes appairees</Text>
        <TouchableOpacity onPress={scan} disabled={scanning}>
          <Text style={[styles.linkText, scanning && { opacity: 0.5 }]}>
            {scanning ? 'Recherche...' : 'Rafraichir'}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={devices}
        keyExtractor={(d) => d.address}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={
          scanning ? (
            <ActivityIndicator color={COLORS.primary} style={{ marginTop: 16 }} />
          ) : (
            <Text style={styles.emptyListText}>
              Aucune imprimante detectee. Appairez-la dans les parametres Bluetooth
              d&apos;Android puis cliquez Rafraichir.
            </Text>
          )
        }
        renderItem={({ item }) => {
          const selected = savedPrinter?.address === item.address
          return (
            <TouchableOpacity
              style={[styles.deviceRow, selected && styles.deviceRowSelected]}
              onPress={() => handleSelect(item)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.deviceName}>{item.name}</Text>
                <Text style={styles.deviceAddr}>{item.address}</Text>
              </View>
              {selected && <Text style={styles.selectedBadge}>OK</Text>}
            </TouchableOpacity>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgPrimary,
    padding: 16,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.danger,
    textAlign: 'center',
    marginTop: 60,
    marginBottom: 16,
  },
  errorNote: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 24,
  },
  currentBox: {
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  currentTitle: {
    fontSize: 11,
    color: COLORS.primary,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  currentName: {
    fontSize: 17,
    color: COLORS.textPrimary,
    fontWeight: '700',
  },
  currentAddr: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  protocolBtn: {
    backgroundColor: COLORS.bgTertiary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  protocolText: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  testBtn: {
    flex: 1,
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  testBtnText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 13,
  },
  clearBtn: {
    marginTop: 10,
    alignItems: 'center',
  },
  clearBtnText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  emptyBox: {
    padding: 20,
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 12,
    marginBottom: 16,
  },
  emptyText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptyHint: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  listTitle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  linkText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyListText: {
    color: COLORS.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
    paddingHorizontal: 16,
    lineHeight: 18,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  deviceRowSelected: {
    borderColor: COLORS.primary,
  },
  deviceName: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  deviceAddr: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  selectedBadge: {
    color: COLORS.primary,
    fontWeight: '800',
    fontSize: 13,
  },
})
