/* Liste tours du jour + affectation par scan / Daily tour list, scan assignment

   L'ecran ne montre QUE les tournees deja affectees a cet appareil. La liste
   des tournees disponibles et son affectation au tap ont ete retirees (#98) :
   un telephone reste avec son chauffeur toute la journee, et un tap suffisait
   a s'attribuer n'importe quelle tournee de la base — y compris celle d'un
   collegue, qui se retrouvait alors sans rien, sans que personne ne sache
   pourquoi. Une tournee se prend desormais en scannant le QR du postier ou le
   code-barres de sa feuille de route ; le postier peut aussi l'affecter depuis
   le web. Le serveur exige la meme preuve, ce n'est pas qu'un ecran en moins. /
   Only tours already assigned to this device are listed; taking a tour
   requires scanning, and the server demands the same proof.
*/

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  View, FlatList, Text, TouchableOpacity,
  StyleSheet, RefreshControl, Alert, ActivityIndicator, Vibration,
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter, useFocusEffect } from 'expo-router'
import api from '../../services/api'
import { TourCard } from '../../components/TourCard'
import { useDeviceStore } from '../../stores/useDeviceStore'
import { COLORS } from '../../constants/config'
import { TorchToggleButton } from '../../components/TorchToggleButton'
import type { DriverTour } from '../../types'

/* Une seule verification de la notice GPS par session d'app /
   Check the GPS notice only once per app session */
let gpsNoticeChecked = false

export default function TourListScreen() {
  const router = useRouter()
  const hasFeature = useDeviceStore((s) => s.hasFeature)
  const deviceId = useDeviceStore((s) => s.deviceId)

  // RGPD : si aucun accuse de lecture de la notice geolocalisation n'est
  // enregistre pour cet appareil, l'afficher. Information, pas consentement —
  // la base legale est l'interet legitime. / Show the GPS notice until it has
  // been acknowledged; information, not consent.
  useEffect(() => {
    if (gpsNoticeChecked || !deviceId) return
    gpsNoticeChecked = true
    api.get('/gdpr/consent/device/gps_information')
      .then(({ data }) => {
        if (data?.granted === null || data?.granted === undefined) {
          router.push('/gps-notice')
        }
      })
      .catch(() => { gpsNoticeChecked = false })  // reessaiera au prochain montage
  }, [deviceId, router])
  const [tours, setTours] = useState<DriverTour[]>([])
  const [loading, setLoading] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const scannedRef = useRef(false)
  const date = new Date().toISOString().slice(0, 10)

  const loadTours = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get<DriverTour[]>('/driver/my-tours', { params: { date } })
      setTours(data)
      prevTourIdsRef.current = data.map((t) => t.id).sort().join(',')
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || (e as { message?: string })?.message || 'Erreur chargement tours'
      console.error('Failed to load tours', msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [date])

  // Recharger a chaque focus / Reload on focus
  useFocusEffect(
    useCallback(() => {
      loadTours()
    }, [loadTours])
  )

  // Polling 30s quand aucun tour actif — detecter affectation distante / Poll when no active tour
  const prevTourIdsRef = useRef<string>('')
  useEffect(() => {
    if (tours.some((t) => t.status === 'IN_PROGRESS' || t.status === 'VALIDATED')) return
    const interval = setInterval(async () => {
      try {
        const { data } = await api.get<DriverTour[]>('/driver/my-tours', { params: { date } })
        const newIds = data.map((t) => t.id).sort().join(',')
        if (newIds && newIds !== prevTourIdsRef.current && prevTourIdsRef.current !== '') {
          // Nouveau tour detecte / New tour detected
          const newTour = data.find((t) => !prevTourIdsRef.current.includes(String(t.id)))
          Vibration.vibrate([0, 200, 100, 200])
          Alert.alert('Nouveau tour assigne', newTour ? `${newTour.code} — ${newTour.stops.length} arrets` : 'Un tour a ete assigne')
          setTours(data)
        }
        prevTourIdsRef.current = newIds || prevTourIdsRef.current
        if (!prevTourIdsRef.current) {
          prevTourIdsRef.current = data.map((t) => t.id).sort().join(',')
        }
      } catch {}
    }, 30_000)
    return () => clearInterval(interval)
  }, [tours, date])

  /* Affecter la tournee designee par le code scanne / Assign the scanned tour.

     C'est le serveur qui resout le code et verifie la preuve de scan : l'app
     n'a plus besoin de connaitre la liste des tournees disponibles pour en
     prendre une, et le controle ne depend plus d'un ecran. / The server
     resolves the code and checks the proof. */
  const doAssign = useCallback(async (scanCode: string) => {
    if (assigning) return
    setAssigning(true)
    try {
      const { data: assigned } = await api.post('/driver/assign-tour', { scan_code: scanCode })
      await loadTours()
      setShowScanner(false)
      scannedRef.current = false
      Alert.alert('Tour affecte', `${assigned.code} — ${assigned.stops?.length ?? 0} arrets`, [
        { text: 'OK' },
      ])
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      const msg = status === 404
        ? `« ${scanCode} » ne correspond a aucune tournee.\n\nScannez le QR affiche par le postier, ou le code-barres de votre feuille de route du jour.`
        : detail || 'Erreur affectation'
      Alert.alert('Erreur', msg, [
        { text: 'Re-scanner', onPress: () => { scannedRef.current = false } },
        { text: 'Fermer', onPress: () => { setShowScanner(false); scannedRef.current = false; setTorchOn(false) } },
      ])
    } finally {
      setAssigning(false)
    }
  }, [assigning, loadTours])

  /* Scanner une affectation / Scan an assignment.
     Deux formats acceptes (#51) :
     - le QR genere par le postier, « TOUR:123 » ;
     - le CODE-BARRES deja imprime sur la feuille de route, qui porte le code de
       la tournee. Les tournees de nuit partent sans contact avec le postier :
       le chauffeur a la feuille de route en main, pas l'ecran du postier. /
     Accepts the postier's QR and the barcode already printed on the route
     sheet, so night drivers can self-assign without meeting anyone. */
  const handleQrScanned = useCallback(({ data: qrData }: { data: string }) => {
    if (scannedRef.current || assigning) return
    scannedRef.current = true
    const lu = qrData.trim()
    if (!lu) {
      scannedRef.current = false
      return
    }
    // Le code part tel quel : le serveur accepte « TOUR:<id> » comme le code
    // de la feuille de route, et c'est lui qui tranche. / The code goes as-is.
    doAssign(lu)
  }, [assigning, doAssign])

  // Tours actifs (non termines) / Active (non-completed) tours
  const activeTours = tours.filter((t) => t.status !== 'COMPLETED')
  const completedTours = tours.filter((t) => t.status === 'COMPLETED')

  /* Mode scanner QR plein ecran / Full-screen QR scanner mode */
  if (showScanner) {
    if (!permission) {
      return <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
    }
    if (!permission.granted) {
      return (
        <View style={styles.center}>
          <Text style={styles.permText}>Acces camera requis pour scanner le QR du tour</Text>
          <TouchableOpacity onPress={requestPermission} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Autoriser la camera</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setShowScanner(false); scannedRef.current = false; setTorchOn(false) }} style={{ marginTop: 16 }}>
            <Text style={styles.linkText}>Retour</Text>
          </TouchableOpacity>
        </View>
      )
    }

    return (
      <View style={styles.scanContainer}>
        <View style={styles.cameraWrapper}>
          {assigning ? (
            <View style={styles.assigningOverlay}>
              <ActivityIndicator color={COLORS.white} size="large" />
              <Text style={styles.assigningText}>Affectation en cours...</Text>
            </View>
          ) : (
            <CameraView
              style={styles.camera}
              facing="back"
              enableTorch={torchOn}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleQrScanned}
            />
          )}
          <TorchToggleButton enabled={torchOn} onToggle={() => setTorchOn((v) => !v)} />
          <View style={styles.cameraOverlay}>
            <View style={styles.qrFrame} />
            <Text style={styles.scanHint}>
              Scannez le QR du tour
            </Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={() => { setShowScanner(false); scannedRef.current = false; setTorchOn(false) }}
          style={styles.closeScannerBtn}
        >
          <Text style={styles.closeScannerText}>Fermer le scanner</Text>
        </TouchableOpacity>
      </View>
    )
  }

  /* Mode normal : liste tours / Normal mode: tour list */
  return (
    <View style={styles.container}>
      <View style={styles.dateRow}>
        <Text style={styles.dateLabel}>{date}</Text>
        {/* Accès permanent à la note d'information GPS (RGPD) — les Réglages
            sont réservés aux comptes, pas aux chauffeurs / Always-reachable GPS
            notice (Settings are login-only, drivers can't reach them) */}
        <TouchableOpacity
          style={styles.privacyBtn}
          onPress={() => router.push('/gps-notice')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.privacyText}>🛡 Confidentialité</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={[]}
        keyExtractor={() => ''}
        renderItem={() => null}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={loadTours}
            tintColor={COLORS.primary}
          />
        }
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <>
            {/* Erreur / Error */}
            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity onPress={loadTours}>
                  <Text style={styles.retryText}>Reessayer</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Section tours actifs / Active tours section */}
            {activeTours.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Mes tours</Text>
                {activeTours.map((tour) => (
                  <TourCard
                    key={tour.id}
                    tour={tour}
                    onPress={() => router.push(`/tour/${tour.id}`)}
                  />
                ))}
              </View>
            )}

            {/* Section tours termines / Completed tours section */}
            {completedTours.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: COLORS.success }]}>
                  Termines ({completedTours.length})
                </Text>
                {completedTours.map((tour) => (
                  <TourCard
                    key={tour.id}
                    tour={tour}
                    onPress={() => router.push(`/tour/${tour.id}`)}
                  />
                ))}
              </View>
            )}

            {/* Message vide / Empty message */}
            {!loading && activeTours.length === 0 && completedTours.length === 0 && !error && (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Aucune tournee affectee a cet appareil</Text>
                <Text style={styles.emptyHint}>
                  Scannez le QR du postier ou le code-barres de votre feuille{'\n'}
                  de route avec le bouton ci-dessous, ou tirez pour rafraichir.
                </Text>
              </View>
            )}
          </>
        }
      />

      {/* Barre d'actions en bas / Bottom action bar */}
      <View style={styles.bottomBar}>
        {/* Boutons actions rapides — filtre par features autorisees */}
        <View style={styles.quickActions}>
          {hasFeature('pickups') && (
            <TouchableOpacity
              style={styles.quickActionBtn}
              onPress={() => router.push('/combi-scan')}
            >
              <Text style={styles.quickActionText}>Scanner reprises</Text>
            </TouchableOpacity>
          )}
          {hasFeature('base_reception') && (
            <TouchableOpacity
              style={styles.quickActionBtn}
              onPress={() => router.push('/base-reception')}
            >
              <Text style={styles.quickActionText}>Reception base</Text>
            </TouchableOpacity>
          )}
          {hasFeature('inventory') && (
            <TouchableOpacity
              style={styles.quickActionBtn}
              onPress={() => router.push('/inventory')}
            >
              <Text style={styles.quickActionText}>Inventaire PDV</Text>
            </TouchableOpacity>
          )}
          {hasFeature('inventory') && (
            <TouchableOpacity
              style={styles.quickActionBtn}
              onPress={() => router.push('/base-inventory')}
            >
              <Text style={styles.quickActionText}>Inventaire base</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Bouton scanner QR tour */}
        {hasFeature('tours') && (
          <TouchableOpacity
            style={styles.qrButton}
            onPress={() => { scannedRef.current = false; setShowScanner(true) }}
          >
            <Text style={styles.qrButtonText}>Scanner QR tour</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Overlay affectation en cours / Assigning overlay */}
      {assigning && (
        <View style={styles.assigningFullOverlay}>
          <ActivityIndicator color={COLORS.primary} size="large" />
          <Text style={styles.assigningFullText}>Affectation en cours...</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgPrimary,
  },
  dateRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  privacyBtn: {
    position: 'absolute',
    right: 14,
  },
  privacyText: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  dateLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  list: {
    padding: 14,
    paddingBottom: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.bgPrimary,
    padding: 20,
  },

  /* Sections */
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.primary,
    marginBottom: 8,
  },
  /* Vide / Empty */
  empty: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 16,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  emptyHint: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },

  /* Erreur / Error */
  errorBox: {
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderWidth: 1,
    borderColor: COLORS.danger,
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    alignItems: 'center',
  },
  errorText: {
    fontSize: 13,
    color: COLORS.danger,
    textAlign: 'center',
    marginBottom: 8,
  },
  retryText: {
    fontSize: 13,
    color: COLORS.primary,
    fontWeight: '600',
  },

  /* Barre d'actions en bas / Bottom action bar */
  bottomBar: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 8,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 8,
  },
  quickActionBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  quickActionText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '700',
  },

  /* Bouton QR tour */
  qrButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  qrButtonText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '700',
  },

  /* Scanner plein ecran / Full-screen scanner */
  scanContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraWrapper: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrFrame: {
    width: 200,
    height: 200,
    borderWidth: 2,
    borderColor: COLORS.primary,
    borderRadius: 16,
    opacity: 0.7,
  },
  scanHint: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 20,
    textAlign: 'center',
    paddingHorizontal: 30,
    textShadowColor: '#000',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 4,
  },
  closeScannerBtn: {
    backgroundColor: COLORS.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingVertical: 16,
    alignItems: 'center',
  },
  closeScannerText: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  assigningOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.8)',
  },
  assigningText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 16,
  },

  /* Overlay affectation liste / List assignment overlay */
  assigningFullOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  assigningFullText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: '600',
    marginTop: 12,
  },

  /* Permissions */
  permText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 16,
  },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 15,
  },
  linkText: {
    color: COLORS.textMuted,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
})
