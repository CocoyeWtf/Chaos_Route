/* Detail tour / feuille de route / Tour detail / driver route sheet */

import { useState, useEffect, useCallback } from 'react'
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router'
import api from '../../../services/api'
import { StopCard } from '../../../components/StopCard'
import { InspectionRequiredBanner } from '../../../components/InspectionRequiredBanner'
import { COLORS, STATUS_COLORS } from '../../../constants/config'
import { startGPSTracking, stopGPSTracking } from '../../../services/gps'
import type { DriverTour, InspectionCheckResponse } from '../../../types'

export default function TourDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [tour, setTour] = useState<DriverTour | null>(null)
  const [loading, setLoading] = useState(true)
  const [gpsActive, setGpsActive] = useState(false)
  const [inspectionCheck, setInspectionCheck] = useState<InspectionCheckResponse | null>(null)
  const [inspectionGateDismissed, setInspectionGateDismissed] = useState(false)

  const tourId = Number(id)

  const loadTour = useCallback(async () => {
    try {
      const { data } = await api.get<DriverTour>(`/driver/tour/${tourId}`)
      setTour(data)
    } catch (e) {
      console.error('Failed to load tour', e)
      Alert.alert('Erreur', 'Impossible de charger le tour')
    } finally {
      setLoading(false)
    }
  }, [tourId])

  /* Verifier inspection requise / Check inspection requirement */
  const checkInspection = useCallback(async () => {
    try {
      const { data } = await api.get<InspectionCheckResponse>(`/inspections/driver/check/${tourId}`)
      setInspectionCheck(data)
      /* Si tous les vehicules sont inspectes, desactiver la gate / If all inspected, dismiss gate */
      if (!data.required || data.vehicles.every((v) => v.inspection_done)) {
        setInspectionGateDismissed(true)
      }
    } catch {
      /* Silencieux si endpoint absent ou erreur / Silent on failure */
      setInspectionCheck(null)
    }
  }, [tourId])

  // Recharger a chaque focus (retour depuis scan/supports/inspection) / Reload on every focus
  useFocusEffect(
    useCallback(() => {
      loadTour()
      checkInspection()
    }, [loadTour, checkInspection])
  )

  // Polling statut pendant RETURNING / Poll status during RETURNING
  useEffect(() => {
    if (!tour || tour.status !== 'RETURNING') return
    const interval = setInterval(() => { loadTour() }, 30_000)
    return () => clearInterval(interval)
  }, [tour?.status, loadTour])

  // Timeout securite 2h — stop GPS si postier n'a pas valide / Safety timeout 2h — stop GPS if gate not validated
  useEffect(() => {
    if (!tour || tour.status !== 'RETURNING') return
    const timeout = setTimeout(async () => {
      await stopGPSTracking()
      setGpsActive(false)
    }, 2 * 60 * 60 * 1000)
    return () => clearTimeout(timeout)
  }, [tour?.status])

  // Demarrer / arreter le suivi selon l'etat de la TOURNEE, jamais selon
  // l'ecran affiche. Cet effet n'arrete surtout rien au demontage : le
  // chauffeur passe son temps a naviguer vers les scans et a revenir, et
  // couper a chaque fois figeait son marqueur sur la carte d'exploitation.
  // Le suivi s'arrete a la cloture reelle, ou via le garde-fou de duree du
  // service. / Tracking follows the tour's state, never the screen's: no stop
  // on unmount.
  useEffect(() => {
    if (!tour) return
    if (tour.status === 'COMPLETED') {
      stopGPSTracking().then(() => setGpsActive(false))
      return
    }
    startGPSTracking(tourId).then((ok) => {
      setGpsActive(ok)
      if (!ok) console.warn('GPS tracking failed to start — permissions not granted')
    })
  }, [tour?.status, tourId])

  const handleCloseStop = (stopId: number, pdvName: string) => {
    Alert.alert(
      'Confirmer la livraison',
      `Confirmer la livraison a ${pdvName} ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer',
          onPress: async () => {
            try {
              await api.post(`/driver/tour/${tourId}/stops/${stopId}/close`, {
                timestamp: new Date().toISOString(),
                force: false,
              })
              loadTour()
            } catch (e: unknown) {
              const err = e as { response?: { status?: number; data?: { detail?: string } } }
              const msg = err?.response?.data?.detail || 'Erreur'
              const status = err?.response?.status

              // 422 reprises en attente → proposer Scanner / Refuser / Forcer
              if (status === 422 && msg.includes('Reprises en attente')) {
                Alert.alert('Reprises en attente', msg, [
                  {
                    text: 'Scanner',
                    onPress: () => router.push(`/tour/${tourId}/stop/${stopId}/pickups`),
                  },
                  {
                    text: 'Refuser',
                    onPress: () => handleRefusePickup(stopId, pdvName),
                  },
                  {
                    text: 'Forcer',
                    style: 'destructive',
                    onPress: async () => {
                      await api.post(`/driver/tour/${tourId}/stops/${stopId}/close`, {
                        timestamp: new Date().toISOString(),
                        force: true,
                      })
                      loadTour()
                    },
                  },
                ])
              } else {
                // Autre erreur → proposer cloture forcee / Other error → offer forced closure
                Alert.alert('Erreur', msg, [
                  { text: 'Annuler', style: 'cancel' },
                  {
                    text: 'Forcer',
                    style: 'destructive',
                    onPress: async () => {
                      await api.post(`/driver/tour/${tourId}/stops/${stopId}/close`, {
                        timestamp: new Date().toISOString(),
                        force: true,
                      })
                      loadTour()
                    },
                  },
                ])
              }
            }
          },
        },
      ],
    )
  }

  const handleRefusePickup = (stopId: number, pdvName: string) => {
    Alert.alert(
      'Refuser les reprises',
      `Refuser toutes les reprises pour ${pdvName} ? Les etiquettes retourneront en pool non-assigne.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Refuser',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.post(`/driver/tour/${tourId}/stops/${stopId}/refuse-pickup`, {
                reason: 'Refuse par le chauffeur',
                timestamp: new Date().toISOString(),
              })
              loadTour()
            } catch (e) {
              console.error('Failed to refuse pickup', e)
              Alert.alert('Erreur', 'Impossible de refuser les reprises')
            }
          },
        },
      ],
    )
  }

  const handleReopenStop = (stopId: number, pdvName: string) => {
    Alert.alert(
      'Re-livrer',
      `Reouvrir le stop ${pdvName} pour re-livraison ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Re-livrer',
          onPress: async () => {
            try {
              await api.post(`/driver/tour/${tourId}/stops/${stopId}/reopen`, {
                timestamp: new Date().toISOString(),
                reason: 'Support retrouve',
              })
              loadTour()
            } catch (e: unknown) {
              const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur'
              Alert.alert('Erreur', msg)
            }
          },
        },
      ],
    )
  }

  const handleReturnBase = () => {
    Alert.alert(
      'Retour base',
      'Confirmer le retour a la base ?',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer',
          onPress: async () => {
            try {
              await api.post(`/driver/tour/${tourId}/return`, {
                timestamp: new Date().toISOString(),
              })
              loadTour()
            } catch (e) {
              console.error('Failed to return to base', e)
            }
          },
        },
      ],
    )
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    )
  }

  if (!tour) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Tour introuvable</Text>
      </View>
    )
  }

  const delivered = tour.stops.filter((s) => s.delivery_status === 'DELIVERED').length
  const total = tour.stops.length
  const statusColor = STATUS_COLORS[tour.status] || COLORS.textMuted

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.code}>{tour.code}</Text>
          <View style={[styles.badge, { borderColor: statusColor }]}>
            <Text style={[styles.badgeText, { color: statusColor }]}>{tour.status}</Text>
          </View>
        </View>
        <View style={styles.headerRow}>
          <Text style={styles.meta}>
            {tour.delivery_date} · Dep. {tour.departure_time || '—'} · {tour.vehicle_code || '—'}
          </Text>
          {gpsActive ? <Text style={styles.gpsBadge}>GPS</Text> : null}
        </View>
        {/* Barre progression / Progress bar */}
        <View style={styles.progressRow}>
          <Text style={styles.progressText}>{delivered}/{total} livres</Text>
          <View style={styles.progressBg}>
            <View style={[styles.progressFill, { width: total > 0 ? `${(delivered / total) * 100}%` : '0%' }]} />
          </View>
        </View>
      </View>

      {/* Bandeau inspection requise / Inspection required banner */}
      {inspectionCheck?.required && !inspectionGateDismissed &&
        inspectionCheck.vehicles.some((v) => !v.inspection_done) && (
        <InspectionRequiredBanner
          tourId={tourId}
          vehicles={inspectionCheck.vehicles}
          driverName={tour.driver_name || undefined}
          onDone={() => setInspectionGateDismissed(true)}
        />
      )}

      {/* Bandeau retour / Returning banner */}
      {tour.status === 'RETURNING' && (
        <View style={styles.returningBanner}>
          <Text style={styles.returningText}>En retour vers la base — GPS actif</Text>
        </View>
      )}

      {/* Liste stops / Stop list */}
      <FlatList
        data={tour.stops}
        keyExtractor={(s) => String(s.id)}
        renderItem={({ item }) => (
          <StopCard
            stop={item}
            onScanPdv={() => router.push(`/tour/${tourId}/stop/${item.id}/scan`)}
            onScanSupports={() => router.push(`/tour/${tourId}/stop/${item.id}/supports`)}
            onScanPickups={() => router.push(`/tour/${tourId}/stop/${item.id}/pickups`)}
            onClose={() => handleCloseStop(item.id, item.pdv_name || item.pdv_code || '—')}
            onRefusePickup={() => handleRefusePickup(item.id, item.pdv_name || item.pdv_code || '—')}
            onReopen={() => handleReopenStop(item.id, item.pdv_name || item.pdv_code || '—')}
          />
        )}
        contentContainerStyle={styles.list}
        ListFooterComponent={
          tour.status !== 'COMPLETED' && tour.status !== 'RETURNING' ? (
            <TouchableOpacity onPress={handleReturnBase} style={styles.returnBtn}>
              <Text style={styles.returnBtnText}>Retour base</Text>
            </TouchableOpacity>
          ) : null
        }
      />

      {/* Bouton flottant Declarer / Floating declare button */}
      {tour.status !== 'COMPLETED' && (
        <TouchableOpacity
          onPress={() => router.push(`/declaration?tourId=${tourId}&driverName=${encodeURIComponent(tour?.driver_name || '')}`)}
          style={[styles.declareFab, { bottom: Math.max(insets.bottom, 16) + 12 }]}
        >
          <Text style={styles.declareFabText}>! Declarer</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgPrimary,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.bgPrimary,
  },
  errorText: {
    color: COLORS.textMuted,
    fontSize: 16,
  },
  header: {
    backgroundColor: COLORS.bgSecondary,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  code: {
    fontSize: 22,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  gpsBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.success,
    backgroundColor: COLORS.success + '22',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  progressText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    width: 70,
  },
  progressBg: {
    flex: 1,
    height: 6,
    backgroundColor: COLORS.bgTertiary,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    backgroundColor: COLORS.success,
    borderRadius: 3,
  },
  list: {
    padding: 14,
    paddingBottom: 40,
  },
  returnBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 16,
  },
  returningBanner: {
    backgroundColor: '#3b82f6' + '22',
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  returningText: {
    color: '#3b82f6',
    fontSize: 13,
    fontWeight: '600',
  },
  returnBtnText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
  },
  declareFab: {
    position: 'absolute',
    right: 16,
    backgroundColor: COLORS.danger,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 24,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  declareFabText: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: '700',
  },
})
