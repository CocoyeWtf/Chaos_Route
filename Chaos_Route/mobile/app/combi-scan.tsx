/* Ecran scan combis + reprises au PDV / Combi & pickup scan screen at PDV.
   Flow :
   1. Scanner code-barres PDV (obligatoire) -> identifie le point de vente
   2. Scanner librement : combis (RM######) et/ou etiquettes reprises (RET-xxx)
   3. Pour les COMBIS : il faut d'abord scanner le QR de l'etiquette de declaration
      combi (RET-xxx avec support is_combi=true), puis chaque combi individuel sera
      lie a cette declaration. A la fin, bouton "Terminer reprise combi" pour cloturer
      la reprise (le stock PDV est decremente du nb reellement scanne).
   Geoloc enregistree a chaque scan.
*/

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Vibration, SafeAreaView,
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Location from 'expo-location'
import { useRouter } from 'expo-router'
import api from '../services/api'
import { COLORS } from '../constants/config'
import { TorchToggleButton } from '../components/TorchToggleButton'
import { ControlPhotoCapture } from '../components/ControlPhotoCapture'
import { useDeviceStore } from '../stores/useDeviceStore'

/* Types de scan / Scan types */
type ScanType = 'PDV' | 'COMBI' | 'LABEL'

interface ScanEntry {
  id: string
  type: ScanType
  barcode: string
  pdvCode?: string
  pdvName?: string
  supportType?: string
  timestamp: string
  status: string
}

/** Extraire un code PDV depuis un QR/barcode (peut contenir une URL ou juste le code) */
function extractPdvCode(data: string): string | null {
  // Code numerique pur (3-6 chiffres) — ex: "02805"
  if (/^\d{3,6}$/.test(data)) return data
  // Code alphanumerique court (max 20 chars, pas RM ni RET) — ex: "PDV02805"
  if (/^[A-Za-z0-9_-]{2,20}$/.test(data) && !data.startsWith('RET-') && !/^RM\d/i.test(data)) return data
  // URL contenant un code PDV — ex: "https://xxx/pdv/02805" ou "https://xxx?code=02805"
  const urlMatch = data.match(/\/pdv\/([A-Za-z0-9_-]+)/) || data.match(/[?&]code=([A-Za-z0-9_-]+)/)
  if (urlMatch) return urlMatch[1]
  // Dernier segment numerique d'une URL
  const lastNumMatch = data.match(/\/(\d{3,6})(?:[/?#]|$)/)
  if (lastNumMatch) return lastNumMatch[1]
  return null
}

/** Detecter le type de code-barres / Detect barcode type */
function detectBarcodeType(data: string): { type: ScanType; pdvCode?: string } | null {
  if (/^RM\d{4,8}$/i.test(data)) return { type: 'COMBI' }
  if (data.startsWith('RET-')) return { type: 'LABEL' }
  const pdvCode = extractPdvCode(data)
  if (pdvCode) return { type: 'PDV', pdvCode }
  return null
}

/** Obtenir la position GPS / Get GPS position */
async function getGeoLoc(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync()
    if (status !== 'granted') return null
    const loc = await Location.getLastKnownPositionAsync()
    if (loc) return { latitude: loc.coords.latitude, longitude: loc.coords.longitude, accuracy: loc.coords.accuracy ?? 0 }
    const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
    return { latitude: fresh.coords.latitude, longitude: fresh.coords.longitude, accuracy: fresh.coords.accuracy ?? 0 }
  } catch {
    return null
  }
}

/** Etiquette de declaration combi active / Active combi declaration label */
interface ActiveCombiLabel {
  labelId: number
  labelCode: string
  pickupRequestId: number
  pdvCode: string
  declaredQuantity: number
  alreadyScannedCount: number
}

export default function CombiScanScreen() {
  const router = useRouter()
  const [permission, requestPermission] = useCameraPermissions()

  // Phase : null = scan PDV, string = PDV scanne (scan libre)
  const [activePdv, setActivePdv] = useState<{ code: string; name: string } | null>(null)
  // Declaration combi active pour ce PDV / Active combi declaration for this PDV
  const [activeCombi, setActiveCombi] = useState<ActiveCombiLabel | null>(null)
  // Compteur de scans combi sur la session courante / Combi scan counter for current session
  const [combiSessionCount, setCombiSessionCount] = useState(0)
  const [closing, setClosing] = useState(false)
  const [scans, setScans] = useState<ScanEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [lastScanned, setLastScanned] = useState('')
  const [torchOn, setTorchOn] = useState(false)
  const lastScanRef = useRef<string>('')
  const lastScanTimeRef = useRef(0)
  const controlMode = useDeviceStore((s) => s.controlMode)
  const [pendingScan, setPendingScan] = useState<{
    type: 'COMBI' | 'LABEL'
    data: string
    geo: { latitude: number; longitude: number; accuracy: number } | null
    ts: string
  } | null>(null)

  /* Charger les scans combis du jour / Load today's combi scans */
  useEffect(() => {
    api.get('/driver/combi-scans/')
      .then(({ data }) => {
        const entries: ScanEntry[] = data.map((s: any) => ({
          id: `combi-${s.id}`,
          type: 'COMBI' as ScanType,
          barcode: s.barcode,
          pdvCode: s.pdv_code_scanned,
          pdvName: s.pdv_name,
          timestamp: s.timestamp,
          status: 'OK',
        }))
        setScans(entries)
      })
      .catch(() => {})
  }, [])

  const handleBarCodeScanned = useCallback(async ({ data: rawData }: { data: string }) => {
    const data = rawData.trim()
    const now = Date.now()
    if (data === lastScanRef.current && now - lastScanTimeRef.current < 3000) return
    lastScanRef.current = data
    lastScanTimeRef.current = now

    const detected = detectBarcodeType(data.toUpperCase())
    if (!detected) return

    const { type, pdvCode: extractedPdvCode } = detected

    Vibration.vibrate(100)

    // Phase 1 : Scan PDV
    if (type === 'PDV') {
      const searchCode = extractedPdvCode || data
      setLoading(true)
      try {
        // Verifier que le PDV existe via l'API PDV
        const { data: pdv } = await api.get(`/driver/validate-pdv/${encodeURIComponent(searchCode)}`)
        setActivePdv({ code: pdv.code, name: pdv.name })
        setLastScanned(`PDV ${pdv.code} — ${pdv.name}`)
        setTimeout(() => setLastScanned(''), 3000)
      } catch (err: any) {
        const detail = err?.response?.data?.detail || 'Impossible de verifier le PDV'
        Alert.alert('PDV non trouve', detail)
      } finally {
        setLoading(false)
      }
      return
    }

    // Phase 2 : Scan libre (combi ou etiquette) — PDV requis
    if (!activePdv) {
      Alert.alert('PDV requis', 'Scannez d\'abord le code-barres du PDV avant de scanner les contenants.')
      return
    }

    const geo = await getGeoLoc()
    const ts = new Date().toISOString()

    // Mode controle : capturer photo avant de soumettre / Control mode: capture photo before submitting
    if (controlMode && (type === 'COMBI' || type === 'LABEL')) {
      setPendingScan({ type, data, geo, ts })
      return
    }

    await _submitScan(type, data, geo, ts)
    setTimeout(() => setLastScanned(''), 2000)
  }, [activePdv, controlMode])

  /** Soumettre le scan au serveur (combi ou label) / Submit scan to server */
  const _submitScan = useCallback(async (
    type: 'COMBI' | 'LABEL',
    data: string,
    geo: { latitude: number; longitude: number; accuracy: number } | null,
    ts: string,
    photoUri?: string,
  ) => {
    if (type === 'COMBI') {
      // Combi : declaration combi active obligatoire / Combi: active combi declaration required
      if (!activeCombi) {
        Alert.alert(
          'Etiquette de declaration requise',
          'Scannez d\'abord le QR de l\'etiquette de declaration combi affichee par le PDV.',
        )
        return
      }
      try {
        const { data: scan } = await api.post('/driver/combi-scan/', {
          barcode: data,
          pdv_code_scanned: activePdv!.code,
          timestamp: ts,
          latitude: geo?.latitude ?? null,
          longitude: geo?.longitude ?? null,
          accuracy: geo?.accuracy ?? null,
          pickup_label_id: activeCombi.labelId,
        })
        setScans((prev) => {
          if (prev.find((s) => s.barcode === data && s.type === 'COMBI')) return prev
          return [{
            id: `combi-${scan.id}`,
            type: 'COMBI',
            barcode: scan.barcode,
            pdvCode: activePdv!.code,
            pdvName: activePdv!.name,
            timestamp: ts,
            status: 'OK',
          }, ...prev]
        })
        setCombiSessionCount((c) => c + 1)
        setLastScanned(`COMBI ${data}`)
        // Upload evidence si photo fournie / Upload evidence if photo provided
        if (photoUri) {
          await _uploadEvidence('COMBI_SCAN', photoUri, geo, ts, { combi_barcode: data })
        }
      } catch (err: any) {
        Alert.alert('Erreur', err?.response?.data?.detail || 'Erreur scan combi')
      }
    } else if (type === 'LABEL') {
      // Tenter d'abord scan-arrival : si c'est une etiquette de declaration combi,
      // active le mode combi pour ce PDV. Sinon (400 specifique), fallback sur
      // standalone-pickup pour les reprises classiques (non combis).
      // First try scan-arrival: if it's a combi declaration label, activate combi
      // mode. Else (specific 400), fall back to standalone-pickup for non-combi.
      let isCombiDeclaration = false
      try {
        const { data: arrival } = await api.post(
          `/driver/pickup-labels/${encodeURIComponent(data)}/scan-arrival`
            + `?pdv_code=${encodeURIComponent(activePdv!.code)}`,
        )
        isCombiDeclaration = true
        setActiveCombi({
          labelId: arrival.label_id,
          labelCode: arrival.label_code,
          pickupRequestId: arrival.pickup_request_id,
          pdvCode: arrival.pdv_code,
          declaredQuantity: arrival.declared_quantity,
          alreadyScannedCount: arrival.already_scanned_count,
        })
        setCombiSessionCount(0)
        setScans((prev) => {
          if (prev.find((s) => s.barcode === data && s.type === 'LABEL')) return prev
          return [{
            id: `label-${arrival.label_code}`,
            type: 'LABEL',
            barcode: arrival.label_code,
            pdvCode: arrival.pdv_code,
            pdvName: arrival.pdv_name,
            supportType: `Declaration combi (${arrival.declared_quantity})`,
            timestamp: ts,
            status: 'COMBI',
          }, ...prev]
        })
        setLastScanned(`Declaration combi : ${arrival.declared_quantity} attendu(s)`)
        if (photoUri) {
          await _uploadEvidence('PICKUP', photoUri, geo, ts, { label_code: data })
        }
      } catch (err: any) {
        const status = err?.response?.status
        const detail = err?.response?.data?.detail || ''
        // 400 + message indiquant "pas une etiquette combi" = etiquette classique
        // 400 + "not a combi label" message = standard pickup label
        const isNonCombi400 = status === 400 && /combi/i.test(detail) && /pas|n'est|not/i.test(detail)
        if (!isNonCombi400) {
          Alert.alert('Erreur', detail || 'Erreur scan etiquette')
          setTimeout(() => setLastScanned(''), 2000)
          return
        }
      }

      if (!isCombiDeclaration) {
        // Fallback : etiquette reprise classique / Fallback: standard pickup label
        try {
          const { data: scan } = await api.post(
            `/driver/standalone-pickup/${encodeURIComponent(data)}`
              + `?pdv_code=${encodeURIComponent(activePdv!.code)}`,
          )
          setScans((prev) => {
            if (prev.find((s) => s.barcode === data && s.type === 'LABEL')) return prev
            return [{
              id: `label-${scan.label_code}`,
              type: 'LABEL',
              barcode: scan.label_code,
              pdvCode: scan.pdv_code,
              pdvName: scan.pdv_name,
              supportType: scan.support_type_name,
              timestamp: ts,
              status: scan.status || 'OK',
            }, ...prev]
          })
          setLastScanned(`REPRISE ${data}`)
          if (photoUri) {
            await _uploadEvidence('PICKUP', photoUri, geo, ts, { label_code: data })
          }
        } catch (err: any) {
          Alert.alert('Erreur', err?.response?.data?.detail || 'Erreur scan etiquette')
        }
      }
    }
    setTimeout(() => setLastScanned(''), 2000)
  }, [activePdv, activeCombi])

  /** Upload preuve photographique / Upload photographic evidence */
  const _uploadEvidence = useCallback(async (
    context: string,
    photoUri: string,
    geo: { latitude: number; longitude: number; accuracy: number } | null,
    ts: string,
    extra: { label_code?: string; combi_barcode?: string },
  ) => {
    try {
      const formData = new FormData()
      formData.append('file', { uri: photoUri, type: 'image/jpeg', name: 'control.jpg' } as any)
      formData.append('control_context', context)
      formData.append('timestamp', ts)
      if (activePdv) formData.append('pdv_code_scanned', activePdv.code)
      if (geo) {
        formData.append('latitude', String(geo.latitude))
        formData.append('longitude', String(geo.longitude))
        formData.append('accuracy', String(geo.accuracy))
      }
      if (extra.label_code) formData.append('label_code', extra.label_code)
      if (extra.combi_barcode) formData.append('combi_barcode', extra.combi_barcode)
      await api.post('/driver/control-evidence', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    } catch {
      // Evidence upload silencieux — le scan a deja ete soumis / Silent — scan already submitted
    }
  }, [activePdv])

  /** Callback photo controle capturee / Control photo captured callback */
  const handleControlPhoto = useCallback(async (photoUri: string) => {
    if (!pendingScan) return
    const { type, data, geo, ts } = pendingScan
    setPendingScan(null)
    await _submitScan(type, data, geo, ts, photoUri)
  }, [pendingScan, _submitScan])

  /** Annulation photo controle / Cancel control photo */
  const handleControlCancel = useCallback(() => {
    setPendingScan(null)
  }, [])

  /* Changer de PDV / Switch PDV */
  const handleChangePdv = () => {
    setActivePdv(null)
    setActiveCombi(null)
    setCombiSessionCount(0)
    setLastScanned('')
  }

  /** Cloturer la reprise combi en cours / Close current combi pickup */
  const handleCloseCombi = useCallback(async () => {
    if (!activeCombi || closing) return
    const total = activeCombi.alreadyScannedCount + combiSessionCount
    Alert.alert(
      'Terminer la reprise combi',
      `${total} combi(s) scanne(s) sur ${activeCombi.declaredQuantity} declare(s). Cloturer ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Cloturer',
          style: 'default',
          onPress: async () => {
            setClosing(true)
            try {
              const { data: recap } = await api.post(
                `/driver/pickup-labels/${encodeURIComponent(activeCombi.labelCode)}/close-combi-pickup`,
              )
              const pct = Math.round((recap.pickup_ratio ?? 0) * 100)
              Alert.alert(
                'Reprise combi cloturee',
                `Declare : ${recap.declared_quantity}\nReellement repris : ${recap.actual_picked_quantity}\nTaux : ${pct}%`,
              )
              setActiveCombi(null)
              setCombiSessionCount(0)
            } catch (err: any) {
              Alert.alert('Erreur', err?.response?.data?.detail || 'Erreur cloture')
            } finally {
              setClosing(false)
            }
          },
        },
      ],
    )
  }, [activeCombi, combiSessionCount, closing])

  /* Permission camera / Camera permission */
  if (!permission) {
    return <SafeAreaView style={styles.center}><ActivityIndicator color={COLORS.primary} /></SafeAreaView>
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.text}>Acces camera requis pour scanner</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>Autoriser la camera</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={styles.linkText}>Retour</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  const combiCount = scans.filter((s) => s.type === 'COMBI').length
  const labelCount = scans.filter((s) => s.type === 'LABEL').length

  // Modal photo controle / Control photo modal
  if (pendingScan) {
    return (
      <ControlPhotoCapture
        instruction={
          pendingScan.type === 'COMBI'
            ? `Photographiez le combi ${pendingScan.data}`
            : `Photographiez la reprise ${pendingScan.data}`
        }
        onCapture={handleControlPhoto}
        onCancel={handleControlCancel}
      />
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Retour</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Scan contenants</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* PDV context banner */}
      {activePdv ? (
        <View style={styles.pdvBanner}>
          <View>
            <Text style={styles.pdvBannerCode}>{activePdv.code}</Text>
            <Text style={styles.pdvBannerName}>{activePdv.name}</Text>
          </View>
          <TouchableOpacity onPress={handleChangePdv} style={styles.changePdvBtn}>
            <Text style={styles.changePdvText}>Changer PDV</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.pdvRequired}>
          <Text style={styles.pdvRequiredText}>Scannez le code-barres du PDV</Text>
        </View>
      )}

      {/* Bandeau declaration combi active / Active combi declaration banner */}
      {activeCombi && (
        <View style={styles.combiBanner}>
          <View style={{ flex: 1 }}>
            <Text style={styles.combiBannerTitle}>Reprise combi en cours</Text>
            <Text style={styles.combiBannerStats}>
              {activeCombi.alreadyScannedCount + combiSessionCount} / {activeCombi.declaredQuantity} scannes
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleCloseCombi}
            disabled={closing}
            style={[styles.closeCombiBtn, closing && { opacity: 0.5 }]}
          >
            <Text style={styles.closeCombiText}>{closing ? '...' : 'Terminer'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Camera */}
      <View style={styles.cameraSection}>
        <CameraView
          style={styles.camera}
          facing="back"
          enableTorch={torchOn}
          barcodeScannerSettings={{
            barcodeTypes: ['code128', 'code39', 'ean13', 'qr'],
          }}
          onBarcodeScanned={handleBarCodeScanned}
        />
        <TorchToggleButton enabled={torchOn} onToggle={() => setTorchOn((v) => !v)} />
        <View style={styles.cameraOverlay}>
          <View style={styles.scanLine} />
          {loading ? (
            <ActivityIndicator color={COLORS.primary} />
          ) : lastScanned ? (
            <Text style={styles.scanSuccess}>{lastScanned}</Text>
          ) : (
            <Text style={styles.scanHint}>
              {!activePdv
                ? 'Scannez le code-barres PDV'
                : activeCombi
                  ? 'Scannez les combis (RM) ou une autre etiquette (RET)'
                  : 'Scannez une etiquette (RET) ou un combi (RM)'}
            </Text>
          )}
        </View>
      </View>

      {/* Compteurs / Counters */}
      <View style={styles.counters}>
        <View style={styles.counterBox}>
          <Text style={[styles.counterNum, { color: '#8b5cf6' }]}>{combiCount}</Text>
          <Text style={styles.counterLabel}>Combis</Text>
        </View>
        <View style={styles.counterBox}>
          <Text style={[styles.counterNum, { color: COLORS.primary }]}>{labelCount}</Text>
          <Text style={styles.counterLabel}>Etiquettes</Text>
        </View>
        <View style={styles.counterBox}>
          <Text style={[styles.counterNum, { color: COLORS.success }]}>{combiCount + labelCount}</Text>
          <Text style={styles.counterLabel}>Total</Text>
        </View>
      </View>

      {/* Liste scannee / Scanned list */}
      <FlatList
        data={scans}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View style={styles.scanRow}>
            <View style={[styles.typeBadge, { backgroundColor: item.type === 'COMBI' ? '#8b5cf622' : '#f9731622' }]}>
              <Text style={[styles.typeBadgeText, { color: item.type === 'COMBI' ? '#8b5cf6' : COLORS.primary }]}>
                {item.type === 'COMBI' ? 'COMBI' : 'REPRISE'}
              </Text>
            </View>
            <View style={styles.scanInfo}>
              <Text style={styles.scanBarcode}>{item.barcode}</Text>
              <Text style={styles.scanDetail}>
                {item.pdvCode}{item.pdvName ? ` — ${item.pdvName}` : ''}
                {item.supportType ? ` | ${item.supportType}` : ''}
              </Text>
            </View>
            <Text style={styles.scanStatus}>{item.status}</Text>
          </View>
        )}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Aucun scan aujourd'hui</Text>
        }
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bgPrimary },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.bgPrimary, padding: 32 },
  text: { color: COLORS.textPrimary, fontSize: 15, textAlign: 'center', marginBottom: 16 },
  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  primaryBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 15 },
  linkText: { color: COLORS.primary, fontSize: 14 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  backBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  backBtnText: { color: COLORS.primary, fontWeight: '600', fontSize: 14 },
  headerTitle: { color: COLORS.textPrimary, fontWeight: '700', fontSize: 16 },

  pdvBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#22c55e18', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#22c55e44' },
  pdvBannerCode: { color: '#22c55e', fontWeight: '900', fontSize: 20 },
  pdvBannerName: { color: COLORS.textSecondary, fontSize: 12 },
  changePdvBtn: { backgroundColor: COLORS.bgTertiary, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
  changePdvText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },

  pdvRequired: { backgroundColor: '#f59e0b18', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f59e0b44' },
  pdvRequiredText: { color: '#f59e0b', fontWeight: '700', fontSize: 14, textAlign: 'center' },

  combiBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#8b5cf618', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#8b5cf644' },
  combiBannerTitle: { color: '#8b5cf6', fontWeight: '800', fontSize: 13 },
  combiBannerStats: { color: COLORS.textPrimary, fontSize: 12, marginTop: 2 },
  closeCombiBtn: { backgroundColor: '#8b5cf6', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
  closeCombiText: { color: COLORS.white, fontWeight: '700', fontSize: 13 },

  cameraSection: { height: 250, backgroundColor: '#000' },
  camera: { flex: 1 },
  cameraOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  scanLine: { width: '70%', height: 2, backgroundColor: COLORS.primary, borderRadius: 1, marginBottom: 6, opacity: 0.8 },
  scanSuccess: { color: COLORS.success, fontWeight: '700', fontSize: 14, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  scanHint: { color: COLORS.white, fontSize: 12, opacity: 0.8, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },

  counters: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, gap: 8 },
  counterBox: { flex: 1, alignItems: 'center', backgroundColor: COLORS.bgSecondary, borderRadius: 8, paddingVertical: 8, borderWidth: 1, borderColor: COLORS.border },
  counterNum: { fontSize: 22, fontWeight: '900' },
  counterLabel: { fontSize: 10, color: COLORS.textMuted, marginTop: 2 },

  list: { paddingHorizontal: 12, paddingBottom: 20 },
  scanRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.bgSecondary, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: COLORS.border },
  typeBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginRight: 10 },
  typeBadgeText: { fontSize: 9, fontWeight: '800' },
  scanInfo: { flex: 1 },
  scanBarcode: { color: COLORS.textPrimary, fontWeight: '700', fontSize: 13, fontFamily: 'monospace' },
  scanDetail: { color: COLORS.textMuted, fontSize: 11, marginTop: 2 },
  scanStatus: { color: COLORS.success, fontWeight: '700', fontSize: 12 },
  emptyText: { color: COLORS.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
})
