/* Constructeur de tour (Phase Construction) / Tour builder (Construction phase — PDV first, vehicle after) */

import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useApi } from '../../hooks/useApi'
import { useTour } from '../../hooks/useTour'
import { useAppStore } from '../../stores/useAppStore'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { VehicleSelector } from './VehicleSelector'
import { VolumePanel } from './VolumePanel'
import { PickupPanel } from './PickupPanel'
import { TourSummary } from './TourSummary'
import { TourValidation } from './TourValidation'
import { ResizeHandle } from './ResizeHandle'
import { MapView } from '../map/MapView'
import { useDetachedMap } from '../../hooks/useDetachedMap'
import { create } from '../../services/api'
import api from '../../services/api'
import type { VehicleType, TemperatureType, TemperatureClass, Volume, PDV, BaseLogistics, Tour, TourStop, DistanceEntry, Contract, PdvPickupSummary, Supplier } from '../../types'
import type { PdvVolumeStatus } from '../map/PdvMarker'
import { VEHICLE_TYPE_DEFAULTS, TEMPERATURE_TYPE_LABELS } from '../../types'
import { getRequiredTemperatureType, checkTemperatureCompatibility } from '../../utils/temperatureUtils'
import { getApiErrorMessage } from '../../utils/apiError'

interface TourBuilderProps {
  selectedDate: string
  selectedBaseId: number | null
  onDateChange: (date: string) => void
  onBaseChange: (baseId: number | null) => void
}

export function TourBuilder({ selectedDate, selectedBaseId, onDateChange, onBaseChange }: TourBuilderProps) {
  const { t } = useTranslation()
  const { selectedRegionId, theme } = useAppStore()
  const {
    currentStops,
    setCurrentTour,
    addStop,
    removeStop,
    reorderStops,
    updateStop,
    resetTour,
    totalEqp,
  } = useTour()

  /* Mode : livraison, reprise (PDV) ou mouvement véhicule (sans arrêt) /
     Delivery, pickup (PDV stops) or vehicle movement (stopless) */
  type TourMode = 'delivery' | 'pickup' | 'movement' | 'surprise'
  const [tourMode, setTourMode] = useState<TourMode>('delivery')
  // Nature en mode reprise (Enlèvement/Vidanges) et mouvement (Déplacement/Garage)
  const [pickupNature, setPickupNature] = useState<'ENLEVEMENT' | 'VIDANGES'>('ENLEVEMENT')
  const [movementNature, setMovementNature] = useState<'DEPLACEMENT_BASE' | 'GARAGE' | 'TRANSFERT_PDV' | 'ENLEVEMENT_DEDIE'>('DEPLACEMENT_BASE')
  const [movementDestination, setMovementDestination] = useState('')
  // Commentaire libre (mouvement + transfert) / Free comment (movement + transfer)
  const [movementComment, setMovementComment] = useState('')
  // Enlèvement dédié : fournisseur (distancier), chauffeur PARC (base) + créneau
  // début/fin / Dedicated pickup: supplier (distancier), PARC base driver + start/end slot
  const [dedicatedSupplierId, setDedicatedSupplierId] = useState<number | null>(null)
  const [dedicatedDriverName, setDedicatedDriverName] = useState('')
  const [dedicatedStartTime, setDedicatedStartTime] = useState('')
  const [dedicatedEndTime, setDedicatedEndTime] = useState('')
  // Tour surprise : tour attribué à un transporteur sans PDV (ajoutés plus tard) /
  // Surprise tour: assigned to a carrier with no PDV yet (added later)
  const [surpriseContractId, setSurpriseContractId] = useState<number | null>(null)
  const [surpriseDepartureTime, setSurpriseDepartureTime] = useState('')
  // Transfert PDV à PDV : PDV origine (chargement) et destination (dépose)
  const [transfertOriginPdvId, setTransfertOriginPdvId] = useState<number | null>(null)
  const [transfertDestPdvId, setTransfertDestPdvId] = useState<number | null>(null)
  const [manualBaseId, setManualBaseId] = useState<number | null>(null)
  const [bypassSupportRules, setBypassSupportRules] = useState(false)

  const [selectedVehicleType, setSelectedVehicleType] = useState<VehicleType | null>(null)
  const [capacityEqp, setCapacityEqp] = useState(0)
  const [saving, setSaving] = useState(false)
  const [splitDialog, setSplitDialog] = useState<{ volume: Volume; maxEqp: number; existingStop?: boolean } | null>(null)
  const [splitEqp, setSplitEqp] = useState(0)
  /* Sélecteur de magasin à couper / Stop picker for split target */
  interface SplitCandidate {
    pdvId: number
    label: string
    eqpCount: number
    maxKeep: number
    volume: Volume
    isExisting: boolean
  }
  const [splitPickerDialog, setSplitPickerDialog] = useState<{
    candidates: SplitCandidate[]
    newVolume?: Volume
  } | null>(null)
  /* Dialog confirmation surbooking / Overbooking confirmation dialog */
  const [overbookingDialog, setOverbookingDialog] = useState<{ volume: Volume; overPct: number } | null>(null)
  const [mapResizeSignal, setMapResizeSignal] = useState(0)
  const handlePanelLayout = useCallback(() => setMapResizeSignal((n) => n + 1), [])

  /* Température / Temperature state */
  const [selectedTemperatureType, setSelectedTemperatureType] = useState<TemperatureType | null>(null)
  const [tempUpgradeDialog, setTempUpgradeDialog] = useState<{ volume: Volume; upgradeTo: TemperatureType } | null>(null)
  /* Filtre température pour carte + liste volumes / Temperature filter for map + volume list */
  const [tempFilters, setTempFilters] = useState<Set<TemperatureClass>>(new Set())
  /* Filtre base d'origine (ticket #20) : différencier le lieu de départ des volumes SEC */
  const [baseFilters, setBaseFilters] = useState<Set<number>>(new Set())

  /* Persistence localStorage des tailles / localStorage persistence for panel sizes */
  const outerLayout = useDefaultLayout({ id: 'tour-h' })
  const innerLayout = useDefaultLayout({ id: 'tour-inner' })

  const regionParams = selectedRegionId ? { region_id: selectedRegionId } : undefined
  const { data: allVolumes, refetch: refetchVolumes } = useApi<Volume>('/volumes', regionParams)
  const volumes = useMemo(() => {
    if (!selectedDate) return allVolumes.filter((v) => !v.tour_id)
    return allVolumes.filter((v) => v.dispatch_date === selectedDate && !v.tour_id)
  }, [allVolumes, selectedDate])
  const { data: pdvs } = useApi<PDV>('/pdvs', regionParams)
  const { data: bases } = useApi<BaseLogistics>('/bases', regionParams)
  /* Bases d'origine présentes dans les volumes du jour, pour les puces de filtre (ticket #20) */
  const availableBases = useMemo(() => {
    const ids = new Set<number>()
    volumes.forEach((v) => { if (v.base_origin_id != null) ids.add(v.base_origin_id) })
    return Array.from(ids)
      .map((id) => bases.find((b) => b.id === id))
      .filter((b): b is BaseLogistics => b != null)
      .sort((a, b) => a.code.localeCompare(b.code))
  }, [volumes, bases])
  const { data: distances } = useApi<DistanceEntry>('/distance-matrix')
  const { data: contracts } = useApi<Contract>('/contracts', regionParams)
  const { data: pickupSummaries } = useApi<PdvPickupSummary>('/pickup-requests/by-pdv/pending')
  /* Fournisseurs (enlèvement dédié) + chauffeurs base (chauffeur PARC) /
     Suppliers (dedicated pickup) + base drivers (PARC driver) */
  const { data: suppliers } = useApi<Supplier>('/suppliers', regionParams)
  const { data: baseDrivers } = useApi<{ id: number; last_name: string; first_name: string; code_infolog: string; base_id: number }>('/base-drivers')

  /* Index pickup par PDV / Pickup index by PDV */
  const pickupByPdv = useMemo(() => {
    const m = new Map<number, PdvPickupSummary>()
    pickupSummaries.forEach((s) => m.set(s.pdv_id, s))
    return m
  }, [pickupSummaries])

  /* Flags reprise auto-cochés / Auto-checked pickup flags per PDV */
  const getPickupFlags = useCallback((pdvId: number) => {
    const summary = pickupByPdv.get(pdvId)
    if (!summary) return {}
    const flags: Record<string, boolean> = {}
    for (const req of summary.requests) {
      if (req.pickup_type === 'CONTAINER') flags.pickup_containers = true
      if (req.pickup_type === 'CARDBOARD') flags.pickup_cardboard = true
      if (req.pickup_type === 'MERCHANDISE') flags.pickup_returns = true
      if (req.pickup_type === 'CONSIGNMENT') flags.pickup_consignment = true
    }
    return flags
  }, [pickupByPdv])

  /* Coût moyen/km par type de véhicule / Average cost/km for vehicle type */
  const avgCostPerKm = useMemo(() => {
    if (!selectedVehicleType || contracts.length === 0) return 0
    const matching = contracts.filter((c) => c.vehicle_type === selectedVehicleType && c.cost_per_km)
    if (matching.length === 0) return 0
    const sum = matching.reduce((acc, c) => acc + (c.cost_per_km ?? 0), 0)
    return sum / matching.length
  }, [contracts, selectedVehicleType])

  const avgFixedCost = useMemo(() => {
    if (!selectedVehicleType || contracts.length === 0) return 0
    const matching = contracts.filter((c) => c.vehicle_type === selectedVehicleType && c.fixed_daily_cost)
    if (matching.length === 0) return 0
    const sum = matching.reduce((acc, c) => acc + (c.fixed_daily_cost ?? 0), 0)
    return sum / matching.length
  }, [contracts, selectedVehicleType])

  /* Index des distances / Distance index for fast lookup */
  const distanceIndex = useMemo(() => {
    const idx = new Map<string, DistanceEntry>()
    distances.forEach((d) => {
      idx.set(`${d.origin_type}:${d.origin_id}->${d.destination_type}:${d.destination_id}`, d)
    })
    return idx
  }, [distances])

  const getDistance = (
    fromType: string, fromId: number,
    toType: string, toId: number
  ): DistanceEntry | undefined => {
    return distanceIndex.get(`${fromType}:${fromId}->${toType}:${toId}`)
      || distanceIndex.get(`${toType}:${toId}->${fromType}:${fromId}`)
  }

  const assignedPdvIds = useMemo(() => new Set(currentStops.map((s) => s.pdv_id)), [currentStops])

  /* IDs des volumes consommés par les stops du tour en construction.
     Chaque stop porte désormais son volume source EXACT (stop.volume_id) : plus
     de devinette par (pdv_id + eqp_count) — qui échouait quand un PDV a deux
     volumes de même eqc (Gel 9.96 + Frais 9.96 → cf. tickets #3/#6 : la pastille
     ne disparaissait pas et la commande passait 2×). /
     Volume IDs consumed by the tour's stops — read directly from stop.volume_id. */
  const consumedVolumeIds = useMemo(
    () => new Set(currentStops.map((s) => s.volume_id).filter((id): id is number => id != null)),
    [currentStops],
  )

  /* PDV entièrement consommés — tous leurs volumes disponibles sont dans le tour.
     Les PDV partiellement consommés (découpage) restent visibles sur la carte. /
     Fully consumed PDVs — all their available volumes are in the tour.
     Partially consumed PDVs (split) remain visible on the map. */
  const fullyConsumedPdvIds = useMemo(() => {
    const ids = new Set<number>()
    for (const pdvId of assignedPdvIds) {
      const pdvVols = volumes.filter(v => v.pdv_id === pdvId)
      const allConsumed = pdvVols.length > 0 && pdvVols.every(v => consumedVolumeIds.has(v.id))
      if (allConsumed) ids.add(pdvId)
    }
    return ids
  }, [assignedPdvIds, consumedVolumeIds, volumes])

  /* Pas de filtrage par base — tous les volumes du jour / No base filtering — all volumes for the day */
  const filteredVolumes = volumes

  /* Tous les volumes du jour (avec et sans tour_id) / All day's volumes (assigned+unassigned) */
  const allDayVolumes = useMemo(() => {
    return selectedDate
      ? allVolumes.filter((v) => v.dispatch_date === selectedDate)
      : allVolumes
  }, [allVolumes, selectedDate])

  /* Base auto-détectée depuis les volumes ajoutés / Auto-detected base from added volumes */
  const autoBaseId = useMemo(() => {
    if (currentStops.length === 0) return null
    const firstStopPdvId = currentStops[0].pdv_id
    const vol = volumes.find((v) => v.pdv_id === firstStopPdvId) || allVolumes.find((v) => v.pdv_id === firstStopPdvId)
    return vol?.base_origin_id ?? null
  }, [currentStops, volumes, allVolumes])

  /* Utiliser autoBaseId comme base effective, ou manualBaseId en mode pickup /
     Use autoBaseId as effective base, or manualBaseId in pickup mode */
  const effectiveBaseId = tourMode === 'pickup' ? manualBaseId : (autoBaseId ?? selectedBaseId)

  /* Températures des volumes dans le tour / Temperature classes of volumes in tour */
  const tourTemperatures = useMemo(() => {
    const temps = new Set<TemperatureClass>()
    for (const stop of currentStops) {
      // Utiliser la classe portée par le stop (volume réellement ajouté), pas un
      // volume arbitraire du PDV — sinon un PDV multi-classes faussait la température
      // (ex : tour FRAIS affiché BI_TEMP). Fallback lookup pour stops legacy sans classe.
      const cls = stop.temperature_class
        ?? volumes.find((v) => v.pdv_id === stop.pdv_id)?.temperature_class
        ?? allVolumes.find((v) => v.pdv_id === stop.pdv_id)?.temperature_class
      if (cls) temps.add(cls)
    }
    return temps
  }, [currentStops, volumes, allVolumes])

  /* Température suggérée / Suggested temperature */
  const suggestedTemperature = useMemo(
    () => getRequiredTemperatureType(tourTemperatures),
    [tourTemperatures],
  )

  /* Statut volume par PDV pour la carte, filtré par température.
     Un PDV reste 'unassigned' s'il a encore des volumes non consommés (découpage). /
     Volume status per PDV for map, filtered by temperature.
     A PDV stays 'unassigned' if it still has unconsumed volumes (split). */
  const pdvVolumeStatusMap = useMemo(() => {
    const m = new Map<number, PdvVolumeStatus>()
    for (const v of allDayVolumes) {
      if (tempFilters.size > 0 && !tempFilters.has(v.temperature_class)) continue
      /* Volume non affecté à un autre tour ET non consommé par le tour en cours → unassigned /
         Not assigned to another tour AND not consumed by current tour → unassigned */
      if (!v.tour_id && !consumedVolumeIds.has(v.id)) {
        m.set(v.pdv_id, 'unassigned')
      }
    }
    for (const v of allDayVolumes) {
      if (tempFilters.size > 0 && !tempFilters.has(v.temperature_class)) continue
      if (v.tour_id || consumedVolumeIds.has(v.id)) {
        /* Ne pas écraser 'unassigned' — le PDV a encore des volumes restants /
           Don't overwrite 'unassigned' — the PDV still has remaining volumes */
        if (!m.has(v.pdv_id)) m.set(v.pdv_id, 'assigned')
      }
    }
    return m
  }, [allDayVolumes, consumedVolumeIds, tempFilters])

  /* EQC par PDV ventilé par température — uniquement les volumes restants
     (non consommés par le tour en cours, non affectés à un autre tour).
     Après découpage, seul le restant non planifié apparaît sur la carte. /
     EQC per PDV by temperature — only remaining volumes
     (not consumed by current tour, not assigned to another tour).
     After split, only unplanned remainder shows on the map. */
  const pdvEqpMap = useMemo(() => {
    const m = new Map<number, Record<string, number>>()
    for (const v of allDayVolumes) {
      if (tempFilters.size > 0 && !tempFilters.has(v.temperature_class)) continue
      /* Ignorer les volumes déjà planifiés / Skip already-planned volumes */
      if (v.tour_id || consumedVolumeIds.has(v.id)) continue
      const existing = m.get(v.pdv_id) || {}
      existing[v.temperature_class] = (existing[v.temperature_class] || 0) + v.eqp_count
      m.set(v.pdv_id, existing)
    }
    return m
  }, [allDayVolumes, consumedVolumeIds, tempFilters])

  const pdvMap = useMemo(() => new Map(pdvs.map((p) => [p.id, p])), [pdvs])

  /* Dernier stop pour tri par proximité / Last stop for proximity sorting */
  const lastStopPdvId = useMemo(() => {
    if (currentStops.length === 0) return null
    return currentStops[currentStops.length - 1].pdv_id
  }, [currentStops])

  /* Calcul km estimé (sans temps) / Estimated km (no time) */
  const { totalKm, routeCoords } = useMemo(() => {
    const selectedBase = bases.find((b) => b.id === effectiveBaseId)
    let km = 0
    const coords: [number, number][] = []

    if (selectedBase?.latitude && selectedBase?.longitude) {
      coords.push([selectedBase.latitude, selectedBase.longitude])
    }

    let prevType = 'BASE'
    let prevId = effectiveBaseId ?? 0
    for (const stop of currentStops) {
      const dist = getDistance(prevType, prevId, 'PDV', stop.pdv_id)
      km += dist?.distance_km ?? 0
      const pdv = pdvMap.get(stop.pdv_id)
      if (pdv?.latitude && pdv?.longitude) {
        coords.push([pdv.latitude, pdv.longitude])
      }
      prevType = 'PDV'
      prevId = stop.pdv_id
    }

    /* Retour base / Return to base */
    if (currentStops.length > 0 && effectiveBaseId) {
      const lastStop = currentStops[currentStops.length - 1]
      const distReturn = getDistance('PDV', lastStop.pdv_id, 'BASE', effectiveBaseId)
      if (distReturn) km += distReturn.distance_km
      if (selectedBase?.latitude && selectedBase?.longitude) {
        coords.push([selectedBase.latitude, selectedBase.longitude])
      }
    }

    return { totalKm: Math.round(km * 10) / 10, routeCoords: coords }
  }, [currentStops, bases, effectiveBaseId, distanceIndex, pdvMap])

  /* Coût estimé en temps réel / Real-time estimated cost */
  const estimatedCost = useMemo(() => {
    if (totalKm <= 0 || avgCostPerKm <= 0) return 0
    return Math.round((avgFixedCost + totalKm * avgCostPerKm) * 100) / 100
  }, [totalKm, avgCostPerKm, avgFixedCost])

  const remaining = selectedVehicleType ? (capacityEqp - totalEqp) : Infinity
  /* Surbooking 15% — capacité étendue / 15% overbooking — extended capacity */
  const OVERBOOKING_PCT = 0.15
  const maxCapacityWithOverbooking = capacityEqp * (1 + OVERBOOKING_PCT)
  const remaining115 = selectedVehicleType ? (maxCapacityWithOverbooking - totalEqp) : Infinity

  /* Nom de la base auto-détectée / Auto-detected base name */
  const autoBaseName = useMemo(() => {
    if (!effectiveBaseId) return null
    const b = bases.find((b) => b.id === effectiveBaseId)
    return b ? `${b.code} — ${b.name}` : null
  }, [effectiveBaseId, bases])

  const handleSelectVehicleType = (vt: VehicleType, defaultCapacity: number) => {
    setSelectedVehicleType(vt)
    setCapacityEqp(defaultCapacity)
    setCurrentTour({ vehicle_type: vt, date: selectedDate, base_id: effectiveBaseId ?? 0, status: 'DRAFT' as const })
    /* Auto-set température si pas encore choisie / Auto-set temperature if not chosen yet */
    if (!selectedTemperatureType) {
      setSelectedTemperatureType(suggestedTemperature)
    }

    /* Détecter dépassement > 115% sur les stops existants → proposer split /
       Detect overage > 115% on existing stops → offer split (100-115% = surbooking OK) */
    const maxWithOverbooking = defaultCapacity * (1 + OVERBOOKING_PCT)
    if (totalEqp > maxWithOverbooking) {
      const overflow = totalEqp - maxWithOverbooking
      const candidates: SplitCandidate[] = []
      for (const stop of currentStops) {
        if (stop.eqp_count <= overflow) continue
        const vol = (stop.volume_id != null ? allVolumes.find(v => v.id === stop.volume_id) : undefined)
          || allVolumes.find(v => v.pdv_id === stop.pdv_id && v.dispatch_date === selectedDate && !v.tour_id && v.eqp_count === stop.eqp_count)
          || allVolumes.find(v => v.pdv_id === stop.pdv_id && v.dispatch_date === selectedDate && !v.tour_id)
        if (vol) {
          const pdv = pdvMap.get(stop.pdv_id)
          candidates.push({
            pdvId: stop.pdv_id,
            label: pdv ? `${pdv.code} — ${pdv.name}` : `PDV #${stop.pdv_id}`,
            eqpCount: stop.eqp_count,
            maxKeep: stop.eqp_count - overflow,
            volume: vol,
            isExisting: true,
          })
        }
      }
      if (candidates.length === 1) {
        setSplitDialog({ volume: candidates[0].volume, maxEqp: candidates[0].maxKeep, existingStop: true })
        setSplitEqp(candidates[0].maxKeep)
      } else if (candidates.length > 1) {
        setSplitPickerDialog({ candidates })
      }
    }
  }

  /* Ajouter un volume — phase A (sans véhicule) ou C (avec véhicule) /
     Add volume — phase A (no vehicle) or phase C (with vehicle) */
  const handleAddVolume = (vol: Volume) => {
    if (consumedVolumeIds.has(vol.id)) return

    /* Phase A : pas de véhicule → ajout libre / Phase A: no vehicle → free add */
    if (!selectedVehicleType) {
      addStop({
        id: 0,
        tour_id: 0,
        pdv_id: vol.pdv_id,
        volume_id: vol.id,
        sequence_order: currentStops.length + 1,
        eqp_count: vol.eqp_count,
        temperature_class: vol.temperature_class,
        ...getPickupFlags(vol.pdv_id),
      })
      /* Auto-set base depuis le volume / Auto-set base from volume */
      if (!autoBaseId) {
        onBaseChange(vol.base_origin_id)
      }
      return
    }

    /* Phase C : véhicule sélectionné → check température + capacité /
       Phase C: vehicle selected → check temperature + capacity */
    if (selectedTemperatureType) {
      const compat = checkTemperatureCompatibility(vol.temperature_class, selectedTemperatureType, tourTemperatures)
      if (!compat.compatible) {
        setTempUpgradeDialog({ volume: vol, upgradeTo: compat.upgradeTo })
        return
      }
    }

    if (remaining115 <= 0) return

    if (vol.eqp_count <= remaining) {
      /* Dans la capacité normale → ajout direct / Within normal capacity → add directly */
      addStop({
        id: 0,
        tour_id: 0,
        pdv_id: vol.pdv_id,
        volume_id: vol.id,
        sequence_order: currentStops.length + 1,
        eqp_count: vol.eqp_count,
        temperature_class: vol.temperature_class,
        ...getPickupFlags(vol.pdv_id),
      })
    } else if (vol.eqp_count <= remaining115) {
      /* Surbooking ≤ 15% → confirmation avant ajout / Overbooking ≤ 15% → confirm before adding */
      const newTotal = totalEqp + vol.eqp_count
      const overPct = Math.round(((newTotal - capacityEqp) / capacityEqp) * 100)
      setOverbookingDialog({ volume: vol, overPct })
    } else {
      /* Au-delà de 115% → proposer de couper / Beyond 115% → offer split */
      const overflow = vol.eqp_count - remaining115
      const candidates: SplitCandidate[] = []

      /* Stops existants dont on peut réduire le volume / Existing stops that can be reduced */
      for (const stop of currentStops) {
        if (stop.eqp_count <= overflow) continue
        const matchVol = (stop.volume_id != null ? allVolumes.find(v => v.id === stop.volume_id) : undefined)
          || allVolumes.find(v => v.pdv_id === stop.pdv_id && v.dispatch_date === selectedDate && !v.tour_id && v.eqp_count === stop.eqp_count)
          || allVolumes.find(v => v.pdv_id === stop.pdv_id && v.dispatch_date === selectedDate && !v.tour_id)
        if (matchVol) {
          const pdv = pdvMap.get(stop.pdv_id)
          candidates.push({
            pdvId: stop.pdv_id,
            label: pdv ? `${pdv.code} — ${pdv.name}` : `PDV #${stop.pdv_id}`,
            eqpCount: stop.eqp_count,
            maxKeep: stop.eqp_count - overflow,
            volume: matchVol,
            isExisting: true,
          })
        }
      }

      /* Le nouveau volume lui-même / The new volume itself */
      const newPdv = pdvMap.get(vol.pdv_id)
      candidates.push({
        pdvId: vol.pdv_id,
        label: newPdv ? `${newPdv.code} — ${newPdv.name}` : vol.pdv_code ? `${vol.pdv_code}${vol.pdv_name ? ` — ${vol.pdv_name}` : ''}` : `PDV #${vol.pdv_id}`,
        eqpCount: vol.eqp_count,
        maxKeep: Math.max(remaining115, 0),
        volume: vol,
        isExisting: false,
      })

      if (candidates.length === 1) {
        setSplitDialog({ volume: vol, maxEqp: Math.max(remaining115, 0) })
        setSplitEqp(Math.max(remaining115, 0))
      } else {
        setSplitPickerDialog({ candidates, newVolume: vol })
      }
    }
  }

  /* Confirmer upgrade température / Confirm temperature upgrade */
  const handleConfirmTempUpgrade = () => {
    if (!tempUpgradeDialog) return
    setSelectedTemperatureType(tempUpgradeDialog.upgradeTo)
    const vol = tempUpgradeDialog.volume
    setTempUpgradeDialog(null)
    /* Re-add le volume maintenant compatible / Re-add the now-compatible volume */
    if (remaining115 <= 0 && selectedVehicleType) return
    if (!selectedVehicleType || vol.eqp_count <= remaining115) {
      addStop({
        id: 0,
        tour_id: 0,
        pdv_id: vol.pdv_id,
        volume_id: vol.id,
        sequence_order: currentStops.length + 1,
        eqp_count: vol.eqp_count,
        temperature_class: vol.temperature_class,
        ...getPickupFlags(vol.pdv_id),
      })
    } else {
      setSplitDialog({ volume: vol, maxEqp: Math.max(remaining115, 0) })
      setSplitEqp(Math.max(remaining115, 0))
    }
  }

  const handleConfirmSplit = async () => {
    if (!splitDialog || splitEqp <= 0) return
    try {
      await api.post(`/volumes/${splitDialog.volume.id}/split`, { eqp_count: splitEqp })
      if (splitDialog.existingStop) {
        /* Stop déjà dans le tour → mettre à jour son EQP / Existing stop → update its EQP */
        updateStop(
          { pdv_id: splitDialog.volume.pdv_id, volume_id: splitDialog.volume.id },
          { eqp_count: splitEqp },
        )
      } else {
        /* Nouveau stop / New stop */
        addStop({
          id: 0,
          tour_id: 0,
          pdv_id: splitDialog.volume.pdv_id,
          volume_id: splitDialog.volume.id,
          sequence_order: currentStops.length + 1,
          eqp_count: splitEqp,
          temperature_class: splitDialog.volume.temperature_class,
          ...getPickupFlags(splitDialog.volume.pdv_id),
        })
      }
      refetchVolumes()
    } catch (e) {
      console.error('Failed to split volume', e)
    }
    setSplitDialog(null)
  }

  /* Utilisateur choisit quel magasin couper / User picks which stop to split */
  const handlePickSplitTarget = (candidate: SplitCandidate) => {
    if (candidate.isExisting && splitPickerDialog?.newVolume) {
      /* Couper un stop existant → ajouter le nouveau volume en entier d'abord /
         Split existing stop → add new volume fully first */
      const newVol = splitPickerDialog.newVolume
      addStop({
        id: 0,
        tour_id: 0,
        pdv_id: newVol.pdv_id,
        volume_id: newVol.id,
        sequence_order: currentStops.length + 1,
        eqp_count: newVol.eqp_count,
        temperature_class: newVol.temperature_class,
        ...getPickupFlags(newVol.pdv_id),
      })
    }
    setSplitDialog({ volume: candidate.volume, maxEqp: candidate.maxKeep, existingStop: candidate.isExisting })
    setSplitEqp(candidate.maxKeep)
    setSplitPickerDialog(null)
  }

  /* Confirmer surbooking / Confirm overbooking */
  const handleConfirmOverbooking = () => {
    if (!overbookingDialog) return
    const vol = overbookingDialog.volume
    addStop({
      id: 0,
      tour_id: 0,
      pdv_id: vol.pdv_id,
      volume_id: vol.id,
      sequence_order: currentStops.length + 1,
      eqp_count: vol.eqp_count,
      temperature_class: vol.temperature_class,
      ...getPickupFlags(vol.pdv_id),
    })
    setOverbookingDialog(null)
  }

  /* Ajouter un PDV en mode reprise / Add a PDV in pickup mode */
  const handleAddPickupPdv = (pdvId: number) => {
    if (assignedPdvIds.has(pdvId)) return
    addStop({
      id: 0,
      tour_id: 0,
      pdv_id: pdvId,
      sequence_order: currentStops.length + 1,
      eqp_count: 0,
      ...getPickupFlags(pdvId),
    })
  }

  /* Clic sur carré température d'un label multi-temp → ajouter uniquement cette température /
     Click on temperature square of multi-temp label → add only that temperature */
  const handlePdvTempClick = useCallback((pdv: PDV, temp: string) => {
    if (tourMode === 'pickup') return
    const vol = filteredVolumes.find((v) => v.pdv_id === pdv.id && v.temperature_class === temp && !consumedVolumeIds.has(v.id))
    if (!vol) return
    handleAddVolume(vol)
  }, [tourMode, filteredVolumes, consumedVolumeIds])

  /* Clic droit sur pastille carte → ouvrir le dialogue de découpage /
     Right-click on map marker → open split dialog */
  const handlePdvContextMenu = useCallback((pdv: PDV) => {
    if (tourMode === 'pickup') return
    const vol = filteredVolumes.find((v) =>
      v.pdv_id === pdv.id
      && !consumedVolumeIds.has(v.id)
      && (tempFilters.size === 0 || tempFilters.has(v.temperature_class))
    )
    if (!vol) return
    const maxEqp = selectedVehicleType ? Math.max(remaining115, 0) : vol.eqp_count
    setSplitDialog({ volume: vol, maxEqp })
    setSplitEqp(Math.min(vol.eqp_count, maxEqp))
  }, [tourMode, filteredVolumes, consumedVolumeIds, selectedVehicleType, remaining115, tempFilters])

  const handlePdvClick = (pdv: PDV) => {
    if (tourMode === 'pickup') {
      const summary = pickupByPdv.get(pdv.id)
      if (!summary || summary.pending_count === 0) return
      handleAddPickupPdv(pdv.id)
      return
    }
    /* Ajouter les volumes disponibles du PDV en respectant le filtre température actif.
       Si aucun filtre, on prend tout (multi-température). /
       Add available volumes for the PDV, respecting the active temperature filter.
       If no filter, take all (multi-temperature). */
    const vols = filteredVolumes.filter((v) =>
      v.pdv_id === pdv.id
      && !consumedVolumeIds.has(v.id)
      && (tempFilters.size === 0 || tempFilters.has(v.temperature_class))
    )
    if (vols.length === 0) return
    for (const vol of vols) {
      handleAddVolume(vol)
    }
  }

  /* Carte détachable / Detachable map */
  const { isDetached, detach, attach } = useDetachedMap({
    selectedPdvIds: fullyConsumedPdvIds,
    pdvVolumeStatusMap,
    pdvEqpMap,
    routeCoords,
    pickupByPdv,
    theme,
    regionId: selectedRegionId,
    onPdvClick: handlePdvClick,
    onPdvTempClick: handlePdvTempClick,
    onPdvContextMenu: handlePdvContextMenu,
  })

  /* Sauvegarder comme brouillon (sans contrat) / Save as draft (no contract) */
  const handleValidate = async () => {
    if (!selectedVehicleType || currentStops.length === 0) return
    if (tourMode === 'pickup' && !effectiveBaseId) return
    setSaving(true)
    try {
      await create<Tour>('/tours', {
        date: selectedDate,
        code: tourMode === 'pickup' ? `R-${Date.now()}` : `T-${Date.now()}`,
        vehicle_type: selectedVehicleType,
        capacity_eqp: capacityEqp,
        base_id: effectiveBaseId ?? 0,
        status: 'DRAFT',
        total_eqp: totalEqp,
        total_km: totalKm,
        is_pickup_tour: tourMode === 'pickup',
        tour_type: tourMode === 'pickup' ? pickupNature : 'LIVRAISON',
        bypass_support_rules: bypassSupportRules,
        temperature_type: tourMode === 'pickup' ? undefined : (selectedTemperatureType ?? undefined),
        stops: currentStops.map((s, i) => ({
          pdv_id: s.pdv_id,
          volume_id: s.volume_id,
          sequence_order: i + 1,
          eqp_count: s.eqp_count,
          pickup_cardboard: s.pickup_cardboard ?? false,
          pickup_containers: s.pickup_containers ?? false,
          pickup_returns: s.pickup_returns ?? false,
          pickup_consignment: s.pickup_consignment ?? false,
        })) as TourStop[],
      })
      resetTour()
      setSelectedVehicleType(null)
      setCapacityEqp(0)
      setSelectedTemperatureType(null)
      refetchVolumes()
    } catch (e: unknown) {
      console.error('Failed to save tour', e)
      alert(`Echec de la sauvegarde du brouillon: ${getApiErrorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /* Créer un tour mouvement (déplacement base / garage, sans arrêt) ou transfert
     PDV à PDV (2 arrêts : origine = chargement, destination = dépose) /
     Create a movement tour (base move / garage, stopless) or a PDV-to-PDV
     transfer (2 stops: origin = loading, destination = drop-off) */
  const handleCreateMovement = async () => {
    if (!selectedVehicleType || !manualBaseId) return

    /* Enlèvement dédié chez un fournisseur (distancier) avec chauffeur PARC /
       Dedicated pickup at a supplier (distancier) with a PARC base driver */
    if (movementNature === 'ENLEVEMENT_DEDIE') {
      if (!dedicatedSupplierId || !dedicatedStartTime) return
      setSaving(true)
      try {
        const supplier = suppliers.find((s) => s.id === dedicatedSupplierId)
        const matchedDriver = dedicatedDriverName
          ? baseDrivers.find((d) => `${d.last_name} ${d.first_name}` === dedicatedDriverName)
          : undefined
        await create<Tour>('/tours', {
          date: selectedDate,
          code: `ED-${Date.now()}`,
          vehicle_type: selectedVehicleType,
          base_id: manualBaseId,
          status: 'DRAFT',
          total_eqp: 0,
          total_km: 0,
          is_pickup_tour: false,
          tour_type: 'ENLEVEMENT_DEDIE',
          supplier_id: dedicatedSupplierId,
          departure_time: dedicatedStartTime,
          return_time: dedicatedEndTime || undefined,
          driver_name: dedicatedDriverName || undefined,
          driver_code_infolog: matchedDriver?.code_infolog,
          destination: supplier ? `${supplier.code} — ${supplier.name}` : undefined,
          remarks: movementComment || 'Chauffeur PARC',
          stops: [],
        })
        setSelectedVehicleType(null)
        setCapacityEqp(0)
        setDedicatedSupplierId(null)
        setDedicatedDriverName('')
        setDedicatedStartTime('')
        setDedicatedEndTime('')
        setMovementComment('')
        refetchVolumes()
      } catch (e: unknown) {
        console.error('Failed to create dedicated pickup', e)
        alert(`Echec de la création de l'enlèvement dédié: ${getApiErrorMessage(e)}`)
      } finally {
        setSaving(false)
      }
      return
    }

    const isTransfert = movementNature === 'TRANSFERT_PDV'
    if (isTransfert && (!transfertOriginPdvId || !transfertDestPdvId)) return
    if (isTransfert && transfertOriginPdvId === transfertDestPdvId) {
      alert('Le PDV de destination doit être différent du PDV d\'origine.')
      return
    }
    setSaving(true)
    try {
      const stops: TourStop[] = isTransfert
        ? ([
            { pdv_id: transfertOriginPdvId, sequence_order: 1, eqp_count: 0 },
            { pdv_id: transfertDestPdvId, sequence_order: 2, eqp_count: 0 },
          ] as unknown as TourStop[])
        : ([] as TourStop[])
      await create<Tour>('/tours', {
        date: selectedDate,
        code: `${isTransfert ? 'TR' : 'M'}-${Date.now()}`,
        vehicle_type: selectedVehicleType,
        base_id: manualBaseId,
        status: 'DRAFT',
        total_eqp: 0,
        total_km: 0,
        is_pickup_tour: false,
        tour_type: movementNature,
        destination: isTransfert ? null : (movementDestination || null),
        remarks: movementComment || undefined,
        stops,
      })
      setSelectedVehicleType(null)
      setCapacityEqp(0)
      setMovementDestination('')
      setMovementComment('')
      setTransfertOriginPdvId(null)
      setTransfertDestPdvId(null)
      refetchVolumes()
    } catch (e: unknown) {
      console.error('Failed to create movement tour', e)
      alert(`Echec de la création du ${movementNature === 'TRANSFERT_PDV' ? 'transfert' : 'mouvement'}: ${getApiErrorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  /* Créer un tour surprise : attribué à un transporteur, sans PDV (ajoutés plus
     tard via l'ordonnancement) / Create a surprise tour: assigned to a carrier,
     with no PDV yet (added later via scheduling) */
  const handleCreateSurprise = async () => {
    if (!manualBaseId || !surpriseContractId || !surpriseDepartureTime) return
    const contract = contracts.find((c) => c.id === surpriseContractId)
    setSaving(true)
    try {
      await create<Tour>('/tours', {
        date: selectedDate,
        code: `S-${Date.now()}`,
        vehicle_type: contract?.vehicle_type ?? undefined,
        capacity_eqp: contract?.capacity_eqp ?? undefined,
        base_id: manualBaseId,
        contract_id: surpriseContractId,
        departure_time: surpriseDepartureTime,
        status: 'DRAFT',
        total_eqp: 0,
        total_km: 0,
        is_pickup_tour: false,
        tour_type: 'LIVRAISON',
        temperature_type: contract?.temperature_type ?? undefined,
        remarks: movementComment || undefined,
        stops: [],
      })
      setSurpriseContractId(null)
      setSurpriseDepartureTime('')
      setMovementComment('')
      setManualBaseId(null)
      refetchVolumes()
    } catch (e: unknown) {
      console.error('Failed to create surprise tour', e)
      alert(`Echec de la création du tour surprise: ${getApiErrorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    resetTour()
    setSelectedVehicleType(null)
    setCapacityEqp(0)
    setSelectedTemperatureType(null)
    setManualBaseId(null)
    setMovementDestination('')
    setMovementComment('')
    setTransfertOriginPdvId(null)
    setTransfertDestPdvId(null)
    setDedicatedSupplierId(null)
    setDedicatedDriverName('')
    setDedicatedStartTime('')
    setDedicatedEndTime('')
    setSurpriseContractId(null)
    setSurpriseDepartureTime('')
  }

  /* Bandeau véhicule inline / Inline vehicle banner — shown after first stop, before vehicle selection */
  const vehicleBanner = currentStops.length > 0 && !selectedVehicleType ? (
    <div
      className="rounded-xl border-2 p-4"
      style={{ borderColor: 'var(--color-primary)', backgroundColor: 'rgba(249,115,22,0.05)' }}
    >
      <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
        {tourMode === 'pickup' ? 'Selectionnez le vehicule' : 'Selectionnez la temperature puis le vehicule'}
      </h3>
      {autoBaseName && tourMode !== 'pickup' && (
        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
          Base detectee: <span className="font-semibold" style={{ color: 'var(--color-primary)' }}>{autoBaseName}</span>
        </p>
      )}
      <VehicleSelector
        selectedType={null}
        onSelect={handleSelectVehicleType}
        selectedTemperature={tourMode === 'pickup' ? undefined : selectedTemperatureType}
        onTemperatureSelect={tourMode === 'pickup' ? undefined : setSelectedTemperatureType}
        suggestedTemperature={tourMode === 'pickup' ? undefined : suggestedTemperature}
        tourTemperatures={tourMode === 'pickup' ? undefined : tourTemperatures}
      />
    </div>
  ) : null

  return (
    <div className="space-y-4">
      {/* Barre supérieure: date + info véhicule/température / Top bar */}
      <div
        className="rounded-xl border p-4 flex flex-wrap items-end gap-4"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
      >
        {/* Date */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Date de répartition
          </label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{
              backgroundColor: 'var(--bg-primary)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* Toggle mode Livraison / Reprise vide */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Mode
          </label>
          <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-color)' }}>
            <button
              className="px-3 py-2 text-xs font-semibold transition-all"
              style={{
                backgroundColor: tourMode === 'delivery' ? 'var(--color-primary)' : 'var(--bg-primary)',
                color: tourMode === 'delivery' ? '#fff' : 'var(--text-muted)',
              }}
              onClick={() => { if (tourMode !== 'delivery') { handleReset(); setTourMode('delivery') } }}
            >
              Livraison
            </button>
            <button
              className="px-3 py-2 text-xs font-semibold transition-all"
              style={{
                backgroundColor: tourMode === 'pickup' ? '#f59e0b' : 'var(--bg-primary)',
                color: tourMode === 'pickup' ? '#000' : 'var(--text-muted)',
              }}
              onClick={() => { if (tourMode !== 'pickup') { handleReset(); setTourMode('pickup') } }}
            >
              Reprise vide
            </button>
            <button
              className="px-3 py-2 text-xs font-semibold transition-all"
              style={{
                backgroundColor: tourMode === 'movement' ? '#6366f1' : 'var(--bg-primary)',
                color: tourMode === 'movement' ? '#fff' : 'var(--text-muted)',
              }}
              onClick={() => { if (tourMode !== 'movement') { handleReset(); setTourMode('movement') } }}
            >
              Mouvement
            </button>
            <button
              className="px-3 py-2 text-xs font-semibold transition-all"
              style={{
                backgroundColor: tourMode === 'surprise' ? '#0ea5e9' : 'var(--bg-primary)',
                color: tourMode === 'surprise' ? '#fff' : 'var(--text-muted)',
              }}
              onClick={() => { if (tourMode !== 'surprise') { handleReset(); setTourMode('surprise') } }}
            >
              Tour surprise
            </button>
          </div>
        </div>

        {/* Nature en mode reprise (Enlèvement / Vidanges) */}
        {tourMode === 'pickup' && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Nature</label>
            <select
              value={pickupNature}
              onChange={(e) => setPickupNature(e.target.value as 'ENLEVEMENT' | 'VIDANGES')}
              className="rounded-lg border px-3 py-2 text-sm"
              style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
            >
              <option value="ENLEVEMENT">Enlèvement</option>
              <option value="VIDANGES">Vidanges</option>
            </select>
          </div>
        )}

        {/* Formulaire mouvement véhicule (sans arrêt PDV) / Vehicle movement form (stopless) */}
        {tourMode === 'movement' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Nature</label>
              <select
                value={movementNature}
                onChange={(e) => {
                  const nat = e.target.value as 'DEPLACEMENT_BASE' | 'GARAGE' | 'TRANSFERT_PDV' | 'ENLEVEMENT_DEDIE'
                  setMovementNature(nat)
                  // Pré-remplir le commentaire « Chauffeur PARC » pour l'enlèvement dédié /
                  // Prefill the "Chauffeur PARC" comment for the dedicated pickup
                  if (nat === 'ENLEVEMENT_DEDIE' && !movementComment) setMovementComment('Chauffeur PARC')
                }}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              >
                <option value="DEPLACEMENT_BASE">Déplacement base</option>
                <option value="GARAGE">Garage / atelier</option>
                <option value="TRANSFERT_PDV">Transfert PDV à PDV</option>
                <option value="ENLEVEMENT_DEDIE">Enlèvement dédié</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Base</label>
              <select
                value={manualBaseId ?? ''}
                onChange={(e) => setManualBaseId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              >
                <option value="">-- Base --</option>
                {bases.map((b) => (
                  <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>{t('tourPlanning.vehicleType')}</label>
              <select
                value={selectedVehicleType ?? ''}
                onChange={(e) => {
                  const vt = (e.target.value || null) as VehicleType | null
                  setSelectedVehicleType(vt)
                  setCapacityEqp(vt ? VEHICLE_TYPE_DEFAULTS[vt].capacity_eqp : 0)
                }}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              >
                <option value="">-- Type --</option>
                {(Object.keys(VEHICLE_TYPE_DEFAULTS) as VehicleType[]).map((vt) => (
                  <option key={vt} value={vt}>{VEHICLE_TYPE_DEFAULTS[vt].label}</option>
                ))}
              </select>
            </div>
            {/* Transfert PDV à PDV : origine (chargement) → destination (dépose) */}
            {movementNature === 'TRANSFERT_PDV' ? (
              <>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>PDV origine</label>
                  <select
                    value={transfertOriginPdvId ?? ''}
                    onChange={(e) => setTransfertOriginPdvId(e.target.value ? Number(e.target.value) : null)}
                    className="rounded-lg border px-3 py-2 text-sm w-[200px]"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="">-- PDV origine --</option>
                    {pdvs.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>PDV destination</label>
                  <select
                    value={transfertDestPdvId ?? ''}
                    onChange={(e) => setTransfertDestPdvId(e.target.value ? Number(e.target.value) : null)}
                    className="rounded-lg border px-3 py-2 text-sm w-[200px]"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="">-- PDV destination --</option>
                    {pdvs.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                </div>
              </>
            ) : movementNature === 'ENLEVEMENT_DEDIE' ? (
              <>
                {/* Fournisseur (point d'enlèvement, dans le distancier) / Supplier pickup point */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Fournisseur</label>
                  <select
                    value={dedicatedSupplierId ?? ''}
                    onChange={(e) => setDedicatedSupplierId(e.target.value ? Number(e.target.value) : null)}
                    className="rounded-lg border px-3 py-2 text-sm w-[220px]"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="">-- Fournisseur --</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                    ))}
                  </select>
                </div>
                {/* Chauffeur PARC (chauffeur Base) / PARC base driver */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Chauffeur PARC</label>
                  <select
                    value={dedicatedDriverName}
                    onChange={(e) => setDedicatedDriverName(e.target.value)}
                    className="rounded-lg border px-3 py-2 text-sm w-[180px]"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="">-- Chauffeur --</option>
                    {baseDrivers
                      .filter((d) => !manualBaseId || d.base_id === manualBaseId)
                      .map((d) => {
                        const name = `${d.last_name} ${d.first_name}`
                        return <option key={d.id} value={name}>{name}</option>
                      })}
                  </select>
                </div>
                {/* Heure de début / Start time */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Heure de début</label>
                  <input
                    type="time"
                    value={dedicatedStartTime}
                    onChange={(e) => setDedicatedStartTime(e.target.value)}
                    className="rounded-lg border px-3 py-2 text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
                {/* Heure de fin / End time */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Heure de fin</label>
                  <input
                    type="time"
                    value={dedicatedEndTime}
                    onChange={(e) => setDedicatedEndTime(e.target.value)}
                    className="rounded-lg border px-3 py-2 text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Destination</label>
                <input
                  type="text"
                  value={movementDestination}
                  onChange={(e) => setMovementDestination(e.target.value)}
                  placeholder="Garage X, base Y…"
                  className="rounded-lg border px-3 py-2 text-sm w-[200px]"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                />
              </div>
            )}
            {/* Commentaire libre (mouvement + transfert) */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Commentaire</label>
              <input
                type="text"
                value={movementComment}
                onChange={(e) => setMovementComment(e.target.value)}
                placeholder="Commentaire (optionnel)…"
                className="rounded-lg border px-3 py-2 text-sm w-[220px]"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              />
            </div>
            <button
              className="px-3 py-2 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40 self-end"
              style={{ backgroundColor: '#6366f1' }}
              disabled={
                !selectedVehicleType || !manualBaseId || saving
                || (movementNature === 'TRANSFERT_PDV' && (!transfertOriginPdvId || !transfertDestPdvId))
                || (movementNature === 'ENLEVEMENT_DEDIE' && (!dedicatedSupplierId || !dedicatedStartTime))
              }
              onClick={handleCreateMovement}
            >
              {saving ? '...' : (
                movementNature === 'TRANSFERT_PDV' ? 'Créer le transfert'
                : movementNature === 'ENLEVEMENT_DEDIE' ? 'Créer l\'enlèvement'
                : 'Créer le mouvement'
              )}
            </button>
          </>
        )}

        {/* Formulaire tour surprise (transporteur sans PDV) / Surprise tour form (carrier, no PDV) */}
        {tourMode === 'surprise' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Base</label>
              <select
                value={manualBaseId ?? ''}
                onChange={(e) => setManualBaseId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              >
                <option value="">-- Base --</option>
                {bases.map((b) => (
                  <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Transporteur</label>
              <select
                value={surpriseContractId ?? ''}
                onChange={(e) => setSurpriseContractId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border px-3 py-2 text-sm w-[220px]"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              >
                <option value="">-- Transporteur --</option>
                {contracts.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.transporter_name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Heure de départ</label>
              <input
                type="time"
                value={surpriseDepartureTime}
                onChange={(e) => setSurpriseDepartureTime(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Commentaire</label>
              <input
                type="text"
                value={movementComment}
                onChange={(e) => setMovementComment(e.target.value)}
                placeholder="Commentaire (optionnel)…"
                className="rounded-lg border px-3 py-2 text-sm w-[200px]"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              />
            </div>
            <button
              className="px-3 py-2 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-40 self-end"
              style={{ backgroundColor: '#0ea5e9' }}
              disabled={!manualBaseId || !surpriseContractId || !surpriseDepartureTime || saving}
              onClick={handleCreateSurprise}
            >
              {saving ? '...' : 'Créer le tour surprise'}
            </button>
            <p className="text-xs self-end pb-2 max-w-[280px]" style={{ color: 'var(--text-muted)' }}>
              Les PDV seront ajoutés plus tard depuis l'ordonnancement.
            </p>
          </>
        )}

        {/* Selecteur base en mode pickup / Base selector in pickup mode */}
        {tourMode === 'pickup' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                Base
              </label>
              <select
                value={manualBaseId ?? ''}
                onChange={(e) => setManualBaseId(e.target.value ? Number(e.target.value) : null)}
                className="rounded-lg border px-3 py-2 text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              >
                <option value="">-- Base --</option>
                {bases.map((b) => (
                  <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer self-end pb-1">
              <input
                type="checkbox"
                checked={bypassSupportRules}
                onChange={(e) => setBypassSupportRules(e.target.checked)}
                className="rounded"
              />
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Toutes bases
              </span>
            </label>
          </>
        )}

        {/* Base auto-detectee / Auto-detected base */}
        {tourMode === 'delivery' && autoBaseName && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Base (auto)
            </label>
            <span className="text-sm font-semibold px-3 py-2" style={{ color: 'var(--color-primary)' }}>
              {autoBaseName}
            </span>
          </div>
        )}

        {/* Type de véhicule sélectionné / Selected vehicle type */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            {t('tourPlanning.vehicleType')}
          </label>
          <span className="text-sm font-semibold px-3 py-2" style={{ color: selectedVehicleType ? 'var(--color-primary)' : 'var(--text-muted)' }}>
            {selectedVehicleType
              ? `${VEHICLE_TYPE_DEFAULTS[selectedVehicleType].label} (${capacityEqp} EQC)`
              : t('tourPlanning.selectVehicleType')}
          </span>
        </div>

        {/* Badge température / Temperature badge */}
        {selectedTemperatureType && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Température
            </label>
            <span className="text-sm font-semibold px-3 py-2" style={{ color: 'var(--text-primary)' }}>
              {TEMPERATURE_TYPE_LABELS[selectedTemperatureType]}
            </span>
          </div>
        )}

        {/* Indicateur volumes + reset / Volumes indicator + reset */}
        <div className="ml-auto flex items-end gap-3">
          {(currentStops.length > 0 || selectedVehicleType || selectedTemperatureType) && (
            <button
              className="px-3 py-2 rounded-lg text-xs font-medium border transition-all hover:opacity-80"
              style={{
                borderColor: 'var(--color-danger)',
                color: 'var(--color-danger)',
                backgroundColor: 'rgba(239,68,68,0.08)',
              }}
              onClick={handleReset}
            >
              {t('tourPlanning.resetTour')}
            </button>
          )}
          <div className="text-right">
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {tourMode === 'pickup' ? 'PDVs a reprendre' : t('tourPlanning.availableVolumes')}
            </span>
            <p className="text-lg font-bold" style={{ color: tourMode === 'pickup' ? '#f59e0b' : 'var(--color-primary)' }}>
              {tourMode === 'pickup'
                ? pickupSummaries.filter((s) => s.pending_count > 0 && !assignedPdvIds.has(s.pdv_id)).length
                : filteredVolumes.filter((v) => !consumedVolumeIds.has(v.id)).length}
            </p>
          </div>
        </div>
      </div>

      {/* Layout principal — toujours visible dès que la date est sélectionnée /
          Main layout — always visible once date is selected */}
      <>
        {/* Desktop: panneaux redimensionnables / Desktop: resizable panels */}
        <div className="hidden lg:block" style={{ height: 'calc(100vh - 320px)' }}>
          {isDetached ? (
            /* Carte détachée → panneaux data pleine largeur / Map detached → full-width data panels */
            <div className="flex flex-col h-full gap-2">
              <div className="flex justify-start py-1">
                <button
                  onClick={attach}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-all hover:opacity-80"
                  style={{
                    backgroundColor: 'rgba(234,179,8,0.15)',
                    borderColor: 'var(--color-warning)',
                    color: 'var(--color-warning)',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  Rattacher la carte
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <Group orientation="horizontal" defaultLayout={innerLayout.defaultLayout} onLayoutChanged={innerLayout.onLayoutChanged}>
                  <Panel defaultSize={50} minSize={25}>
                    <div className="h-full overflow-y-auto">
                      {tourMode === 'pickup' ? (
                        <PickupPanel
                          pickupSummaries={pickupSummaries}
                          pdvs={pdvs}
                          assignedPdvIds={assignedPdvIds}
                          onAddPdv={handleAddPickupPdv}
                          lastStopPdvId={lastStopPdvId}
                          baseId={effectiveBaseId}
                          distanceIndex={distanceIndex}
                        />
                      ) : (
                        <VolumePanel
                          volumes={filteredVolumes}
                          pdvs={pdvs}
                          consumedVolumeIds={consumedVolumeIds}
                          onAddVolume={handleAddVolume}
                          vehicleCapacity={capacityEqp}
                          currentEqp={totalEqp}
                          lastStopPdvId={lastStopPdvId}
                          baseId={effectiveBaseId}
                          distanceIndex={distanceIndex}
                          pickupSummaries={pickupSummaries}
                          tempFilters={tempFilters}
                          onTempFiltersChange={setTempFilters}
                          baseFilters={baseFilters}
                          onBaseFiltersChange={setBaseFilters}
                          availableBases={availableBases}
                        />
                      )}
                    </div>
                  </Panel>

                  <ResizeHandle id="handle-inner" />

                  <Panel defaultSize={50} minSize={25}>
                    <div className="flex flex-col h-full gap-2 overflow-y-auto">
                      {vehicleBanner}
                      <div className="flex-1 min-h-0 overflow-y-auto">
                        <TourSummary
                          stops={currentStops}
                          pdvs={pdvs}
                          vehicleType={selectedVehicleType}
                          capacityEqp={capacityEqp}
                          totalEqp={totalEqp}
                          totalKm={totalKm}
                          totalCost={estimatedCost}
                          onRemoveStop={removeStop}
                          onReorderStops={reorderStops}
                          onUpdateStop={tourMode === 'pickup' ? undefined : updateStop}
                          temperatureType={selectedTemperatureType}
                          tourTemperatures={tourTemperatures}
                          volumes={allDayVolumes}
                          isPickupTour={tourMode === 'pickup'}
                        />
                      </div>
                      <TourValidation
                        stops={currentStops}
                        vehicleType={selectedVehicleType}
                        capacityEqp={capacityEqp}
                        totalEqp={totalEqp}
                        onValidate={handleValidate}
                        onReset={handleReset}
                        temperatureType={selectedTemperatureType}
                        isPickupTour={tourMode === 'pickup'}
                        baseId={effectiveBaseId}
                      />
                      {saving && (
                        <p className="text-xs text-center" style={{ color: 'var(--color-primary)' }}>
                          {t('common.loading')}
                        </p>
                      )}
                    </div>
                  </Panel>
                </Group>
              </div>
            </div>
          ) : (
            /* Carte inline → layout normal / Map inline → normal layout */
            <Group orientation="horizontal" defaultLayout={outerLayout.defaultLayout} onLayoutChange={(...args) => { outerLayout.onLayoutChange(...args); handlePanelLayout() }} onLayoutChanged={outerLayout.onLayoutChanged}>
              {/* Carte / Map */}
              <Panel defaultSize={40} minSize={25}>
                <div className="h-full flex flex-col">
                  <div className="flex justify-end py-1 px-1">
                    <button
                      onClick={detach}
                      className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border transition-all hover:opacity-80"
                      style={{
                        backgroundColor: 'var(--bg-secondary)',
                        borderColor: 'var(--border-color)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                      Détacher la carte
                    </button>
                  </div>
                  <div className="flex-1 min-h-0">
                  <MapView
                    onPdvClick={handlePdvClick}
                    onPdvTempClick={handlePdvTempClick}
                    onPdvContextMenu={handlePdvContextMenu}
                    selectedPdvIds={fullyConsumedPdvIds}
                    pdvVolumeStatusMap={pdvVolumeStatusMap}
                    pdvEqpMap={pdvEqpMap}
                    pickupByPdv={pickupByPdv}
                    routeCoords={routeCoords}
                    height="100%"
                    resizeSignal={mapResizeSignal}
                  />
                  </div>
                </div>
              </Panel>

              <ResizeHandle id="handle-map" />

              {/* Panneaux droits / Right panels */}
              <Panel defaultSize={60} minSize={30}>
                <div className="flex flex-col h-full gap-2">
                  <div className="flex-1 min-h-0">
                    <Group orientation="horizontal" defaultLayout={innerLayout.defaultLayout} onLayoutChanged={innerLayout.onLayoutChanged}>
                      {/* Volumes disponibles ou PDVs reprise / Available volumes or pickup PDVs */}
                      <Panel defaultSize={50} minSize={25}>
                        <div className="h-full overflow-y-auto">
                          {tourMode === 'pickup' ? (
                            <PickupPanel
                              pickupSummaries={pickupSummaries}
                              pdvs={pdvs}
                              assignedPdvIds={assignedPdvIds}
                              onAddPdv={handleAddPickupPdv}
                              lastStopPdvId={lastStopPdvId}
                              baseId={effectiveBaseId}
                              distanceIndex={distanceIndex}
                            />
                          ) : (
                            <VolumePanel
                              volumes={filteredVolumes}
                              pdvs={pdvs}
                              consumedVolumeIds={consumedVolumeIds}
                              onAddVolume={handleAddVolume}
                              vehicleCapacity={capacityEqp}
                              currentEqp={totalEqp}
                              lastStopPdvId={lastStopPdvId}
                              baseId={effectiveBaseId}
                              distanceIndex={distanceIndex}
                              pickupSummaries={pickupSummaries}
                              tempFilters={tempFilters}
                              onTempFiltersChange={setTempFilters}
                              baseFilters={baseFilters}
                              onBaseFiltersChange={setBaseFilters}
                              availableBases={availableBases}
                            />
                          )}
                        </div>
                      </Panel>

                      <ResizeHandle id="handle-inner" />

                      {/* Resume + validation / Tour summary + validation */}
                      <Panel defaultSize={50} minSize={25}>
                        <div className="flex flex-col h-full gap-2 overflow-y-auto">
                          {vehicleBanner}
                          <div className="flex-1 min-h-0 overflow-y-auto">
                            <TourSummary
                              stops={currentStops}
                              pdvs={pdvs}
                              vehicleType={selectedVehicleType}
                              capacityEqp={capacityEqp}
                              totalEqp={totalEqp}
                              totalKm={totalKm}
                              totalCost={estimatedCost}
                              onRemoveStop={removeStop}
                              onReorderStops={reorderStops}
                              onUpdateStop={tourMode === 'pickup' ? undefined : updateStop}
                              temperatureType={selectedTemperatureType}
                              tourTemperatures={tourTemperatures}
                              isPickupTour={tourMode === 'pickup'}
                            />
                          </div>
                          <TourValidation
                            stops={currentStops}
                            vehicleType={selectedVehicleType}
                            capacityEqp={capacityEqp}
                            totalEqp={totalEqp}
                            onValidate={handleValidate}
                            onReset={handleReset}
                            temperatureType={selectedTemperatureType}
                            isPickupTour={tourMode === 'pickup'}
                            baseId={effectiveBaseId}
                          />
                          {saving && (
                            <p className="text-xs text-center" style={{ color: 'var(--color-primary)' }}>
                              {t('common.loading')}
                            </p>
                          )}
                        </div>
                      </Panel>
                    </Group>
                  </div>
                </div>
              </Panel>
            </Group>
          )}
        </div>

        {/* Mobile: layout empilé classique / Mobile: stacked fallback */}
        <div className="lg:hidden space-y-4">
          <div className="min-h-[400px]">
            <MapView
              onPdvClick={handlePdvClick}
              onPdvContextMenu={handlePdvContextMenu}
              selectedPdvIds={fullyConsumedPdvIds}
              pdvVolumeStatusMap={pdvVolumeStatusMap}
              pdvEqpMap={pdvEqpMap}
              pickupByPdv={pickupByPdv}
              routeCoords={routeCoords}
              height="400px"
            />
          </div>
          {tourMode === 'pickup' ? (
            <PickupPanel
              pickupSummaries={pickupSummaries}
              pdvs={pdvs}
              assignedPdvIds={assignedPdvIds}
              onAddPdv={handleAddPickupPdv}
              lastStopPdvId={lastStopPdvId}
              baseId={effectiveBaseId}
              distanceIndex={distanceIndex}
            />
          ) : (
            <VolumePanel
              volumes={filteredVolumes}
              pdvs={pdvs}
              consumedVolumeIds={consumedVolumeIds}
              onAddVolume={handleAddVolume}
              vehicleCapacity={capacityEqp}
              currentEqp={totalEqp}
              lastStopPdvId={lastStopPdvId}
              baseId={effectiveBaseId}
              distanceIndex={distanceIndex}
              pickupSummaries={pickupSummaries}
              tempFilters={tempFilters}
              onTempFiltersChange={setTempFilters}
              baseFilters={baseFilters}
              onBaseFiltersChange={setBaseFilters}
              availableBases={availableBases}
            />
          )}
          {vehicleBanner}
          <TourSummary
            stops={currentStops}
            pdvs={pdvs}
            vehicleType={selectedVehicleType}
            capacityEqp={capacityEqp}
            totalEqp={totalEqp}
            totalKm={totalKm}
            totalCost={estimatedCost}
            onRemoveStop={removeStop}
            onReorderStops={reorderStops}
            onUpdateStop={tourMode === 'pickup' ? undefined : updateStop}
            temperatureType={selectedTemperatureType}
            tourTemperatures={tourTemperatures}
            isPickupTour={tourMode === 'pickup'}
          />
          <TourValidation
            stops={currentStops}
            vehicleType={selectedVehicleType}
            capacityEqp={capacityEqp}
            totalEqp={totalEqp}
            onValidate={handleValidate}
            onReset={handleReset}
            temperatureType={selectedTemperatureType}
            isPickupTour={tourMode === 'pickup'}
            baseId={effectiveBaseId}
          />
          {saving && (
            <p className="text-xs text-center" style={{ color: 'var(--color-primary)' }}>
              {t('common.loading')}
            </p>
          )}
        </div>
      </>

      {/* Dialog de fractionnement / Split volume dialog */}
      {splitDialog && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div
            className="rounded-xl border shadow-2xl p-6 w-[380px] space-y-4"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
          >
            <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              {t('tourPlanning.splitVolume')}
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {splitDialog.existingStop
                ? `Ce volume fait ${splitDialog.volume.eqp_count} EQC mais la capacité restante est ${splitDialog.maxEqp} EQC. Choisissez combien garder dans ce tour.`
                : t('tourPlanning.splitHint', { total: splitDialog.volume.eqp_count, remaining: splitDialog.maxEqp })}
            </p>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {t('tourPlanning.eqpToLoad')}
              </label>
              <input
                type="number"
                min={0.01}
                max={splitDialog.maxEqp}
                step={0.01}
                value={splitEqp}
                onChange={(e) => setSplitEqp(Math.min(Math.max(0.01, Number(e.target.value)), splitDialog.maxEqp))}
                className="rounded-lg border px-3 py-2 text-sm w-full"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                → {Math.round((splitDialog.volume.eqp_count - splitEqp) * 100) / 100} EQC {t('tourPlanning.splitRemainder')}
              </span>
            </div>

            <div className="flex gap-2">
              <button
                className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
                onClick={handleConfirmSplit}
              >
                {t('common.confirm')}
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
                onClick={() => setSplitDialog(null)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialog confirmation surbooking / Overbooking confirmation dialog */}
      {overbookingDialog && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div
            className="rounded-xl border shadow-2xl p-6 w-[400px] space-y-4"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
          >
            <h3 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--color-warning)' }}>
              Surbooking ({overbookingDialog.overPct}% au-delà)
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              L'ajout de ce volume portera le tour à{' '}
              <strong>{Math.round((totalEqp + overbookingDialog.volume.eqp_count) * 100) / 100} EQC</strong>{' '}
              pour une capacité de <strong>{capacityEqp} EQC</strong>.
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Le dépassement reste dans la marge de 15% autorisée. Confirmer le surbooking ?
            </p>
            <div className="flex gap-2">
              <button
                className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{ backgroundColor: 'var(--color-warning)', color: '#fff' }}
                onClick={handleConfirmOverbooking}
              >
                Confirmer le surbooking
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
                onClick={() => setOverbookingDialog(null)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialog choix du magasin à couper / Split target picker dialog */}
      {splitPickerDialog && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div
            className="rounded-xl border shadow-2xl p-6 w-[420px] space-y-4"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
          >
            <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              Quel magasin couper ?
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              La capacité du camion est dépassée. Choisissez le magasin dont vous souhaitez réduire le volume.
            </p>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {splitPickerDialog.candidates.map((c, i) => (
                <button
                  key={`${c.pdvId}-${c.isExisting}-${i}`}
                  onClick={() => handlePickSplitTarget(c)}
                  className="w-full text-left rounded-lg border p-3 text-xs transition-all hover:brightness-110"
                  style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)' }}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {c.label}
                      {!c.isExisting && <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--color-primary)' }}>(nouveau)</span>}
                    </span>
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{c.eqpCount} EQC</span>
                  </div>
                  <div className="mt-1" style={{ color: 'var(--text-muted)' }}>
                    Garder max {c.maxKeep} EQC — renvoyer {c.eqpCount - c.maxKeep} en disponible
                  </div>
                </button>
              ))}
            </div>
            <button
              className="w-full px-4 py-2 rounded-lg text-sm border transition-all hover:opacity-80"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
              onClick={() => setSplitPickerDialog(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Dialog upgrade température / Temperature upgrade dialog */}
      {tempUpgradeDialog && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div
            className="rounded-xl border shadow-2xl p-6 w-[380px] space-y-4"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
          >
            <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              Changement de température
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Ce volume est <strong>{tempUpgradeDialog.volume.temperature_class}</strong>, le tour est <strong>{selectedTemperatureType && TEMPERATURE_TYPE_LABELS[selectedTemperatureType]}</strong>.
            </p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Passer en <strong>{TEMPERATURE_TYPE_LABELS[tempUpgradeDialog.upgradeTo]}</strong> ?
            </p>

            <div className="flex gap-2">
              <button
                className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
                onClick={handleConfirmTempUpgrade}
              >
                {t('common.confirm')}
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
                onClick={() => setTempUpgradeDialog(null)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
