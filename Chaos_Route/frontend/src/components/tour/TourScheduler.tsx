/* Ordonnancement des tours — vue postier / Tour scheduling — postman-style view */

import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useApi } from '../../hooks/useApi'
import { useAppStore } from '../../stores/useAppStore'
import { useAuthStore } from '../../stores/useAuthStore'
import { TourGantt, type GanttTour } from './TourGantt'
import { TourPrintPlan } from './TourPrintPlan'
import { formatDuration, parseTime, formatTime, formatDate, DEFAULT_DOCK_TIME, DEFAULT_UNLOAD_PER_EQP } from '../../utils/tourTimeUtils'
import { VEHICLE_TYPE_DEFAULTS, TEMPERATURE_TYPE_LABELS, TEMPERATURE_COLORS, TOUR_TYPE_LABELS } from '../../types'
import api from '../../services/api'
import { CostBreakdown } from './CostBreakdown'
import { TransporterConfirmationModal, type ConfirmTransporter } from './TransporterConfirmationModal'
import type { Tour, BaseLogistics, Contract, DistanceEntry, PDV, VehicleType, TemperatureType, TemperatureClass, Volume, Vehicle, AssignmentMode, AvailableVehicle } from '../../types'

/* Filtres activité / Activity filter options */
const ACTIVITY_FILTERS: { key: string; label: string }[] = [
  { key: 'ALL', label: 'Tous' },
  { key: 'SEC', label: 'Sec' },
  { key: 'FRAIS', label: 'Frais' },
  { key: 'GEL', label: 'Gel' },
  { key: 'BI_TEMP', label: 'Bi-temp' },
  { key: 'TRI_TEMP', label: 'Tri-temp' },
]

/* Types véhicule disponibles pour filtre / Vehicle types for filter */
const VEHICLE_TYPE_OPTIONS: VehicleType[] = ['SEMI', 'PORTEUR', 'PORTEUR_SURBAISSE', 'PORTEUR_REMORQUE', 'CITY', 'VL']

/* Libellé court (cases compactes) / Short label for compact chips */
const VEHICLE_TYPE_SHORT: Record<string, string> = {
  SEMI: 'Semi', PORTEUR: 'Porteur', PORTEUR_SURBAISSE: 'Porteur surb.',
  PORTEUR_REMORQUE: 'Porteur rem.', CITY: 'City', VL: 'VL',
}

/* Modes d'affectation pour filtre / Assignment modes for filter */
const MODE_OPTIONS: { key: AssignmentMode; label: string }[] = [
  { key: 'preste', label: 'Presté' },
  { key: 'propre', label: 'Propre' },
  { key: 'mixte', label: 'Mixte' },
]

/* Case de filtre standardisée (hauteur fixe, remplit sa cellule de grille) /
   Standardized filter chip (fixed height, fills its grid cell) */
const CHIP = 'h-7 px-2 text-[11px] font-medium rounded border transition-all w-full flex items-center justify-center text-center leading-none whitespace-nowrap'

/* Section de filtre uniforme (label + contenu) / Uniform filter section */
function FilterGroup({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</label>
      {children}
    </div>
  )
}

/* Dériver le mode d'affectation d'un tour / Derive assignment mode from tour */
function getTourMode(tour: Tour): AssignmentMode | null {
  const hasContract = !!tour.contract_id
  const hasVehicle = !!tour.vehicle_id
  // Ressource propre = véhicule OU tracteur OU chauffeur Base (cas des mouvements
  // affectés à un seul chauffeur, sans véhicule). / Own resource = vehicle OR
  // tractor OR base driver (movement assigned to a driver only).
  const hasOwnResource = hasVehicle || !!tour.tractor_id || !!tour.driver_name
  if (hasContract && hasVehicle) return 'mixte'
  if (hasContract) return 'preste'
  if (hasOwnResource) return 'propre'
  return null
}

/* --- Préférences persistées / Persisted preferences --- */

const PREFS_KEY = 'scheduler-prefs'

interface SchedulerPrefs {
  leftWidth: number
  listColumns: 1 | 2 | 3
}

function loadPrefs(): SchedulerPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        leftWidth: parsed.leftWidth ?? 440,
        listColumns: parsed.listColumns === 2 || parsed.listColumns === 3 ? parsed.listColumns : 1,
      }
    }
  } catch { /* ignore */ }
  return { leftWidth: 440, listColumns: 1 }
}

function savePrefs(p: SchedulerPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p))
}

/* --- Composant principal / Main component --- */

interface TourSchedulerProps {
  selectedDate: string
  onDateChange: (date: string) => void
  /* Mode embarqué pour les pages détachées / Embedded mode for detached pages */
  embeddedMode?: 'list-only' | 'gantt-only'
}

export function TourScheduler({ selectedDate, onDateChange, embeddedMode }: TourSchedulerProps) {
  const { t } = useTranslation()
  const { selectedRegionId, theme } = useAppStore()
  // Déplanifier ("Retirer") réservé au transport via permission dédiée /
  // Unscheduling ("Retirer") restricted to transport via dedicated permission
  const canUnschedule = useAuthStore((s) => s.hasPermission('tour-unschedule', 'update'))

  const regionParams = selectedRegionId ? { region_id: selectedRegionId } : undefined
  const { data: bases } = useApi<BaseLogistics>('/bases', regionParams)
  const { data: allContracts } = useApi<Contract>('/contracts', regionParams)
  const { data: distances } = useApi<DistanceEntry>('/distance-matrix')
  const { data: pdvs } = useApi<PDV>('/pdvs', regionParams)
  const { data: allVolumes } = useApi<Volume>('/volumes', regionParams)

  const contractMap = useMemo(() => new Map(allContracts.map((c) => [c.id, c])), [allContracts])

  /* Véhicules propres du parc / Own fleet vehicles */
  const { data: allVehicles } = useApi<Vehicle>('/vehicles', regionParams)
  const vehicleMap = useMemo(() => new Map(allVehicles.map((v) => [v.id, v])), [allVehicles])

  /* Chauffeurs base / Base drivers */
  const { data: baseDrivers } = useApi<{ id: number; last_name: string; first_name: string; code_infolog: string; base_id: number }>('/base-drivers')

  /* Type de l'input d'ordonnancement / Schedule input type */
  interface ScheduleInput {
    time: string
    deliveryDate: string
    mode: AssignmentMode
    contractId: number | null
    vehicleId: number | null
    tractorId: number | null
    driverName: string
    priority: number | null
  }
  const EMPTY_INPUT: ScheduleInput = { time: '', deliveryDate: '', mode: 'preste', contractId: null, vehicleId: null, tractorId: null, driverName: '', priority: null }

  const [tours, setTours] = useState<Tour[]>([])
  const [timeline, setTimeline] = useState<GanttTour[]>([])
  const [highlightedTourId, setHighlightedTourId] = useState<number | null>(null)
  const [scheduleInputs, setScheduleInputs] = useState<Record<number, ScheduleInput>>({})
  const [scheduling, setScheduling] = useState<number | null>(null)
  /* Tour en cours de modification (planifié -> édition heure/chauffeur/contrat sans annuler) /
     Tour being edited (scheduled -> edit time/driver/contract without cancelling) */
  const [editingTourId, setEditingTourId] = useState<number | null>(null)
  const [reorderingStopId, setReorderingStopId] = useState<number | null>(null)
  const [recalculating, setRecalculating] = useState(false)
  const [exportingWms, setExportingWms] = useState(false)
  const [costTourId, setCostTourId] = useState<number | null>(null)
  const [showPrintPlan, setShowPrintPlan] = useState(false)
  /* Modale mail de confirmation transporteur / Carrier confirmation email modal */
  const [showConfirmMail, setShowConfirmMail] = useState(false)
  /* Contrats disponibles par tour / Available contracts per tour */
  const [availableContractsMap, setAvailableContractsMap] = useState<Record<number, Contract[]>>({})
  // Raisons (en clair) quand aucun contrat n'est disponible / Reasons when no contract available
  const [contractBlockersMap, setContractBlockersMap] = useState<Record<number, string[]>>({})
  /* Véhicules propres disponibles par tour / Available own vehicles per tour */
  const [availableVehiclesMap, setAvailableVehiclesMap] = useState<Record<number, { vehicles: AvailableVehicle[]; tractors: AvailableVehicle[] }>>({})

  /* Filtre activité / Activity filter */
  const [activityFilter, setActivityFilter] = useState('ALL')
  /* Filtre chauffeur / Driver filter */
  const [driverFilter, setDriverFilter] = useState('ALL')
  /* Filtre base d'origine (ticket #20) : différencier le lieu de départ / Origin base filter */
  const [baseFilter, setBaseFilter] = useState('ALL')
  /* Filtres multi-select / Multi-select filters */
  const [vehicleTypeFilters, setVehicleTypeFilters] = useState<Set<VehicleType>>(new Set())
  const [modeFilters, setModeFilters] = useState<Set<AssignmentMode>>(new Set())
  const [contractFilters, setContractFilters] = useState<Set<number>>(new Set())
  /* Afficher tours validés (masqués par défaut) / Show validated tours (hidden by default) */
  const [showValidated, setShowValidated] = useState(false)
  /* Filtrer sur les tours à planifier (sans heure de départ) / Show only to-be-planned tours */
  const [onlyToPlan, setOnlyToPlan] = useState(false)
  /* Détachement Gantt et liste / Gantt and list detachment */
  const [ganttDetached, setGanttDetached] = useState(false)
  const [listDetached, setListDetached] = useState(false)
  const ganttPopupRef = useRef<Window | null>(null)
  const listPopupRef = useRef<Window | null>(null)
  /* Affichage filtres avancés / Advanced filters visibility */
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)

  /* Tri chauffeur / Driver sort */
  /* Mode de tri de la liste : heure de départ, chauffeur A→Z / Z→A, ou ordre
     (priorité manuelle 1→n). / List sort mode. */
  const [sortMode, setSortMode] = useState<'departure' | 'asc' | 'desc' | 'priority'>('asc')

  /* Expansion boites / Box expansion */
  const [expandedTourIds, setExpandedTourIds] = useState<Set<number>>(new Set())

  /* Split prefs */
  const [prefs, setPrefs] = useState<SchedulerPrefs>(loadPrefs)
  const splitContainerRef = useRef<HTMLDivElement>(null)

  /* Refs mesure hauteurs / Height measurement refs */
  const boxContainerRef = useRef<HTMLDivElement>(null)
  const [measuredRowHeights, setMeasuredRowHeights] = useState<number[]>([])
  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState(0)

  /* Index des distances / Distance index */
  const distanceIndex = useMemo(() => {
    const idx = new Map<string, DistanceEntry>()
    distances.forEach((d) => {
      idx.set(`${d.origin_type}:${d.origin_id}->${d.destination_type}:${d.destination_id}`, d)
    })
    return idx
  }, [distances])

  const getDistance = (fromType: string, fromId: number, toType: string, toId: number): DistanceEntry | undefined => {
    return distanceIndex.get(`${fromType}:${fromId}->${toType}:${toId}`)
      || distanceIndex.get(`${toType}:${toId}->${fromType}:${fromId}`)
  }

  const pdvMap = useMemo(() => new Map(pdvs.map((p) => [p.id, p])), [pdvs])

  /* Charger les tours et la timeline / Load tours and timeline */
  const loadData = useCallback(async () => {
    if (!selectedDate) {
      setTours([])
      setTimeline([])
      return
    }
    try {
      const [toursRes, timelineRes] = await Promise.all([
        api.get<Tour[]>('/tours/', { params: { date: selectedDate } }),
        api.get<GanttTour[]>('/tours/timeline', { params: { date: selectedDate } }),
      ])
      setTours(toursRes.data)
      setTimeline(timelineRes.data)
    } catch {
      setTours([])
      setTimeline([])
    }
  }, [selectedDate])

  useEffect(() => {
    loadData()
  }, [loadData])

  /* Charger contrats disponibles pour chaque tour non planifié / Load available contracts per unscheduled tour */
  const loadContractsForTour = useCallback(async (tour: Tour, deliveryDate?: string) => {
    if (!tour.base_id || !tour.vehicle_type) return
    const checkDate = deliveryDate || tour.delivery_date || selectedDate
    if (!checkDate) return
    try {
      const { data } = await api.get<Contract[]>('/tours/available-contracts', {
        params: {
          date: checkDate,
          base_id: tour.base_id,
          vehicle_type: tour.vehicle_type,
          temperature_type: tour.temperature_type || undefined,
          tour_id: tour.id,
        },
      })
      setAvailableContractsMap((prev) => ({ ...prev, [tour.id]: data }))
      // Si aucun contrat : récupérer la raison pour ne pas laisser l'utilisateur sans explication /
      // If no contract: fetch the reason so the user isn't left without explanation
      if (data.length === 0) {
        try {
          const { data: reasons } = await api.get<string[]>(`/tours/${tour.id}/contract-blockers`, {
            params: {
              date: checkDate, base_id: tour.base_id,
              vehicle_type: tour.vehicle_type,
              temperature_type: tour.temperature_type || undefined,
            },
          })
          setContractBlockersMap((prev) => ({ ...prev, [tour.id]: reasons }))
        } catch { /* ignore */ }
      } else {
        setContractBlockersMap((prev) => ({ ...prev, [tour.id]: [] }))
      }
    } catch {
      setAvailableContractsMap((prev) => ({ ...prev, [tour.id]: [] }))
    }
  }, [selectedDate])

  /* Charger véhicules propres disponibles pour un tour / Load available own vehicles for a tour */
  const loadVehiclesForTour = useCallback(async (tour: Tour, deliveryDate?: string) => {
    if (!tour.base_id || !tour.vehicle_type) return
    const checkDate = deliveryDate || tour.delivery_date || selectedDate
    if (!checkDate) return
    try {
      const { data } = await api.get<AvailableVehicle[]>('/tours/available-vehicles', {
        params: {
          date: checkDate,
          base_id: tour.base_id,
          vehicle_type: tour.vehicle_type,
          temperature_type: tour.temperature_type || undefined,
          tour_id: tour.id,
        },
      })
      setAvailableVehiclesMap((prev) => ({
        ...prev,
        [tour.id]: {
          vehicles: data.filter((v) => !v.is_tractor),
          tractors: data.filter((v) => v.is_tractor),
        },
      }))
    } catch {
      setAvailableVehiclesMap((prev) => ({ ...prev, [tour.id]: { vehicles: [], tractors: [] } }))
    }
  }, [selectedDate])

  /* Calculer la date de livraison par défaut (dispatch_date + 1 jour le plus fréquent) /
     Compute default delivery date (most frequent dispatch_date + 1 day) */
  const computeDefaultDeliveryDate = useCallback((tour: Tour): string => {
    const tourVolumes = allVolumes.filter((v) => v.tour_id === tour.id && v.dispatch_date)
    if (tourVolumes.length === 0) return ''
    const freq = new Map<string, number>()
    tourVolumes.forEach((v) => {
      const d = v.dispatch_date!
      freq.set(d, (freq.get(d) ?? 0) + 1)
    })
    let best = ''
    let bestCount = 0
    freq.forEach((count, d) => { if (count > bestCount) { best = d; bestCount = count } })
    if (!best) return ''
    const dt = new Date(best)
    dt.setDate(dt.getDate() + 1)
    return dt.toISOString().slice(0, 10)
  }, [allVolumes])

  /* Charger contrats pour tous les tours non planifiés / Load contracts for all unscheduled tours */
  useEffect(() => {
    const unscheduled = tours.filter((t) => !t.departure_time && !t.contract_id)
    unscheduled.forEach((tour) => {
      const dd = scheduleInputs[tour.id]?.deliveryDate || computeDefaultDeliveryDate(tour)
      loadContractsForTour(tour, dd)
    })
  }, [tours, loadContractsForTour])

  /* Auto-init inputs pour les tours non-planifiés / Auto-init inputs for unscheduled tours */
  useEffect(() => {
    const unscheduled = tours.filter((t) => !t.departure_time && !t.contract_id)
    setScheduleInputs((prev) => {
      const next = { ...prev }
      for (const tour of unscheduled) {
        if (!next[tour.id]?.deliveryDate) {
          next[tour.id] = {
            ...(next[tour.id] ?? EMPTY_INPUT),
            deliveryDate: computeDefaultDeliveryDate(tour),
          }
        }
      }
      return next
    })
  }, [tours, computeDefaultDeliveryDate])

  /* Séparer tours planifiés et non-planifiés / Split scheduled vs unscheduled */
  const unscheduledTours = useMemo(() => tours.filter((t) => !t.departure_time), [tours])
  const scheduledTours = useMemo(() => tours.filter((t) => t.departure_time), [tours])

  /* Map tour_id → label chauffeur/véhicule (vehicle_code ou contract_code en fallback) */
  const tourVehicleMap = useMemo(() => {
    const m = new Map<number, string>()
    for (const tl of timeline) {
      const label = tl.vehicle_code || tl.contract_code
      if (label) m.set(tl.tour_id, label)
    }
    return m
  }, [timeline])

  /* Liste unique des chauffeurs/véhicules pour le filtre */
  const driverNames = useMemo(() => {
    const names = new Set<string>()
    for (const tl of timeline) {
      const label = tl.vehicle_code || tl.contract_code
      if (label) names.add(label)
    }
    return Array.from(names).sort()
  }, [timeline])

  /* Filtrer par tous les critères cumulés / Filter by all cumulated criteria */
  const filteredTours = useMemo(() => {
    let result = tours
    if (!showValidated) result = result.filter(t => t.status !== 'VALIDATED')
    if (onlyToPlan) result = result.filter(t => !t.departure_time)
    if (activityFilter !== 'ALL') result = result.filter(t => t.temperature_type === activityFilter)
    if (driverFilter !== 'ALL') result = result.filter(t => tourVehicleMap.get(t.id) === driverFilter)
    if (baseFilter !== 'ALL') result = result.filter(t => String(t.base_id) === baseFilter)
    if (vehicleTypeFilters.size > 0) {
      result = result.filter(t => t.vehicle_type && vehicleTypeFilters.has(t.vehicle_type))
    }
    if (modeFilters.size > 0) {
      result = result.filter(t => {
        const mode = getTourMode(t)
        return mode !== null && modeFilters.has(mode)
      })
    }
    if (contractFilters.size > 0) {
      result = result.filter(t => t.contract_id != null && contractFilters.has(t.contract_id))
    }
    return result
  }, [tours, showValidated, onlyToPlan, activityFilter, driverFilter, baseFilter, tourVehicleMap, vehicleTypeFilters, modeFilters, contractFilters])

  /* Bases d'origine présentes dans les tours du jour (ticket #20) / Origin bases present in today's tours */
  const availableBases = useMemo(() => {
    const ids = new Set<number>()
    tours.forEach((t) => { if (t.base_id != null) ids.add(t.base_id) })
    return Array.from(ids)
      .map((id) => bases.find((b) => b.id === id))
      .filter((b): b is BaseLogistics => b != null)
      .sort((a, b) => a.code.localeCompare(b.code))
  }, [tours, bases])

  /* Liste unique triée: planifiés d'abord par heure départ, puis non-planifiés /
     Unified sorted list: scheduled first by departure time, then unscheduled */
  const sortedTours = useMemo(() => {
    // Tri par heure de départ, puis par priorité manuelle (1 d'abord, NULL en dernier)
    const byDeparture = (a: Tour, b: Tour) => {
      const dep = (a.departure_time ? parseTime(a.departure_time) : Infinity) - (b.departure_time ? parseTime(b.departure_time) : Infinity)
      if (dep !== 0) return dep
      return (a.priority ?? Infinity) - (b.priority ?? Infinity)
    }

    /* Tri par ordre : priorité manuelle 1→n (NULL en dernier), départage par
       heure de départ. / Sort by manual order (priority), tie-break by departure. */
    if (sortMode === 'priority') {
      return [...filteredTours].sort((a, b) => {
        const pa = a.priority ?? Infinity
        const pb = b.priority ?? Infinity
        return pa !== pb ? pa - pb : byDeparture(a, b)
      })
    }

    /* Modes chauffeur (asc/desc) → regroupement par véhicule/chauffeur / Driver modes */
    const driverSort = sortMode === 'asc' || sortMode === 'desc' ? sortMode : null
    if (driverSort) {
      /* Grouper par véhicule/chauffeur, trier alpha, tours par départ à l'intérieur */
      const groups = new Map<string, Tour[]>()
      for (const t of filteredTours) {
        const key = tourVehicleMap.get(t.id) || '\uffff' /* sans véhicule en dernier */
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(t)
      }
      const sortedKeys = [...groups.keys()].sort((a, b) => {
        const cmp = a.localeCompare(b, 'fr')
        return driverSort === 'desc' ? -cmp : cmp
      })
      const result: Tour[] = []
      for (const key of sortedKeys) {
        result.push(...groups.get(key)!.sort(byDeparture))
      }
      return result
    }

    const scheduled = filteredTours.filter(t => t.departure_time).sort(byDeparture)
    const unscheduled = filteredTours.filter(t => !t.departure_time)
      .sort((a, b) => a.id - b.id)
    return [...scheduled, ...unscheduled]
  }, [filteredTours, sortMode, tourVehicleMap])

  /* Détecter les tours avec violation de fenêtre de livraison / Detect delivery window violations */
  const deliveryWindowViolations = useMemo(() => {
    const violations = new Map<number, string[]>()
    for (const tour of scheduledTours) {
      if (!tour.stops) continue
      const tourViolations: string[] = []
      for (const stop of tour.stops) {
        if (!stop.arrival_time) continue
        const pdv = pdvMap.get(stop.pdv_id)
        if (!pdv) continue
        if (pdv.delivery_window_start && stop.arrival_time < pdv.delivery_window_start) {
          tourViolations.push(`${pdv.code} ${pdv.name}: ${stop.arrival_time} < ${pdv.delivery_window_start}`)
        }
        if (pdv.delivery_window_end && stop.arrival_time > pdv.delivery_window_end) {
          tourViolations.push(`${pdv.code} ${pdv.name}: ${stop.arrival_time} > ${pdv.delivery_window_end}`)
        }
      }
      if (tourViolations.length > 0) {
        violations.set(tour.id, tourViolations)
      }
    }
    return violations
  }, [scheduledTours, pdvMap])

  /* Estimation retour client-side / Client-side return estimation */
  const estimateReturn = (tour: Tour, departureTime: string): string | null => {
    if (!departureTime || !tour.stops || tour.stops.length === 0) return null
    let currentMin = parseTime(departureTime)
    let prevType = 'BASE'
    let prevId = tour.base_id

    const sortedStops = [...tour.stops].sort((a, b) => a.sequence_order - b.sequence_order)

    for (const stop of sortedStops) {
      const dist = getDistance(prevType, prevId, 'PDV', stop.pdv_id)
      const travelMin = dist?.duration_minutes ?? 0
      currentMin += travelMin

      const pdv = pdvMap.get(stop.pdv_id)
      const dockTime = pdv?.dock_time_minutes ?? DEFAULT_DOCK_TIME
      const unloadPerEqp = pdv?.unload_time_per_eqp_minutes ?? DEFAULT_UNLOAD_PER_EQP
      currentMin += dockTime + stop.eqp_count * unloadPerEqp

      prevType = 'PDV'
      prevId = stop.pdv_id
    }

    /* Retour base / Return to base */
    const lastStop = sortedStops[sortedStops.length - 1]
    const retDist = getDistance('PDV', lastStop.pdv_id, 'BASE', tour.base_id)
    currentMin += retDist?.duration_minutes ?? 0

    return formatTime(currentMin)
  }

  /* Convertir HH:MM en minutes, en gérant le retour le lendemain /
     Convert HH:MM to minutes, handling next-day return */
  const intervalsOverlapDateAware = (
    dateA: string, depA: string, retA: string,
    dateB: string, depB: string, retB: string,
  ): boolean => {
    const toMin = (t: string) => {
      const [h, m] = t.split(':').map(Number)
      return h * 60 + m
    }
    const dayMin = (d: string) => {
      const dt = new Date(`${d}T00:00:00Z`)
      return Math.round(dt.getTime() / 60000)
    }
    const a0 = dayMin(dateA) + toMin(depA)
    let a1 = dayMin(dateA) + toMin(retA)
    if (a1 <= a0) a1 += 24 * 60
    const b0 = dayMin(dateB) + toMin(depB)
    let b1 = dayMin(dateB) + toMin(retB)
    if (b1 <= b0) b1 += 24 * 60
    return a0 < b1 && a1 > b0
  }

  /* Détection chevauchement client-side — compare contract OU vehicle OU tractor /
     Client-side overlap detection — compares contract OR vehicle OR tractor */
  const detectOverlap = (tour: Tour, departureTime: string, contractId: number | null, vehicleId: number | null, tractorId: number | null, deliveryDate?: string): GanttTour | null => {
    const estReturn = estimateReturn(tour, departureTime)
    if (!estReturn) return null
    const tourDate = deliveryDate || tour.delivery_date || selectedDate
    for (const tl of timeline) {
      if (tl.tour_id === tour.id) continue
      if (!tl.departure_time || !tl.return_time) continue
      const sameResource =
        (contractId != null && tl.contract_id === contractId)
        || (vehicleId != null && tl.vehicle_id === vehicleId)
        || (tractorId != null && tl.tractor_id === tractorId)
      if (!sameResource) continue
      const tlDate = tl.delivery_date || tl.tour_date
      if (intervalsOverlapDateAware(tourDate, departureTime, estReturn, tlDate, tl.departure_time, tl.return_time)) {
        return tl
      }
    }
    return null
  }

  /* Détection des chevauchements parmi les tours déjà planifiés /
     Overlap detection among already-scheduled tours */
  const existingOverlaps = useMemo(() => {
    const conflicts = new Map<number, { other: GanttTour; reason: string }>()
    const scheduled = timeline.filter(t => t.departure_time && t.return_time)
    for (let i = 0; i < scheduled.length; i++) {
      const a = scheduled[i]
      for (let j = i + 1; j < scheduled.length; j++) {
        const b = scheduled[j]
        let reason = ''
        if (a.contract_id != null && a.contract_id === b.contract_id) reason = 'contrat'
        else if (a.vehicle_id != null && a.vehicle_id === b.vehicle_id) reason = 'véhicule'
        else if (a.tractor_id != null && a.tractor_id === b.tractor_id) reason = 'tracteur'
        if (!reason) continue
        const aDate = a.delivery_date || a.tour_date
        const bDate = b.delivery_date || b.tour_date
        if (intervalsOverlapDateAware(aDate, a.departure_time!, a.return_time!, bDate, b.departure_time!, b.return_time!)) {
          conflicts.set(a.tour_id, { other: b, reason })
          conflicts.set(b.tour_id, { other: a, reason })
        }
      }
    }
    return conflicts
  }, [timeline])

  /* Mettre à jour la priorité d'un tour planifié (après planification, avant validation) /
     Update priority of a planned tour (after scheduling, before validation) */
  const handlePriorityUpdate = async (tourId: number, value: number | null) => {
    try {
      await api.put(`/tours/${tourId}`, { priority: value })
      await loadData()
    } catch {
      alert('Échec de la mise à jour de la priorité')
    }
  }

  /* Entrer en modification d'un tour planifié (À VALIDER) : pré-remplir le formulaire
     avec les valeurs actuelles + charger les options, sans annuler ni libérer les volumes /
     Edit a planned (to-validate) tour: prefill the form + load options, without cancelling */
  const startEditTour = (tour: Tour) => {
    const mode = getTourMode(tour) ?? 'preste'
    setScheduleInputs((prev) => ({
      ...prev,
      [tour.id]: {
        time: tour.departure_time ?? '',
        deliveryDate: tour.delivery_date ?? '',
        mode,
        contractId: tour.contract_id ?? null,
        vehicleId: tour.vehicle_id ?? null,
        tractorId: tour.tractor_id ?? null,
        driverName: tour.driver_name ?? '',
        priority: tour.priority ?? null,
      },
    }))
    loadContractsForTour(tour, tour.delivery_date ?? undefined)
    loadVehiclesForTour(tour, tour.delivery_date ?? undefined)
    setEditingTourId(tour.id)
    // Déplier le tour pour exposer la liste PDV (avec flèches de permutation) /
    // Expand the tour to reveal the PDV list (with reorder arrows)
    setExpandedTourIds((prev) => new Set(prev).add(tour.id))
  }

  /* Planifier un tour / Schedule a tour */
  const handleSchedule = async (tourId: number, force = false) => {
    const input = scheduleInputs[tourId]
    if (!input?.time) return
    // Validation selon mode / Validate by mode
    if (input.mode === 'preste' && !input.contractId) return
    if (input.mode === 'propre' && !input.tractorId) return
    if (input.mode === 'mixte' && !input.contractId) return
    // Retrouver le code Infolog du chauffeur sélectionné (figé pour l'export WMS) /
    // Resolve the selected driver's Infolog code (captured for the WMS export)
    const matchedDriver = input.driverName
      ? baseDrivers.find((d) => `${d.last_name} ${d.first_name}` === input.driverName)
      : undefined
    setScheduling(tourId)
    try {
      await api.put(`/tours/${tourId}/schedule`, {
        contract_id: input.contractId ?? null,
        vehicle_id: input.vehicleId ?? null,
        tractor_id: input.tractorId ?? null,
        departure_time: input.time,
        delivery_date: input.deliveryDate || null,
        driver_name: input.driverName || null,
        driver_code_infolog: matchedDriver?.code_infolog ?? null,
        priority: input.priority ?? null,
      }, { params: force ? { force: true } : undefined })
      await loadData()
      setEditingTourId(null)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string }; status?: number } }
      const detail = err?.response?.data?.detail
      const status = err?.response?.status
      if (status === 422 && detail?.startsWith('OVER_10H:')) {
        const totalTime = detail.replace('OVER_10H:', '')
        const confirmed = window.confirm(
          t('tourPlanning.over10hWarning', { total: totalTime })
        )
        if (confirmed) {
          setScheduling(null)
          return handleSchedule(tourId, true)
        }
      } else if (status === 422 && detail?.startsWith('DOCK_TAILGATE:')) {
        const violations = detail.replace('DOCK_TAILGATE:', '')
        alert(t('tourPlanning.dockTailgateError') + '\n\n' + violations.split(' | ').map((v: string) => {
          if (v.startsWith('DOCK_NO_TAILGATE:')) return t('tourPlanning.noDockNeedsTailgate', { pdv: v.replace('DOCK_NO_TAILGATE:', '') })
          if (v.startsWith('DOCK_NO_NICHE_FOLDABLE:')) return t('tourPlanning.noDockNicheNoFoldable', { pdv: v.replace('DOCK_NO_NICHE_FOLDABLE:', '') })
          return v
        }).join('\n'))
      } else if (status === 422 && detail?.startsWith('VEHICLE_TYPE:')) {
        const violations = detail.replace('VEHICLE_TYPE:', '')
        alert('Type de véhicule incompatible :\n\n' + violations.split(' | ').join('\n'))
      } else if (status === 422 && detail?.startsWith('DELIVERY_WINDOW:')) {
        const violations = detail.replace('DELIVERY_WINDOW:', '')
        const confirmed = window.confirm(
          t('tourPlanning.deliveryWindowWarning', { violations })
        )
        if (confirmed) {
          setScheduling(null)
          return handleSchedule(tourId, true)
        }
      } else if (status === 422 && detail?.startsWith('CONTRACT_UNAVAILABLE:')) {
        const unavailDate = detail.replace('CONTRACT_UNAVAILABLE:', '')
        alert(`Contrat indisponible le ${unavailDate}`)
      } else if (detail) {
        alert(detail)
      } else {
        console.error('Failed to schedule tour', e)
      }
    } finally {
      setScheduling(null)
    }
  }

  /* Retirer la planification / Unschedule a tour */
  const handleUnschedule = async (tourId: number) => {
    setScheduling(tourId)
    try {
      await api.delete(`/tours/${tourId}/schedule`)
      await loadData()
    } catch (e) {
      console.error('Failed to unschedule tour', e)
    } finally {
      setScheduling(null)
    }
  }

  /* Valider un tour / Validate a tour */
  const handleValidate = async (tourId: number) => {
    setScheduling(tourId)
    try {
      await api.put(`/tours/${tourId}/validate`)
      await loadData()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      alert(detail || 'Erreur validation')
    } finally {
      setScheduling(null)
    }
  }

  /* Annuler un tour (supprimer + libérer volumes) / Cancel a tour (delete + release volumes) */
  const handleCancel = async (tourId: number) => {
    if (!confirm('Annuler ce tour ? Les volumes seront libérés et le tour supprimé.')) return
    setScheduling(tourId)
    try {
      await api.delete(`/tours/${tourId}`)
      await loadData()
    } catch (e: unknown) {
      const resp = (e as { response?: { status?: number; data?: { detail?: string } } })?.response
      if (resp?.status === 409) alert(resp.data?.detail || 'Tour verrouillé (top départ validé)')
      else console.error('Failed to cancel tour', e)
    } finally {
      setScheduling(null)
    }
  }

  /* Remettre en DRAFT / Revert to DRAFT */
  const handleRevertDraft = async (tourId: number) => {
    setScheduling(tourId)
    try {
      await api.put(`/tours/${tourId}/revert-draft`)
      await loadData()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (detail) alert(detail)
      else console.error('Failed to revert tour', e)
    } finally {
      setScheduling(null)
    }
  }

  /* Valider tous les tours DRAFT / Validate all DRAFT tours */
  const [validatingBatch, setValidatingBatch] = useState(false)
  const handleValidateBatch = async () => {
    if (!selectedDate) return
    setValidatingBatch(true)
    try {
      const { data } = await api.post<{ validated: number }>('/tours/validate-batch', null, {
        params: { date: selectedDate },
      })
      await loadData()
      alert(`${data.validated} tour(s) valide(s)`)
    } catch (e) {
      console.error('Failed to validate batch', e)
    } finally {
      setValidatingBatch(false)
    }
  }

  /* Nombre de tours DRAFT planifiés / Count of scheduled DRAFT tours */
  const draftScheduledCount = useMemo(
    () => scheduledTours.filter((t) => t.status === 'DRAFT').length,
    [scheduledTours]
  )

  /* Recalculer les coûts / Recalculate costs */
  const handleRecalculate = async () => {
    if (!selectedDate) return
    setRecalculating(true)
    try {
      const { data } = await api.post<{ total: number; updated: number }>('/tours/recalculate', null, {
        params: { date: selectedDate },
      })
      await loadData()
      alert(t('tourPlanning.recalculateResult', { total: data.total, updated: data.updated }))
    } catch (e) {
      console.error('Failed to recalculate', e)
    } finally {
      setRecalculating(false)
    }
  }

  /* Export WMS Infolog (TMS_vers_wms) — fichier pour la macro d'encodage Infolog /
     WMS Infolog export — file for the Infolog encoding macro */
  const handleExportWms = async () => {
    if (!selectedDate) return
    setExportingWms(true)
    try {
      const res = await api.get('/exports/wms-infolog', {
        params: { date: selectedDate },
        responseType: 'blob',
      })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `TMS_vers_wms_${selectedDate}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Failed to export WMS Infolog', e)
      alert("Échec de l'export Infolog (WMS).")
    } finally {
      setExportingWms(false)
    }
  }

  const updateInput = (
    tourId: number,
    field: 'time' | 'contractId' | 'deliveryDate' | 'mode' | 'vehicleId' | 'tractorId' | 'driverName' | 'priority',
    value: string | number | null
  ) => {
    setScheduleInputs((prev) => {
      const cur: ScheduleInput = prev[tourId] ?? EMPTY_INPUT
      const next: ScheduleInput = { ...cur, [field]: value }
      // Changer de mode : reset champs de l'ancien mode / Switch mode: reset previous mode fields
      if (field === 'mode') {
        if (value === 'preste') { next.vehicleId = null; next.tractorId = null; next.driverName = '' }
        if (value === 'propre') { next.contractId = null; next.vehicleId = null }
        if (value === 'mixte') { next.vehicleId = null; next.tractorId = null }
      }
      // Changer la date de livraison : reset sélections / Change delivery date: reset selections
      if (field === 'deliveryDate') {
        next.contractId = null; next.vehicleId = null; next.tractorId = null
      }
      return { ...prev, [tourId]: next }
    })
    // Recharger les contrats et véhicules selon le contexte / Reload contracts/vehicles as needed
    if (field === 'deliveryDate' && value) {
      const tour = tours.find(t => t.id === tourId)
      if (tour) {
        loadContractsForTour(tour, value as string)
        loadVehiclesForTour(tour, value as string)
      }
    }
    if (field === 'mode' && (value === 'propre' || value === 'mixte')) {
      const tour = tours.find(t => t.id === tourId)
      if (tour) {
        const dd = scheduleInputs[tourId]?.deliveryDate
        loadVehiclesForTour(tour, dd)
      }
    }
  }

  const getVehicleLabel = (tour: Tour): string => {
    const vt = tour.vehicle_type as VehicleType | undefined
    if (vt && VEHICLE_TYPE_DEFAULTS[vt]) return VEHICLE_TYPE_DEFAULTS[vt].label
    return tour.vehicle_type ?? '—'
  }

  /* Liste des stops d'un tour avec badges reprises + dispatch info / Stop list with pickup badges + dispatch info */
  /* Permuter un PDV vers le haut/bas (mode édition) + recalcul serveur /
     Move a PDV stop up/down (edit mode) with server-side recompute */
  const handleReorderStop = async (tour: Tour, stopId: number, dir: 'up' | 'down') => {
    const sorted = [...(tour.stops ?? [])].sort((a, b) => a.sequence_order - b.sequence_order)
    const idx = sorted.findIndex((s) => s.id === stopId)
    const target = dir === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || target < 0 || target >= sorted.length) return
    const next = [...sorted]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setReorderingStopId(stopId)
    try {
      await api.put(`/tours/${tour.id}/reorder-stops`, { stop_order: next.map((s) => s.id) })
      await loadData()
    } catch (e) {
      console.error('Reorder stops failed', e)
      alert('Échec du réordonnancement des PDV')
    } finally {
      setReorderingStopId(null)
    }
  }

  const renderStopList = (tour: Tour) => {
    const sortedStops = [...(tour.stops ?? [])].sort((a, b) => a.sequence_order - b.sequence_order)
    if (sortedStops.length === 0) return null
    const canReorder = editingTourId === tour.id && sortedStops.length > 1
    return (
      <div className="mt-1 mb-2 space-y-0.5">
        {sortedStops.map((stop, idx) => {
          const pdv = pdvMap.get(stop.pdv_id)
          const hasPickup = stop.pickup_cardboard || stop.pickup_containers || stop.pickup_returns || stop.pickup_consignment
          /* Dispatch info des volumes liés au stop / Dispatch info from volumes linked to this stop */
          const stopVolumes = allVolumes.filter((v) => v.tour_id === tour.id && v.pdv_id === stop.pdv_id)
          const dispatchInfo = stopVolumes.find((v) => v.dispatch_date)
          return (
            <div key={stop.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] pl-2" style={{ color: 'var(--text-muted)' }}>
              {canReorder && (
                <span className="flex flex-col shrink-0 -my-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleReorderStop(tour, stop.id, 'up')}
                    disabled={idx === 0 || reorderingStopId != null}
                    className="leading-none text-[9px] px-0.5 disabled:opacity-25 hover:opacity-70"
                    style={{ color: 'var(--color-primary)' }}
                    title="Monter ce PDV"
                  >▲</button>
                  <button
                    onClick={() => handleReorderStop(tour, stop.id, 'down')}
                    disabled={idx === sortedStops.length - 1 || reorderingStopId != null}
                    className="leading-none text-[9px] px-0.5 disabled:opacity-25 hover:opacity-70"
                    style={{ color: 'var(--color-primary)' }}
                    title="Descendre ce PDV"
                  >▼</button>
                </span>
              )}
              <span className="w-4 text-right font-mono shrink-0" style={{ color: 'var(--text-primary)' }}>{idx + 1}</span>
              <span className="font-semibold shrink-0" style={{ color: 'var(--text-primary)' }}>
                {pdv?.code ?? `#${stop.pdv_id}`}
              </span>
              <span className="truncate max-w-[120px]">— {pdv?.name ?? ''}</span>
              {/* Heures arrivée → départ / Arrival → departure times */}
              {stop.arrival_time && (
                <span className="font-mono text-[10px] shrink-0" style={{ color: 'var(--color-primary)' }}>
                  {stop.arrival_time}{stop.departure_time ? ` → ${stop.departure_time}` : ''}
                </span>
              )}
              <span className="font-bold shrink-0" style={{ color: 'var(--text-primary)' }}>
                {stop.eqp_count} EQC
              </span>
              {/* Température par stop (bi-temp / tri-temp) / Temperature per stop */}
              {stopVolumes.length > 0 && (tour.temperature_type === 'BI_TEMP' || tour.temperature_type === 'TRI_TEMP') && (() => {
                const temps = [...new Set(stopVolumes.map((v) => v.temperature_class))] as TemperatureClass[]
                return temps.map((tc) => (
                  <span
                    key={tc}
                    className="px-1 rounded text-[10px] font-bold shrink-0"
                    style={{ backgroundColor: `${TEMPERATURE_COLORS[tc]}20`, color: TEMPERATURE_COLORS[tc] }}
                  >
                    {tc}
                  </span>
                ))
              })()}
              {dispatchInfo && (
                <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {t('tourPlanning.dispatchInfo')} {formatDate(dispatchInfo.dispatch_date)}{dispatchInfo.dispatch_time ? ` ${dispatchInfo.dispatch_time}` : ''}
                </span>
              )}
              {hasPickup && (
                <span className="flex items-center gap-1 ml-auto shrink-0">
                  {stop.pickup_cardboard && (
                    <span className="px-1 rounded text-[10px] font-semibold" style={{ backgroundColor: 'rgba(249,115,22,0.15)', color: 'var(--color-primary)' }}>
                      {t('tourPlanning.pickupCardboard')}
                    </span>
                  )}
                  {stop.pickup_containers && (
                    <span className="px-1 rounded text-[10px] font-semibold" style={{ backgroundColor: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                      {t('tourPlanning.pickupContainers')}
                    </span>
                  )}
                  {stop.pickup_returns && (
                    <span className="px-1 rounded text-[10px] font-semibold" style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: 'var(--color-danger)' }}>
                      {t('tourPlanning.pickupReturns')}
                    </span>
                  )}
                  {stop.pickup_consignment && (
                    <span className="px-1 rounded text-[10px] font-semibold" style={{ backgroundColor: 'rgba(168,85,247,0.15)', color: '#a855f7' }}>
                      Consignes
                    </span>
                  )}
                </span>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  /* Gantt data triée dans le même ordre que sortedTours / Gantt data sorted same as sortedTours */
  const ganttData = useMemo(() => {
    const timelineMap = new Map(timeline.map(t => [t.tour_id, t]))
    return sortedTours.map(tour => {
      const tl = timelineMap.get(tour.id)
      if (tl) return { ...tl, driver_name: tl.driver_name || tourVehicleMap.get(tour.id) || null }
      return {
        tour_id: tour.id,
        code: tour.code,
        contract_id: tour.contract_id ?? null,
        vehicle_id: tour.vehicle_id ?? null,
        tractor_id: tour.tractor_id ?? null,
        vehicle_type: tour.vehicle_type ?? null,
        capacity_eqp: tour.capacity_eqp ?? null,
        contract_code: null,
        vehicle_code: null,
        vehicle_name: null,
        transporter_name: null,
        driver_name: tourVehicleMap.get(tour.id) ?? tour.driver_name ?? null,
        departure_time: tour.departure_time ?? null,
        return_time: tour.return_time ?? null,
        total_eqp: tour.total_eqp ?? null,
        total_km: tour.total_km ?? null,
        total_cost: tour.total_cost ?? null,
        total_duration_minutes: tour.total_duration_minutes ?? null,
        delivery_date: tour.delivery_date ?? null,
        tour_date: selectedDate,
        status: tour.status ?? 'DRAFT',
        stops: tour.stops?.map(s => ({
          id: s.id,
          pdv_id: s.pdv_id,
          pdv_code: pdvMap.get(s.pdv_id)?.code,
          sequence_order: s.sequence_order,
          eqp_count: s.eqp_count,
          arrival_time: s.arrival_time ?? null,
          departure_time: s.departure_time ?? null,
        })) ?? [],
      }
    })
  }, [sortedTours, timeline, selectedDate, pdvMap, tourVehicleMap])

  /* Redimensionnement split par pixels / Split resize in pixels */
  const handleSplitResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = splitContainerRef.current
    if (!container) return

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const px = Math.max(320, Math.min(rect.width * 0.6, ev.clientX - rect.left))
      setPrefs((prev) => {
        const next = { ...prev, leftWidth: Math.round(px) }
        savePrefs(next)
        return next
      })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  /* Mesurer les hauteurs de chaque boite / Measure each box height for Gantt alignment */
  useLayoutEffect(() => {
    const container = boxContainerRef.current
    if (!container) return
    const boxes = container.querySelectorAll<HTMLElement>('[data-tour-id]')
    const heights: number[] = []
    boxes.forEach(box => heights.push(box.getBoundingClientRect().height))
    setMeasuredRowHeights(heights)
    /* Mesurer header (espace avant la première boite) / Measure header offset */
    const headerEl = container.querySelector<HTMLElement>('[data-gantt-header]')
    setMeasuredHeaderHeight(headerEl ? headerEl.getBoundingClientRect().height : 0)
  }, [sortedTours, expandedTourIds, scheduleInputs])

  /* Scroll-to-view quand highlight depuis Gantt / Scroll into view on Gantt click */
  useEffect(() => {
    if (highlightedTourId == null) return
    const el = boxContainerRef.current?.querySelector<HTMLElement>(`[data-tour-id="${highlightedTourId}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [highlightedTourId])

  /* Inline PDV summary for collapsed box */
  const pdvSummary = (tour: Tour): string => {
    const stops = [...(tour.stops ?? [])].sort((a, b) => a.sequence_order - b.sequence_order)
    return stops.map(s => {
      const pdv = pdvMap.get(s.pdv_id)
      return `${pdv?.code ?? `#${s.pdv_id}`}(${s.eqp_count})`
    }).join(' \u25c6 ')
  }

  /* Toggle helper pour multi-select / Multi-select toggle helper */
  const toggleInSet = useCallback(<T,>(set: Set<T>, value: T, setter: (s: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }, [])

  /* Liste de contrats utilisés par au moins un tour (pour le filtre) /
     List of contracts used by at least one tour (for the filter) */
  const contractsInUse = useMemo(() => {
    const ids = new Set<number>()
    tours.forEach(t => { if (t.contract_id != null) ids.add(t.contract_id) })
    return allContracts
      .filter(c => ids.has(c.id))
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
  }, [tours, allContracts])

  /* Transporteurs (carriers) ayant des tournées planifiées ce jour — pour le mail
     de confirmation / Carriers with scheduled tours this day — for the confirmation mail */
  const transportersForDate = useMemo<ConfirmTransporter[]>(() => {
    const m = new Map<number, ConfirmTransporter>()
    for (const tour of scheduledTours) {
      if (!tour.contract_id) continue
      const contract = contractMap.get(tour.contract_id)
      const carrier = contract?.carrier
      if (!carrier) continue
      const cur = m.get(carrier.id) ?? { carrierId: carrier.id, name: carrier.name, email: carrier.email, tourCount: 0 }
      cur.tourCount += 1
      m.set(carrier.id, cur)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  }, [scheduledTours, contractMap])

  /* Ouvrir le Gantt détaché / Open detached Gantt */
  const openDetachedGantt = useCallback(() => {
    if (listDetached) {
      /* Mutuellement exclusif: re-attacher la liste avant / Mutually exclusive: re-attach list first */
      listPopupRef.current?.close()
      setListDetached(false)
    }
    const w = screen.width
    const h = screen.height
    const popup = window.open(
      `/gantt-detached?date=${selectedDate}&theme=${theme}&regionId=${selectedRegionId ?? ''}`,
      'chaos-route-gantt',
      `width=${Math.round(w * 0.7)},height=${Math.round(h * 0.5)},left=0,top=${Math.round(h * 0.5)},menubar=no,toolbar=no,location=no,status=no`,
    )
    if (popup) {
      ganttPopupRef.current = popup
      setGanttDetached(true)
    }
  }, [selectedDate, theme, selectedRegionId, listDetached])

  /* Ouvrir la liste détachée / Open detached list */
  const openDetachedList = useCallback(() => {
    if (ganttDetached) {
      ganttPopupRef.current?.close()
      setGanttDetached(false)
    }
    const w = screen.width
    const h = screen.height
    const popup = window.open(
      `/tour-list-detached?date=${selectedDate}&theme=${theme}&regionId=${selectedRegionId ?? ''}`,
      'chaos-route-tour-list',
      `width=${Math.round(w * 0.55)},height=${Math.round(h * 0.85)},left=0,top=20,menubar=no,toolbar=no,location=no,status=no`,
    )
    if (popup) {
      listPopupRef.current = popup
      setListDetached(true)
    }
  }, [selectedDate, theme, selectedRegionId, ganttDetached])

  /* Surveiller la fermeture des popups / Watch popup closure */
  useEffect(() => {
    if (!ganttDetached && !listDetached) return
    const id = setInterval(() => {
      if (ganttDetached && ganttPopupRef.current?.closed) {
        setGanttDetached(false)
        ganttPopupRef.current = null
      }
      if (listDetached && listPopupRef.current?.closed) {
        setListDetached(false)
        listPopupRef.current = null
      }
    }, 500)
    return () => clearInterval(id)
  }, [ganttDetached, listDetached])

  /* Visibilité des panneaux (embeddedMode force les états) /
     Panel visibility (embeddedMode forces states) */
  const showList = embeddedMode !== 'gantt-only' && !listDetached
  const showGantt = embeddedMode !== 'list-only' && !ganttDetached
  const canDetach = !embeddedMode

  return (
    <div className="space-y-4">
      {/* Barre supérieure: date + filtre activité / Top bar: date + activity filter */}
      <div
        className="rounded-xl border px-4 py-3"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
      >
       {/* Ligne 1 — filtres (gauche, repliables) + actions (droite, ancrées) /
           Row 1 — filters (left, wrap) + actions (right, anchored) */}
       <div className="flex items-end gap-4">
        <div className="flex flex-1 flex-wrap items-end gap-x-4 gap-y-2 min-w-0">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Date de répartition
          </label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onDateChange(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
        </div>

        {/* Filtre activité / Activity filter */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Activité
          </label>
          <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)' }}>
            {ACTIVITY_FILTERS.map((f) => (
              <button
                key={f.key}
                className="px-3 py-2 text-xs font-medium transition-all"
                style={{
                  backgroundColor: activityFilter === f.key ? 'var(--color-primary)' : 'var(--bg-primary)',
                  color: activityFilter === f.key ? '#fff' : 'var(--text-secondary)',
                }}
                onClick={() => setActivityFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filtre chauffeur / Driver filter */}
        {driverNames.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Chauffeur
            </label>
            <select
              className="px-2 py-2 text-xs rounded-lg border"
              style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
            >
              <option value="ALL">Tous</option>
              {driverNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Filtre base d'origine (ticket #20) / Origin base filter */}
        {availableBases.length > 1 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Base d'origine
            </label>
            <select
              className="px-2 py-2 text-xs rounded-lg border"
              style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              value={baseFilter}
              onChange={(e) => setBaseFilter(e.target.value)}
            >
              <option value="ALL">Toutes</option>
              {availableBases.map((b) => (
                <option key={b.id} value={String(b.id)}>{b.code} — {b.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Tri de la liste (explicite, compact) / List sort (explicit, compact) */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Trier par</label>
          <select
            className="px-2 py-2 text-xs rounded-lg border"
            style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as 'departure' | 'asc' | 'desc' | 'priority')}
          >
            <option value="departure">Heure de départ</option>
            <option value="asc">Chauffeur A→Z</option>
            <option value="desc">Chauffeur Z→A</option>
            <option value="priority">Ordre (priorité)</option>
          </select>
        </div>

        {/* Bouton Filtres avancés / Advanced filters button */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            &nbsp;
          </label>
          <button
            className="px-3 py-2 text-xs rounded-lg border transition-all"
            style={{
              borderColor: showAdvancedFilters ? 'var(--color-primary)' : 'var(--border-color)',
              backgroundColor: showAdvancedFilters ? 'rgba(249,115,22,0.1)' : 'var(--bg-primary)',
              color: showAdvancedFilters ? 'var(--color-primary)' : 'var(--text-secondary)',
            }}
            onClick={() => setShowAdvancedFilters(prev => !prev)}
            title="Filtres avancés"
          >
            {showAdvancedFilters ? '▾ Filtres avancés' : '▸ Filtres avancés'}
            {(vehicleTypeFilters.size + modeFilters.size + contractFilters.size + (showValidated ? 1 : 0)) > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}>
                {vehicleTypeFilters.size + modeFilters.size + contractFilters.size + (showValidated ? 1 : 0)}
              </span>
            )}
          </button>
        </div>

        </div>{/* fin zone filtres / end filters zone */}

        {/* Zone actions : ancrée à droite, ne passe jamais à la ligne / Actions zone */}
        <div className="shrink-0 flex items-center gap-2.5">
          <div className="flex items-baseline gap-1.5 text-xs" title={t('tourPlanning.unscheduledTours')}>
            <span style={{ color: 'var(--text-muted)' }}>À planifier</span>
            <span className="text-base font-bold" style={{ color: 'var(--color-warning)' }}>{unscheduledTours.length}</span>
          </div>
          <span style={{ color: 'var(--border-color)' }}>·</span>
          <div className="flex items-baseline gap-1.5 text-xs" title={t('tourPlanning.scheduledTours')}>
            <span style={{ color: 'var(--text-muted)' }}>Planifiés</span>
            <span className="text-base font-bold" style={{ color: 'var(--color-success)' }}>{scheduledTours.length}</span>
          </div>
          {scheduledTours.length > 0 && (
            <>
              {draftScheduledCount > 0 && (
                <button
                  onClick={handleValidateBatch}
                  disabled={validatingBatch}
                  className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80 disabled:opacity-40"
                  style={{ borderColor: 'var(--color-success)', color: 'var(--color-success)' }}
                  title={`Valider tous les tours planifiés (${draftScheduledCount})`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                  {validatingBatch ? '...' : `Valider (${draftScheduledCount})`}
                </button>
              )}
              <button
                onClick={handleRecalculate}
                disabled={recalculating}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg border transition-all hover:opacity-80 disabled:opacity-40"
                style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
                title={t('tourPlanning.recalculateCosts')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              </button>
              <button
                onClick={() => setShowPrintPlan(true)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
                title={t('tourPlanning.printPlan.title')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              </button>
              <button
                onClick={handleExportWms}
                disabled={exportingWms}
                className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80 disabled:opacity-40"
                style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
                title="Export Infolog (WMS) — fichier Excel pour la macro d'encodage"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                {exportingWms ? '...' : 'WMS'}
              </button>
              {transportersForDate.length > 0 && (
                <button
                  onClick={() => setShowConfirmMail(true)}
                  className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                  style={{ borderColor: '#0ea5e9', color: '#0ea5e9' }}
                  title="Mail de confirmation des tournées attribuées, transporteur par transporteur"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>
                  Confirmation Mail
                </button>
              )}
            </>
          )}
        </div>
       </div>{/* fin Ligne 1 (filtres + actions) / end Row 1 */}

        {/* Ligne 2 — Filtres avancés (collapsible) / Line 2 — Advanced filters (collapsible) */}
        {showAdvancedFilters && (
          <div className="w-full mt-3 pt-3 border-t flex flex-wrap items-start gap-x-6 gap-y-3"
            style={{ borderColor: 'var(--border-color)' }}>

            {/* Type véhicule — grille 2 colonnes, cases égales */}
            <FilterGroup label="Type véhicule">
              <div className="grid grid-cols-2 gap-1" style={{ width: '184px' }}>
                {VEHICLE_TYPE_OPTIONS.map(vt => {
                  const active = vehicleTypeFilters.has(vt)
                  return (
                    <button
                      key={vt}
                      className={CHIP}
                      title={vt}
                      style={{
                        borderColor: active ? 'var(--color-primary)' : 'var(--border-color)',
                        backgroundColor: active ? 'var(--color-primary)' : 'var(--bg-primary)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                      }}
                      onClick={() => toggleInSet(vehicleTypeFilters, vt, setVehicleTypeFilters)}
                    >
                      {VEHICLE_TYPE_SHORT[vt] ?? vt}
                    </button>
                  )
                })}
              </div>
            </FilterGroup>

            {/* Type (presté/propre/mixte) — une colonne */}
            <FilterGroup label="Type">
              <div className="grid grid-cols-1 gap-1" style={{ width: '92px' }}>
                {MODE_OPTIONS.map(({ key, label }) => {
                  const active = modeFilters.has(key)
                  return (
                    <button
                      key={key}
                      className={CHIP}
                      style={{
                        borderColor: active ? 'var(--color-primary)' : 'var(--border-color)',
                        backgroundColor: active ? 'var(--color-primary)' : 'var(--bg-primary)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                      }}
                      onClick={() => toggleInSet(modeFilters, key, setModeFilters)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </FilterGroup>

            {/* Contrats — grille 5 colonnes larges, cases égales, troncature + tooltip */}
            {contractsInUse.length > 0 && (
              <FilterGroup label={`Contrats (${contractFilters.size}/${contractsInUse.length})`}>
                <div
                  className="grid gap-1 overflow-y-auto pr-1"
                  style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', width: '640px', maxHeight: '124px' }}
                >
                  {contractsInUse.map(c => {
                    const active = contractFilters.has(c.id)
                    return (
                      <button
                        key={c.id}
                        className="h-7 w-full px-2 text-[11px] font-medium rounded border transition-all truncate text-center"
                        style={{
                          lineHeight: '1.7rem',
                          borderColor: active ? 'var(--color-primary)' : 'var(--border-color)',
                          backgroundColor: active ? 'var(--color-primary)' : 'var(--bg-primary)',
                          color: active ? '#fff' : 'var(--text-secondary)',
                        }}
                        onClick={() => toggleInSet(contractFilters, c.id, setContractFilters)}
                        title={`${c.code} — ${c.transporter_name}`}
                      >
                        {c.code}
                      </button>
                    )
                  })}
                </div>
              </FilterGroup>
            )}

            {/* Statut — une colonne (2 toggles empilés) */}
            <FilterGroup label="Statut">
              <div className="grid grid-cols-1 gap-1" style={{ width: '124px' }}>
                <button
                  className={CHIP}
                  style={{
                    borderColor: showValidated ? 'var(--color-success)' : 'var(--border-color)',
                    backgroundColor: showValidated ? 'rgba(34,197,94,0.12)' : 'var(--bg-primary)',
                    color: showValidated ? 'var(--color-success)' : 'var(--text-secondary)',
                  }}
                  onClick={() => setShowValidated(prev => !prev)}
                  title="Affiche aussi les tours déjà validés"
                >
                  {showValidated ? '☑ Validés affichés' : '☐ Validés masqués'}
                </button>
                <button
                  className={CHIP}
                  style={{
                    borderColor: onlyToPlan ? 'var(--color-primary)' : 'var(--border-color)',
                    backgroundColor: onlyToPlan ? 'rgba(249,115,22,0.12)' : 'var(--bg-primary)',
                    color: onlyToPlan ? 'var(--color-primary)' : 'var(--text-secondary)',
                  }}
                  onClick={() => setOnlyToPlan(prev => !prev)}
                  title="N'affiche que les tours à planifier (sans heure de départ)"
                >
                  {onlyToPlan ? '☑ À planifier' : '☐ À planifier'}
                </button>
              </div>
            </FilterGroup>

            {/* Affichage — colonnes liste + détacher superposés */}
            <FilterGroup label="Affichage">
              <div className="grid grid-cols-1 gap-1" style={{ width: '150px' }}>
                {/* Colonnes liste */}
                <div className="flex rounded border overflow-hidden h-7" style={{ borderColor: 'var(--border-color)' }}>
                  {([1, 2, 3] as const).map(n => (
                    <button
                      key={n}
                      className="flex-1 text-[11px] font-medium transition-all flex items-center justify-center"
                      style={{
                        backgroundColor: prefs.listColumns === n ? 'var(--color-primary)' : 'var(--bg-primary)',
                        color: prefs.listColumns === n ? '#fff' : 'var(--text-secondary)',
                      }}
                      onClick={() => setPrefs(p => { const next = { ...p, listColumns: n }; savePrefs(next); return next })}
                      title={`Liste sur ${n} colonne(s)`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                {/* Détacher Gantt / Liste (caché en mode embarqué) */}
                {canDetach && (
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      className={CHIP}
                      style={{
                        borderColor: ganttDetached ? 'var(--color-primary)' : 'var(--border-color)',
                        backgroundColor: ganttDetached ? 'rgba(249,115,22,0.12)' : 'var(--bg-primary)',
                        color: ganttDetached ? 'var(--color-primary)' : 'var(--text-secondary)',
                      }}
                      onClick={() => ganttDetached ? (ganttPopupRef.current?.close(), setGanttDetached(false)) : openDetachedGantt()}
                      title="Détacher la timeline en fenêtre séparée"
                    >
                      {ganttDetached ? '⊟ Gantt' : '⊞ Gantt'}
                    </button>
                    <button
                      className={CHIP}
                      style={{
                        borderColor: listDetached ? 'var(--color-primary)' : 'var(--border-color)',
                        backgroundColor: listDetached ? 'rgba(249,115,22,0.12)' : 'var(--bg-primary)',
                        color: listDetached ? 'var(--color-primary)' : 'var(--text-secondary)',
                      }}
                      onClick={() => listDetached ? (listPopupRef.current?.close(), setListDetached(false)) : openDetachedList()}
                      title="Détacher la liste des tours en fenêtre séparée"
                    >
                      {listDetached ? '⊟ Liste' : '⊞ Liste'}
                    </button>
                  </div>
                )}
              </div>
            </FilterGroup>

            {/* Réinitialiser */}
            {(vehicleTypeFilters.size + modeFilters.size + contractFilters.size > 0 || showValidated || onlyToPlan) && (
              <FilterGroup label="Actions">
                <button
                  className="h-7 px-3 text-[11px] font-medium rounded border transition-all hover:opacity-80 whitespace-nowrap"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                  onClick={() => {
                    setVehicleTypeFilters(new Set())
                    setModeFilters(new Set())
                    setContractFilters(new Set())
                    setShowValidated(false)
                    setOnlyToPlan(false)
                  }}
                >
                  ↺ Réinitialiser
                </button>
              </FilterGroup>
            )}
          </div>
        )}
      </div>

      {/* Layout split redimensionnable / Resizable split layout */}
      <div ref={splitContainerRef} className="flex" style={{ alignItems: 'flex-start', minHeight: 'calc(100vh - 280px)' }}>
        {/* Panneau gauche — Boites collapsibles / Left panel — Collapsible boxes */}
        {showList && (
        <div
          className="overflow-y-auto flex-shrink-0"
          style={{
            width: !showGantt ? '100%' : `${prefs.leftWidth}px`,
            maxHeight: 'calc(100vh - 300px)',
          }}
        >
          <div
            ref={boxContainerRef}
            style={prefs.listColumns > 1 ? {
              display: 'grid',
              gridTemplateColumns: `repeat(${prefs.listColumns}, minmax(0, 1fr))`,
              gap: '4px',
              alignItems: 'start',
            } : undefined}
          >
            {/* Header invisible pour alignement Gantt / Invisible header for Gantt alignment */}
            {prefs.listColumns === 1 && <div data-gantt-header style={{ height: 0, gridColumn: '1 / -1' }} />}

            {sortedTours.length === 0 ? (
              <div className="text-center py-12" style={{ gridColumn: '1 / -1' }}>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('tourPlanning.noToursToday')}
                </p>
              </div>
            ) : (
              sortedTours.map((tour) => {
                const isScheduled = !!tour.departure_time
                const isExpanded = expandedTourIds.has(tour.id)
                const isHighlighted = highlightedTourId === tour.id
                const windowViolations = deliveryWindowViolations.get(tour.id)
                const tourContract = tour.contract_id ? contractMap.get(tour.contract_id) : null

                /* Inputs pour les non-planifiés / Inputs for unscheduled */
                const input: ScheduleInput = scheduleInputs[tour.id] ?? EMPTY_INPUT
                const allContracts = availableContractsMap[tour.id] ?? []
                /* Remorques internes disponibles (vehicles non-tracteurs) /
                   Internal trailers available (non-tractor vehicles) */
                const ownTrailers = availableVehiclesMap[tour.id]?.vehicles ?? []
                /* Filtrer selon le mode : preste exige tracteur+remorque fournis,
                   mixte exige tracteur fourni sans remorque (on prete la notre).
                   NULL (legacy) est laisse passer pour compat. /
                   Filter by mode: preste needs tractor+trailer provided,
                   mixte needs tractor without trailer (we lend ours).
                   NULL (legacy) passes through for compat. */
                const contracts = input.mode === 'preste'
                  ? allContracts.filter(c =>
                      (c.provides_tractor == null || c.provides_tractor === true)
                      && (c.provides_trailer == null || c.provides_trailer === true))
                  : input.mode === 'mixte'
                    ? allContracts.filter(c =>
                        (c.provides_tractor == null || c.provides_tractor === true)
                        && (c.provides_trailer == null || c.provides_trailer === false))
                    : allContracts
                const ownTractors = availableVehiclesMap[tour.id]?.tractors ?? []
                const selectedContract = contracts.find((c) => c.id === input.contractId)
                /* Aligne avec handleSchedule : propre exige un tracteur,
                   mixte exige un contrat (le tracteur reste optionnel) /
                   Match handleSchedule : own mode requires a tractor,
                   mixed mode only requires a contract */
                const canSchedule = input.time && (
                  (input.mode === 'preste' && !!input.contractId) ||
                  (input.mode === 'propre' && !!input.tractorId) ||
                  (input.mode === 'mixte' && !!input.contractId)
                )
                const estReturn = !isScheduled && input.time && canSchedule ? estimateReturn(tour, input.time) : null
                const overlap = !isScheduled && input.time && (input.contractId || input.vehicleId || input.tractorId)
                  ? detectOverlap(tour, input.time, input.contractId, input.vehicleId, input.tractorId, input.deliveryDate)
                  : null
                const existingConflict = isScheduled ? existingOverlaps.get(tour.id) : null

                return (
                  <div
                    key={tour.id}
                    data-tour-id={tour.id}
                    className="rounded-lg border mb-1 transition-all"
                    style={{
                      backgroundColor: existingConflict
                        ? 'rgba(239,68,68,0.1)'
                        : windowViolations
                          ? 'rgba(239,68,68,0.05)'
                          : isHighlighted
                            ? 'rgba(249,115,22,0.05)'
                            : 'var(--bg-secondary)',
                      borderColor: existingConflict
                        ? 'var(--color-danger)'
                        : windowViolations
                          ? 'var(--color-danger)'
                          : isHighlighted
                            ? 'var(--color-primary)'
                            : 'var(--border-color)',
                    }}
                    onClick={() => setHighlightedTourId(tour.id)}
                  >
                    {/* === Ligne 1 — Résumé compact / Line 1 — Compact summary === */}
                    <div className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        {/* Flèche expand */}
                        <button
                          className="text-xs shrink-0 w-4 text-center"
                          style={{ color: 'var(--text-muted)' }}
                          onClick={(e) => { e.stopPropagation(); setExpandedTourIds(prev => { const next = new Set(prev); if (isExpanded) next.delete(tour.id); else next.add(tour.id); return next }) }}
                        >
                          {isExpanded ? '▾' : '▸'}
                        </button>

                        {/* Code tour */}
                        <span className="text-[11px] shrink-0" style={{ color: '#000000' }}>
                          {tour.code}
                        </span>
                        {tour.tour_type && tour.tour_type !== 'LIVRAISON' && (
                          <span className="text-[9px] font-bold px-1 py-0.5 rounded shrink-0" title={tour.destination ?? ''} style={{ backgroundColor: '#6366f122', color: '#6366f1' }}>
                            {TOUR_TYPE_LABELS[tour.tour_type]}
                          </span>
                        )}

                        {/* Badge conflit chevauchement / Overlap conflict badge */}
                        {existingConflict && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                            style={{ backgroundColor: 'rgba(239,68,68,0.15)', color: 'var(--color-danger)' }}
                            title={`Chevauchement ${existingConflict.reason} avec ${existingConflict.other.code} (${existingConflict.other.departure_time}-${existingConflict.other.return_time})`}
                          >
                            ⚠ Conflit {existingConflict.reason}
                          </span>
                        )}

                        {/* Badge reprise / Pickup tour badge */}
                        {tour.is_pickup_tour && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                            style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}
                          >
                            Reprise
                          </span>
                        )}

                        {/* Badge véhicule (type) — largeur fixe pour alignement uniforme */}
                        <span
                          className="text-[10px] font-bold px-1 py-0.5 rounded shrink-0 truncate text-center"
                          style={{ width: '104px', backgroundColor: 'rgba(249,115,22,0.15)', color: 'var(--color-primary)' }}
                          title={`${getVehicleLabel(tour)}(${tour.capacity_eqp ?? 0})`}
                        >
                          {getVehicleLabel(tour)}({tour.capacity_eqp ?? 0})
                        </span>

                        {/* Badge activité / Activity badge */}
                        {tour.temperature_type && (
                          <span
                            className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                            style={{
                              backgroundColor: tour.temperature_type === 'GEL' ? 'rgba(30,64,175,0.15)'
                                : tour.temperature_type === 'FRAIS' ? 'rgba(59,130,246,0.15)'
                                : 'rgba(249,115,22,0.15)',
                              color: tour.temperature_type === 'GEL' ? '#1e40af'
                                : tour.temperature_type === 'FRAIS' ? '#3b82f6'
                                : 'var(--color-primary)',
                            }}
                          >
                            {TEMPERATURE_TYPE_LABELS[tour.temperature_type as TemperatureType] ?? tour.temperature_type}
                          </span>
                        )}

                        {/* Total EQC + km */}
                        <span className="ml-auto text-xs font-bold shrink-0" style={{ color: 'var(--text-primary)' }}>
                          = {tour.total_eqp ?? 0} EQC
                        </span>
                        <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {tour.total_km ?? 0} km
                        </span>

                        {/* Badge statut pour planifiés / Status badge for scheduled */}
                        {isScheduled && (
                          <span
                            className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase shrink-0"
                            style={{
                              backgroundColor: tour.status === 'VALIDATED' ? 'rgba(34,197,94,0.15)' : 'rgba(249,115,22,0.15)',
                              color: tour.status === 'VALIDATED' ? 'var(--color-success)' : 'var(--color-warning)',
                            }}
                          >
                            {tour.status === 'VALIDATED' ? 'Valide' : 'Brouillon'}
                          </span>
                        )}

                        {/* Indicateur violation fenêtre / Delivery window violation dot */}
                        {windowViolations && (
                          <span
                            className="shrink-0 w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: 'var(--color-danger)' }}
                            title={windowViolations.join(' | ')}
                          />
                        )}
                      </div>

                      {/* Ligne 2 — Liste des PDV (tronquée 1 ligne ; détail complet via dépli ▸) /
                          PDV list (truncated to 1 line; full detail via expand) */}
                      <div className="text-sm font-bold mt-0.5 pl-6 truncate" style={{ color: '#000000' }} title={pdvSummary(tour) || tour.destination || ''}>
                        {pdvSummary(tour) || tour.destination || ''}
                      </div>
                      {/* Commentaire du tour (mouvements, transferts…) / Tour comment */}
                      {tour.remarks && (
                        <div className="text-[11px] italic pl-6 truncate" style={{ color: 'var(--text-muted)' }} title={tour.remarks}>
                          💬 {tour.remarks}
                        </div>
                      )}
                    </div>

                    {/* === Ligne 2 — Actions / Line 2 — Actions (alignées en bas ; wrap en dernier recours) === */}
                    <div className="flex flex-wrap items-end gap-1.5 px-3 pb-1.5">
                      {(!isScheduled || editingTourId === tour.id) ? (
                        /* --- Non planifié OU en modification : sélecteurs + enregistrer --- */
                        <>
                          {/* Date livraison */}
                          <input
                            type="date"
                            value={input.deliveryDate}
                            onChange={(e) => updateInput(tour.id, 'deliveryDate', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border px-1.5 py-1 text-[11px] w-[120px] shrink-0"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                          />

                          {/* Toggle mode : Presté / Propre / Mixte */}
                          <div className="flex rounded border overflow-hidden text-[10px] shrink-0" style={{ borderColor: 'var(--border-color)' }}>
                            {(['preste', 'propre', 'mixte'] as AssignmentMode[]).map((m) => (
                              <button
                                key={m}
                                className="px-2 py-1 transition-all"
                                style={{
                                  backgroundColor: input.mode === m ? 'var(--color-primary)' : 'var(--bg-primary)',
                                  color: input.mode === m ? '#fff' : 'var(--text-secondary)',
                                }}
                                onClick={(e) => { e.stopPropagation(); updateInput(tour.id, 'mode', m) }}
                              >
                                {m === 'preste' ? 'Presté' : m === 'propre' ? 'Propre' : 'Mixte'}
                              </button>
                            ))}
                          </div>

                          {/* Raison quand aucun contrat disponible (presté/mixte) /
                              Reason when no contract available */}
                          {(input.mode === 'preste' || input.mode === 'mixte') && contracts.length === 0 && (
                            <div className="text-[10px] leading-tight max-w-[280px]" style={{ color: 'var(--color-danger)' }}>
                              {(availableContractsMap[tour.id]?.length ?? 0) === 0
                                ? ((contractBlockersMap[tour.id]?.length ?? 0) > 0
                                    ? <>Aucun contrat : {contractBlockersMap[tour.id].join(' ; ')}</>
                                    : <>Aucun contrat compatible (type véhicule / température / disponibilité).</>)
                                : <>Aucun contrat ne fournit {input.mode === 'preste' ? 'tracteur + remorque' : 'le tracteur'} pour ce mode.</>}
                            </div>
                          )}

                          {/* Sélecteurs selon mode / Mode-specific selectors */}

                          {/* PRESTÉ : contrat (tracteur + remorque presté) */}
                          {input.mode === 'preste' && (
                            <select
                              value={input.contractId ?? ''}
                              onChange={(e) => updateInput(tour.id, 'contractId', e.target.value ? Number(e.target.value) : null)}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded border px-1.5 py-1 text-[11px] min-w-0"
                              style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', maxWidth: '160px' }}
                            >
                              <option value="">{t('tourPlanning.selectContract')}</option>
                              {contracts.map((c) => (
                                <option key={c.id} value={c.id}>{c.code} — {c.transporter_name}</option>
                              ))}
                            </select>
                          )}

                          {/* PROPRE : tracteur propre + remorque propre + chauffeur */}
                          {input.mode === 'propre' && (
                            <>
                              <select
                                value={input.tractorId ?? ''}
                                onChange={(e) => updateInput(tour.id, 'tractorId', e.target.value ? Number(e.target.value) : null)}
                                onClick={(e) => e.stopPropagation()}
                                className="rounded border px-1.5 py-1 text-[11px] min-w-0"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', maxWidth: '140px' }}
                              >
                                <option value="">Tracteur</option>
                                {ownTractors.map((v) => (
                                  <option key={v.id} value={v.id}>{v.label}</option>
                                ))}
                              </select>
                              <select
                                value={input.vehicleId ?? ''}
                                onChange={(e) => updateInput(tour.id, 'vehicleId', e.target.value ? Number(e.target.value) : null)}
                                onClick={(e) => e.stopPropagation()}
                                disabled={ownTrailers.length === 0}
                                className="rounded border px-1.5 py-1 text-[11px] min-w-0 disabled:opacity-50"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', maxWidth: '140px' }}
                                title={ownTrailers.length === 0 ? 'Aucune remorque interne disponible' : 'Remorque interne'}
                              >
                                <option value="">{ownTrailers.length === 0 ? 'Pas de remorque' : 'Remorque'}</option>
                                {ownTrailers.map((v) => (
                                  <option key={v.id} value={v.id}>{v.label}</option>
                                ))}
                              </select>
                              <select
                                value={input.driverName}
                                onChange={(e) => updateInput(tour.id, 'driverName', e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                className="rounded border px-1.5 py-1 text-[11px] min-w-0"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', maxWidth: '140px' }}
                              >
                                <option value="">Chauffeur</option>
                                {baseDrivers.map((d) => (
                                  <option key={d.id} value={`${d.last_name} ${d.first_name}`}>{d.last_name} {d.first_name}</option>
                                ))}
                              </select>
                            </>
                          )}

                          {/* MIXTE : contrat (tracteur presté) + remorque propre fournie par nous */}
                          {input.mode === 'mixte' && (
                            <>
                              <select
                                value={input.contractId ?? ''}
                                onChange={(e) => updateInput(tour.id, 'contractId', e.target.value ? Number(e.target.value) : null)}
                                onClick={(e) => e.stopPropagation()}
                                className="rounded border px-1.5 py-1 text-[11px] min-w-0"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', maxWidth: '160px' }}
                              >
                                <option value="">Tracteur presté</option>
                                {contracts.map((c) => (
                                  <option key={c.id} value={c.id}>{c.code} — {c.transporter_name}</option>
                                ))}
                              </select>
                              <select
                                value={input.vehicleId ?? ''}
                                onChange={(e) => updateInput(tour.id, 'vehicleId', e.target.value ? Number(e.target.value) : null)}
                                onClick={(e) => e.stopPropagation()}
                                disabled={ownTrailers.length === 0}
                                className="rounded border px-1.5 py-1 text-[11px] min-w-0 disabled:opacity-50"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', maxWidth: '140px' }}
                                title={ownTrailers.length === 0 ? 'Aucune remorque interne disponible' : 'Remorque interne (notre flotte)'}
                              >
                                <option value="">{ownTrailers.length === 0 ? 'Pas de remorque' : 'Remorque'}</option>
                                {ownTrailers.map((v) => (
                                  <option key={v.id} value={v.id}>{v.label}</option>
                                ))}
                              </select>
                            </>
                          )}

                          {/* Heure départ */}
                          <input
                            type="time"
                            value={input.time}
                            onChange={(e) => updateInput(tour.id, 'time', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border px-1.5 py-1 text-[11px] w-[90px] shrink-0"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                          />

                          {/* Priorité manuelle (départage les départs à même heure) */}
                          <input
                            type="number"
                            min={1}
                            step={1}
                            placeholder="Prio"
                            title="Priorité (1 = le plus prioritaire)"
                            value={input.priority ?? ''}
                            onChange={(e) => updateInput(tour.id, 'priority', e.target.value ? Number(e.target.value) : null)}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded border px-1.5 py-1 text-[11px] w-[56px] shrink-0"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                          />

                          {/* Bouton planifier */}
                          <button
                            className="px-2 py-1 rounded text-[11px] font-semibold transition-all disabled:opacity-40 shrink-0"
                            style={{
                              backgroundColor: canSchedule && !overlap ? 'var(--color-primary)' : 'var(--bg-tertiary)',
                              color: canSchedule && !overlap ? '#fff' : 'var(--text-muted)',
                            }}
                            disabled={!canSchedule || !!overlap || scheduling === tour.id}
                            onClick={(e) => { e.stopPropagation(); handleSchedule(tour.id) }}
                          >
                            {scheduling === tour.id ? '...' : (editingTourId === tour.id ? 'Enregistrer' : 'Planifier')}
                          </button>

                          {/* En édition : annuler la modif (ne supprime pas). Sinon : supprimer (libère les volumes) /
                              While editing: cancel edit (no delete). Otherwise: delete (releases volumes) */}
                          <button
                            className="px-2 py-1 rounded text-[11px] font-semibold border transition-all hover:opacity-80 disabled:opacity-40 shrink-0"
                            style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', backgroundColor: 'rgba(239,68,68,0.1)' }}
                            disabled={scheduling === tour.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (editingTourId === tour.id) setEditingTourId(null)
                              else handleCancel(tour.id)
                            }}
                          >
                            {scheduling === tour.id ? '...' : (editingTourId === tour.id ? 'Annuler' : 'Supprimer')}
                          </button>

                          {/* Retour estimé inline */}
                          {estReturn && (
                            <span className="text-[10px] shrink-0" style={{ color: estReturn > '22:00' ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                              Ret: <span className="font-bold">{estReturn}</span>
                            </span>
                          )}
                          {overlap && (
                            <span className="text-[10px] font-bold shrink-0" style={{ color: 'var(--color-danger)' }}>
                              Chevauche {overlap.code}
                            </span>
                          )}
                        </>
                      ) : tour.departure_signal_time ? (
                        /* --- Verrouillé (top départ validé) --- */
                        <>
                          {tourContract && (
                            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: 'var(--color-success)' }}>
                              {tourContract.code}
                            </span>
                          )}
                          {tour.priority != null && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0" title="Priorité" style={{ backgroundColor: 'rgba(249,115,22,0.12)', color: 'var(--color-primary)' }}>
                              P{tour.priority}
                            </span>
                          )}
                          <span className="text-[11px] font-mono" style={{ color: 'var(--text-primary)' }}>
                            {tour.departure_time} → {tour.return_time}
                          </span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold" style={{ color: 'var(--text-muted)', backgroundColor: 'var(--bg-tertiary)' }}>
                            Top depart valide
                          </span>
                        </>
                      ) : (
                        /* --- Planifié DRAFT ou VALIDATED : carte alignée, colonnes fixes --- */
                        <>
                          {/* Moyen : contrat OU véhicule propre — badge largeur fixe uniforme */}
                          <div className="shrink-0" style={{ width: '82px' }}>
                            {tourContract ? (
                              <span className="block w-full text-center text-[11px] font-bold px-1 py-0.5 rounded truncate" title={`${tourContract.code} — ${tourContract.transporter_name}`} style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: 'var(--color-success)' }}>
                                {tourContract.code}
                              </span>
                            ) : tour.vehicle_id ? (
                              <span className="block w-full text-center text-[10px] font-bold px-1 py-0.5 rounded truncate" title={`${vehicleMap.get(tour.vehicle_id)?.license_plate ?? ''}${tour.tractor_id ? ' + ' + (vehicleMap.get(tour.tractor_id)?.license_plate ?? '') : ''}`} style={{ backgroundColor: 'rgba(59,130,246,0.1)', color: '#3b82f6' }}>
                                {vehicleMap.get(tour.vehicle_id)?.license_plate ?? vehicleMap.get(tour.vehicle_id)?.code ?? `V#${tour.vehicle_id}`}
                              </span>
                            ) : tour.driver_name ? (
                              /* Mouvement propre (chauffeur Base seul) : même badge vert que les transporteurs /
                                 Own movement (base driver only): same green badge as carriers */
                              <span className="block w-full text-center text-[11px] font-bold px-1 py-0.5 rounded truncate" title={tour.driver_name} style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: 'var(--color-success)' }}>
                                {tour.driver_name}
                              </span>
                            ) : (
                              <span className="block w-full text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
                            )}
                          </div>

                          {/* Chauffeur — slot largeur fixe (masqué si déjà affiché dans le badge vert) */}
                          <div className="text-[11px] truncate shrink-0 text-center" style={{ width: '52px', color: 'var(--text-secondary)' }} title={tour.driver_name ?? ''}>
                            {(tourContract || tour.vehicle_id) ? (tour.driver_name || '—') : '—'}
                          </div>

                          {/* Livraison (1er) */}
                          <div className="text-center shrink-0" style={{ width: '52px' }}>
                            <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Livr.</div>
                            <div className="text-[11px]" style={{ color: 'var(--text-primary)' }}>{tour.delivery_date ? formatDate(tour.delivery_date) : '—'}</div>
                          </div>

                          {/* Horaire vertical : départ ↓ retour (2e) */}
                          <div
                            className="flex flex-col items-center leading-tight shrink-0"
                            style={{ width: '46px' }}
                            title={tour.total_duration_minutes != null ? formatDuration(tour.total_duration_minutes) : undefined}
                          >
                            <span className="text-[11px] font-mono font-bold" style={{ color: 'var(--text-primary)' }}>{tour.departure_time ?? '—'}</span>
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>↓</span>
                            <span className="text-[11px] font-mono" style={{ color: 'var(--text-secondary)' }}>{tour.return_time ?? '—'}</span>
                          </div>

                          {/* Priorité (3e) — éditable DRAFT, badge sinon */}
                          <div className="flex items-center justify-center shrink-0" style={{ width: '40px' }}>
                            {tour.status === 'DRAFT' ? (
                              <input
                                type="number"
                                min={1}
                                step={1}
                                placeholder="Prio"
                                title="Priorité (1 = le plus prioritaire) — modifiable avant validation"
                                defaultValue={tour.priority ?? ''}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                                onBlur={(e) => {
                                  const v = e.target.value ? Number(e.target.value) : null
                                  if (v !== (tour.priority ?? null)) handlePriorityUpdate(tour.id, v)
                                }}
                                className="rounded border px-1 py-0.5 text-[11px] w-full text-center"
                                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--color-primary)', color: 'var(--text-primary)' }}
                              />
                            ) : tour.priority != null ? (
                              <span className="text-[11px] font-bold" style={{ color: 'var(--color-primary)' }}>P{tour.priority}</span>
                            ) : (
                              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>—</span>
                            )}
                          </div>

                          {/* Coût (4e) */}
                          <div className="text-center shrink-0" style={{ width: '48px' }}>
                            <div className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Coût</div>
                            <div className="text-[11px]">
                              {tour.total_cost != null ? (
                                <span
                                  className="cursor-pointer underline decoration-dotted hover:opacity-80"
                                  style={{ color: 'var(--color-primary)' }}
                                  onClick={(e) => { e.stopPropagation(); setCostTourId(tour.id) }}
                                  title="Détail coûts"
                                >
                                  {tour.total_cost}€
                                </span>
                              ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </div>
                          </div>

                          {/* Bloc boutons 2 colonnes x 2 lignes (droite, bas aligné au coût) */}
                          <div className="ml-auto grid grid-cols-2 gap-1 shrink-0" style={{ width: '110px' }}>
                            {tour.status === 'DRAFT' && (
                              <button
                                className="w-full px-1 py-0.5 rounded text-[10px] font-semibold border transition-all hover:opacity-80"
                                style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
                                disabled={scheduling === tour.id}
                                onClick={(e) => { e.stopPropagation(); startEditTour(tour) }}
                                title="Modifier l'heure, le chauffeur ou le moyen sans annuler le tour"
                              >
                                Modifier
                              </button>
                            )}
                            {tour.status === 'DRAFT' ? (
                              <button
                                className="w-full px-1 py-0.5 rounded text-[10px] font-semibold border transition-all hover:opacity-80"
                                style={{ borderColor: 'var(--color-success)', color: 'var(--color-success)' }}
                                disabled={scheduling === tour.id}
                                onClick={(e) => { e.stopPropagation(); handleValidate(tour.id) }}
                              >
                                {scheduling === tour.id ? '...' : 'Valider'}
                              </button>
                            ) : (
                              <button
                                className="w-full px-1 py-0.5 rounded text-[10px] border transition-all hover:opacity-80"
                                style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
                                disabled={scheduling === tour.id}
                                onClick={(e) => { e.stopPropagation(); handleRevertDraft(tour.id) }}
                              >
                                {scheduling === tour.id ? '...' : 'Defaire'}
                              </button>
                            )}
                            {canUnschedule && (
                              <button
                                className="w-full px-1 py-0.5 rounded text-[10px] border transition-all hover:opacity-80"
                                style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
                                disabled={scheduling === tour.id}
                                onClick={(e) => { e.stopPropagation(); handleUnschedule(tour.id) }}
                              >
                                {scheduling === tour.id ? '...' : 'Retirer'}
                              </button>
                            )}
                            <button
                              className="w-full px-1 py-0.5 rounded text-[10px] font-semibold border transition-all hover:opacity-80"
                              style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', backgroundColor: 'rgba(239,68,68,0.1)' }}
                              disabled={scheduling === tour.id}
                              onClick={(e) => { e.stopPropagation(); handleCancel(tour.id) }}
                            >
                              {scheduling === tour.id ? '...' : 'Annuler'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    {/* === Zone expanded / Expanded area === */}
                    {isExpanded && (
                      <div className="px-3 pb-2 border-t" style={{ borderColor: 'var(--border-color)' }}>
                        {/* Avertissement fenêtre livraison / Delivery window warning */}
                        {windowViolations && (
                          <div className="mt-1 mb-1 text-[10px] font-bold" style={{ color: 'var(--color-danger)' }}>
                            {windowViolations.map((v, i) => (
                              <span key={i}>{i > 0 && ' | '}{v}</span>
                            ))}
                          </div>
                        )}

                        {/* Stops détaillés / Detailed stops */}
                        {renderStopList(tour)}

                        {/* Info contrat pour non-planifié / Contract info for unscheduled */}
                        {!isScheduled && selectedContract && (
                          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {selectedContract.transporter_name} — {selectedContract.vehicle_code ?? selectedContract.code}
                            {selectedContract.fixed_daily_cost != null && ` | ${selectedContract.fixed_daily_cost}€/j`}
                            {selectedContract.cost_per_km != null && ` + ${selectedContract.cost_per_km}€/km`}
                          </div>
                        )}

                        {/* Info contrat pour planifié / Contract info for scheduled */}
                        {isScheduled && tourContract && (
                          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {tourContract.transporter_name} — {tourContract.vehicle_code ?? tourContract.code}
                            {tourContract.vehicle_name && ` (${tourContract.vehicle_name})`}
                          </div>
                        )}

                        {/* Info véhicule propre pour planifié / Own vehicle info for scheduled */}
                        {isScheduled && tour.vehicle_id && (() => {
                          const v = vehicleMap.get(tour.vehicle_id)
                          const tractor = tour.tractor_id ? vehicleMap.get(tour.tractor_id) : null
                          if (!v) return null
                          return (
                            <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                              <span style={{ color: '#3b82f6' }}>Parc propre :</span>{' '}
                              {v.license_plate ?? v.code}{v.name ? ` — ${v.name}` : ''}
                              {tractor && ` | Tracteur : ${tractor.license_plate ?? tractor.code}${tractor.name ? ` — ${tractor.name}` : ''}`}
                            </div>
                          )
                        })()}

                        {/* Retour estimé détaillé pour non-planifié / Detailed estimated return for unscheduled */}
                        {!isScheduled && estReturn && (
                          <div className="mt-1 text-xs" style={{ color: estReturn > '22:00' ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {t('tourPlanning.estimatedReturn')}: <span className="font-bold">{estReturn}</span>
                            {input.time && (
                              <span className="ml-2">
                                ({formatDuration(parseTime(estReturn) - parseTime(input.time) + (parseTime(estReturn) < parseTime(input.time) ? 24 * 60 : 0))})
                              </span>
                            )}
                          </div>
                        )}

                        {/* Avertissement chevauchement détaillé / Detailed overlap warning */}
                        {!isScheduled && overlap && (
                          <div
                            className="mt-1 rounded px-2 py-1 text-xs flex items-center gap-2"
                            style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: 'var(--color-danger)' }}
                          >
                            <span className="font-bold">!</span>
                            {t('tourPlanning.overlapWarning', { code: overlap.code, from: overlap.departure_time, to: overlap.return_time })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
        )}

        {/* Séparateur redimensionnable (uniquement si les deux panneaux visibles) /
            Draggable split handle (only when both panels visible) */}
        {showList && showGantt && (
          <div
            className="flex-shrink-0 cursor-col-resize flex items-center justify-center group"
            style={{ width: '12px' }}
            onMouseDown={handleSplitResize}
          >
            <div className="w-1 h-12 rounded-full transition-colors group-hover:bg-orange-500/50" style={{ backgroundColor: 'var(--border-color)' }} />
          </div>
        )}

        {/* Panneau droit — Gantt SVG / Right panel — SVG Gantt */}
        {showGantt && (
          <div className="min-w-[200px] flex-1">
            <div className="relative rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-color)' }}>
              <TourGantt
                tours={ganttData}
                highlightedTourId={highlightedTourId}
                onTourClick={setHighlightedTourId}
                warningTourIds={new Set(deliveryWindowViolations.keys())}
                rowHeights={prefs.listColumns === 1 ? measuredRowHeights : []}
                headerHeight={prefs.listColumns === 1 ? (measuredHeaderHeight || undefined) : undefined}
                expandedTourIds={expandedTourIds}
                driverSort={sortMode === 'asc' || sortMode === 'desc' ? sortMode : null}
              />
            </div>
          </div>
        )}

        {/* Placeholder quand liste détachée et Gantt visible / Placeholder when list detached and Gantt visible */}
        {!showList && showGantt && listDetached && (
          <div className="absolute left-4 top-4 px-3 py-2 rounded-lg border text-xs"
            style={{ borderColor: 'var(--border-color)', backgroundColor: 'rgba(0,0,0,0.6)', color: 'var(--text-muted)' }}>
            Liste détachée — fermer la popup pour la réattacher
          </div>
        )}
      </div>

      {/* Plan de tour imprimable / Printable tour plan */}
      {showPrintPlan && (
        <TourPrintPlan
          tours={tours}
          pdvs={pdvs}
          contracts={allContracts}
          bases={bases}
          distances={distances}
          volumes={allVolumes}
          date={selectedDate}
          onClose={() => setShowPrintPlan(false)}
        />
      )}

      {costTourId && (
        <CostBreakdown tourId={costTourId} onClose={() => setCostTourId(null)} />
      )}

      {showConfirmMail && (
        <TransporterConfirmationModal
          date={selectedDate}
          transporters={transportersForDate}
          onClose={() => setShowConfirmMail(false)}
        />
      )}
    </div>
  )
}
