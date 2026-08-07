/* Page Exploitant v2 — Vue split tableau/Gantt / Warehouse Operations page v2 — Split table/Gantt view */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import api, { downloadPostierPlanning } from '../services/api'
import type { Tour, BaseLogistics, Contract, PDV, Volume, ManifestLine, ManifestImportResult, MobileDevice, VehicleSummary, TemperatureClass } from '../types'
import { TEMPERATURE_COLORS, TOUR_TYPE_LABELS } from '../types'
import { TourWaybill } from '../components/tour/TourWaybill'
import { DriverRouteSheet } from '../components/tour/DriverRouteSheet'
import { TourGantt } from '../components/operations/TourGantt'
import { computeTourDelay, detectSecondTourImpacts, DELAY_COLORS } from '../utils/tourDelay'
import type { TourWithDelay, TourImpact } from '../utils/tourDelay'
import { parseTime, displayDateTime, nowDateTimeLocal, formatDate } from '../utils/tourTimeUtils'
import { useAppStore } from '../stores/useAppStore'
import { useAuthStore } from '../stores/useAuthStore'

const REFRESH_INTERVAL = 30_000
const PREFS_KEY = 'ops-prefs'

/* --- Préférences persistées / Persisted preferences --- */

interface OpsPrefs {
  hiddenCols: string[]
  colWidths: Record<string, number>
  splitPct: number
}

function loadPrefs(): OpsPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { hiddenCols: [], colWidths: {}, splitPct: 60 }
}

function savePrefs(p: OpsPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p))
}

/* --- Définition des colonnes / Column definitions --- */

interface OpsCol {
  key: string
  label: string
  defaultWidth: number
  align?: 'center'
}

const ALL_COLUMNS: OpsCol[] = [
  { key: 'code', label: 'common.code', defaultWidth: 90 },
  { key: 'vehicle', label: 'operations.vehicle', defaultWidth: 130 },
  { key: 'driver', label: 'operations.driverName', defaultWidth: 110 },
  { key: 'departure', label: 'operations.dep', defaultWidth: 60, align: 'center' },
  { key: 'priority', label: 'tourPlanning.priority', defaultWidth: 50, align: 'center' },
  { key: 'stops', label: 'tourPlanning.stops', defaultWidth: 55, align: 'center' },
  { key: 'eqc', label: 'EQC', defaultWidth: 55, align: 'center' },
  { key: 'delay', label: 'operations.delay', defaultWidth: 75, align: 'center' },
  { key: 'exit', label: 'operations.barrierExit', defaultWidth: 60, align: 'center' },
]

/* ═══════════════════════════════════════════ */

export default function Operations() {
  const { t } = useTranslation()
  const { isFullscreen, toggleFullscreen } = useAppStore()
  const canModifyStops = useAuthStore((s) => s.hasPermission('tour-stop-modify', 'update'))
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [baseId, setBaseId] = useState<number | ''>('')
  const [bases, setBases] = useState<BaseLogistics[]>([])
  const [tours, setTours] = useState<Tour[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [pdvs, setPdvs] = useState<PDV[]>([])
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [waybillTourId, setWaybillTourId] = useState<number | null>(null)
  const [routeSheetTourId, setRouteSheetTourId] = useState<number | null>(null)
  const [assignQrTour, setAssignQrTour] = useState<{ id: number; code: string; driver_name?: string } | null>(null)
  const [assignMode, setAssignMode] = useState<'qr' | 'direct'>('qr')
  const [assignDevices, setAssignDevices] = useState<MobileDevice[]>([])
  const [assignDeviceId, setAssignDeviceId] = useState<number | ''>('')
  const [assignDriverName, setAssignDriverName] = useState('')
  const [assignBusy, setAssignBusy] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<string>('')
  const [exportingPlanning, setExportingPlanning] = useState(false)

  const handleExportPlanning = useCallback(async () => {
    if (!baseId) return
    setExportingPlanning(true)
    try {
      await downloadPostierPlanning(date, baseId)
    } catch (e) {
      console.error('Failed to export postier planning', e)
    } finally {
      setExportingPlanning(false)
    }
  }, [date, baseId])
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  /* Préférences colonnes et split / Column & split preferences */
  const [prefs, setPrefs] = useState<OpsPrefs>(loadPrefs)
  const hiddenCols = useMemo(() => new Set(prefs.hiddenCols), [prefs.hiddenCols])
  const [showColMenu, setShowColMenu] = useState(false)
  const colMenuRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [measuredRowHeights, setMeasuredRowHeights] = useState<number[]>([])
  const [measuredTheadHeight, setMeasuredTheadHeight] = useState(26)

  const updatePrefs = useCallback((patch: Partial<OpsPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  const visibleCols = useMemo(
    () => ALL_COLUMNS.filter((c) => !hiddenCols.has(c.key)),
    [hiddenCols],
  )

  const getColWidth = (col: OpsCol) => prefs.colWidths[col.key] ?? col.defaultWidth

  /* Fermer menu colonnes si clic en dehors / Close column menu on outside click */
  useEffect(() => {
    if (!showColMenu) return
    const handler = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setShowColMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showColMenu])

  /* Redimensionnement colonnes / Column resize */
  const resizingCol = useRef<string | null>(null)
  const resizeStartX = useRef(0)
  const resizeStartW = useRef(0)

  const handleColResize = useCallback((e: React.MouseEvent, colKey: string, thEl: HTMLTableCellElement) => {
    e.preventDefault()
    e.stopPropagation()
    resizingCol.current = colKey
    resizeStartX.current = e.clientX
    resizeStartW.current = thEl.offsetWidth

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(40, resizeStartW.current + ev.clientX - resizeStartX.current)
      setPrefs((prev) => {
        const next = { ...prev, colWidths: { ...prev.colWidths, [colKey]: w } }
        savePrefs(next)
        return next
      })
    }
    const onUp = () => {
      resizingCol.current = null
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

  /* Redimensionnement split / Split resize */
  const splitContainerRef = useRef<HTMLDivElement>(null)

  const handleSplitResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = splitContainerRef.current
    if (!container) return

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const pct = Math.max(30, Math.min(80, ((ev.clientX - rect.left) / rect.width) * 100))
      updatePrefs({ splitPct: Math.round(pct) })
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
  }, [updatePrefs])

  /* Toggle colonne / Toggle column visibility */
  const toggleCol = (key: string) => {
    const next = new Set(prefs.hiddenCols)
    if (next.has(key)) {
      next.delete(key)
    } else {
      if (ALL_COLUMNS.length - next.size <= 2) return
      next.add(key)
    }
    updatePrefs({ hiddenCols: [...next] })
  }

  /* Formulaires locaux / Local form state per tour */
  const [forms, setForms] = useState<Record<number, {
    driver_name: string
    driver_arrival_time: string
    loading_end_time: string
    total_weight_kg: string
    remarks: string
    loader_code: string
    loader_name: string
    trailer_number: string
    dock_door_number: string
    trailer_ready_time: string
    eqp_loaded: string
    departure_signal_time: string
    trailer_ready_temp: string
    loading_end_temp: string
    vehicle_id: string
    tractor_id: string
  }>>({})
  const [fleetVehicles, setFleetVehicles] = useState<VehicleSummary[]>([])

  /* Charger référentiels / Load reference data */
  useEffect(() => {
    api.get('/bases/').then((r) => setBases(r.data))
    api.get('/contracts/').then((r) => setContracts(r.data))
    api.get('/pdvs/').then((r) => setPdvs(r.data))
    api.get('/vehicles/summary').then((r) => setFleetVehicles(r.data)).catch(() => {})
  }, [])

  const contractMap = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts])
  const pdvMap = useMemo(() => new Map(pdvs.map((p) => [p.id, p])), [pdvs])

  /* Charger tours / Load tours */
  const loadTours = useCallback(async (silent = false) => {
    if (!baseId) { setTours([]); setVolumes([]); return }
    if (!silent) setLoading(true)
    try {
      const params: Record<string, unknown> = { delivery_date: date, base_id: baseId }
      const [toursRes, volRes] = await Promise.all([
        api.get<Tour[]>('/tours/', { params }),
        api.get<Volume[]>('/volumes/', { params: { base_origin_id: baseId } }),
      ])
      const data = toursRes.data
      setVolumes(volRes.data)
      // Postier : ne montrer que les tours validés (planifiés non validés = en attente au transport)
      const scheduled = data.filter((t) => t.departure_time && t.status !== 'DRAFT')
      setTours(scheduled)
      setForms((prev) => {
        const next: typeof prev = {}
        for (const tour of scheduled) {
          next[tour.id] = prev[tour.id] ?? {
            driver_name: tour.driver_name ?? '',
            driver_arrival_time: tour.driver_arrival_time ?? '',
            loading_end_time: tour.loading_end_time ?? '',
            total_weight_kg: tour.total_weight_kg != null ? String(tour.total_weight_kg) : '',
            remarks: tour.remarks ?? '',
            loader_code: tour.loader_code ?? '',
            loader_name: tour.loader_name ?? '',
            trailer_number: tour.trailer_number ?? '',
            dock_door_number: tour.dock_door_number ?? '',
            trailer_ready_time: tour.trailer_ready_time ?? '',
            eqp_loaded: tour.eqp_loaded != null ? String(tour.eqp_loaded) : '',
            departure_signal_time: tour.departure_signal_time ?? '',
            trailer_ready_temp: tour.trailer_ready_temp != null ? String(tour.trailer_ready_temp) : '',
            loading_end_temp: tour.loading_end_temp != null ? String(tour.loading_end_temp) : '',
            vehicle_id: tour.vehicle_id != null ? String(tour.vehicle_id) : '',
            tractor_id: tour.tractor_id != null ? String(tour.tractor_id) : '',
          }
        }
        return next
      })
      const now = new Date()
      setLastRefresh(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`)
    } catch (e) {
      console.error('Failed to load tours', e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [date, baseId])

  useEffect(() => { loadTours() }, [loadTours])

  /* Auto-refresh */
  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current)
    if (!baseId) return
    refreshTimer.current = setInterval(() => loadTours(true), REFRESH_INTERVAL)
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current) }
  }, [baseId, loadTours])

  /* Calcul retards / Delay computation */
  const toursWithDelay: TourWithDelay[] = useMemo(
    () => tours.map(computeTourDelay).sort((a, b) =>
      (parseTime(a.departure_time || '99:99') - parseTime(b.departure_time || '99:99'))
      || ((a.priority ?? Infinity) - (b.priority ?? Infinity))),
    [tours],
  )

  const impacts: TourImpact[] = useMemo(
    () => detectSecondTourImpacts(toursWithDelay),
    [toursWithDelay],
  )

  /* Formulaire helpers */
  const updateForm = (tourId: number, field: string, value: string) => {
    setForms((prev) => ({ ...prev, [tourId]: { ...prev[tourId], [field]: value } }))
  }

  const handleLoaderLookup = async (tourId: number, code: string) => {
    if (!code || code.length < 2) return
    try {
      const res = await api.get(`/loaders/by-code/${encodeURIComponent(code)}`)
      updateForm(tourId, 'loader_name', res.data.name)
    } catch {
      updateForm(tourId, 'loader_name', '')
    }
  }

  const handleSave = async (tourId: number) => {
    setSaving(tourId)
    try {
      const f = forms[tourId]
      await api.put(`/tours/${tourId}/operations`, {
        ...f,
        total_weight_kg: f.total_weight_kg ? parseFloat(f.total_weight_kg) : null,
        eqp_loaded: f.eqp_loaded ? parseInt(f.eqp_loaded, 10) : null,
        trailer_ready_temp: f.trailer_ready_temp ? parseFloat(f.trailer_ready_temp) : null,
        loading_end_temp: f.loading_end_temp ? parseFloat(f.loading_end_temp) : null,
        vehicle_id: f.vehicle_id ? parseInt(f.vehicle_id, 10) : null,
        tractor_id: f.tractor_id ? parseInt(f.tractor_id, 10) : null,
      })
      await loadTours()
    } catch (e) {
      console.error('Failed to save operations', e)
    } finally {
      setSaving(null)
    }
  }

  /* Desaffecter un tour / Unassign a tour from device */
  const handleUnassignDevice = async (tour: Tour) => {
    if (!tour.device_assignment_id) return
    if (!confirm(`Desaffecter le tour ${tour.code} du telephone ?`)) return
    try {
      await api.delete(`/assignments/${tour.device_assignment_id}`)
      await loadTours()
    } catch (e) {
      console.error('Failed to unassign device', e)
    }
  }

  /* Retirer un stop / Remove a stop */
  const handleRemoveStop = async (tourId: number, stopId: number, pdvCode: string, temps: TemperatureClass[] = []) => {
    const tempLabel = temps.length > 0 ? ` [${temps.join(' + ')}]` : ''
    if (!confirm(`Retirer le PDV ${pdvCode}${tempLabel} du tour ?\nLes volumes seront libérés.`)) return
    try {
      await api.delete(`/tours/${tourId}/stops/${stopId}`)
      await loadTours(true)
    } catch (e: unknown) {
      const resp = (e as { response?: { status?: number; data?: { detail?: string } } })?.response
      alert(resp?.data?.detail || 'Erreur lors du retrait du stop')
    }
  }

  /* Ajouter un stop / Add a stop */
  const handleAddStop = async (tourId: number, pdvId: number, eqpCount: number = 0) => {
    try {
      await api.post(`/tours/${tourId}/stops`, { pdv_id: pdvId, eqp_count: eqpCount })
      await loadTours(true)
    } catch (e: unknown) {
      const resp = (e as { response?: { status?: number; data?: { detail?: string } } })?.response
      alert(resp?.data?.detail || 'Erreur lors de l\'ajout du stop')
    }
  }

  /* Charger appareils quand modale ouvre / Load devices when modal opens */
  useEffect(() => {
    if (!assignQrTour) return
    setAssignMode('qr')
    setAssignDeviceId('')
    setAssignDriverName(assignQrTour.driver_name || '')
    if (baseId) {
      api.get<MobileDevice[]>('/devices/', { params: { base_id: baseId } })
        .then((r) => setAssignDevices(r.data.filter((d) => d.is_active && d.registered_at)))
        .catch(() => setAssignDevices([]))
    }
  }, [assignQrTour, baseId])

  /* Affecter tour directement a un telephone / Assign tour directly to a device */
  const handleDirectAssign = async () => {
    if (!assignQrTour || !assignDeviceId) return
    setAssignBusy(true)
    try {
      await api.post('/assignments/', {
        device_id: assignDeviceId,
        tour_id: assignQrTour.id,
        date,
        driver_name: assignDriverName || null,
      })
      setAssignQrTour(null)
      await loadTours()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur'
      alert(msg)
    } finally {
      setAssignBusy(false)
    }
  }

  const getTourEqp = (tour: Tour) => tour.total_eqp ?? tour.stops.reduce((s, st) => s + st.eqp_count, 0)
  const toggleExpand = (id: number) => setExpandedId((prev) => (prev === id ? null : id))

  /* Mise à jour directe EQC stops après import manifeste / Direct stop EQC update after manifest import */
  const patchTourStopsEqc = useCallback((tourId: number, eqcByPdv: Record<string, number>) => {
    setTours((prev) =>
      prev.map((t) => {
        if (t.id !== tourId) return t
        const totalEqc = Object.values(eqcByPdv).reduce((s, v) => s + v, 0)
        return {
          ...t,
          total_eqp: totalEqc,
          eqp_loaded: totalEqc,
          stops: t.stops.map((stop) => {
            const pdv = pdvs.find((p) => p.id === stop.pdv_id)
            const pdvCode = pdv?.code?.trim()
            if (pdvCode && pdvCode in eqcByPdv) {
              return { ...stop, eqp_count: eqcByPdv[pdvCode] }
            }
            return stop
          }),
        }
      }),
    )
  }, [pdvs])

  const nowFormatted = () => nowDateTimeLocal()

  const colCount = visibleCols.length

  /* Mesurer les hauteurs de lignes pour aligner le Gantt / Measure row heights for Gantt alignment */
  useLayoutEffect(() => {
    const table = tableRef.current
    if (!table) return
    const thead = table.querySelector('thead')
    if (thead) setMeasuredTheadHeight(thead.getBoundingClientRect().height)
    const tbodies = table.querySelectorAll<HTMLElement>('tbody[data-tour-id]')
    const heights: number[] = []
    tbodies.forEach((tb) => heights.push(tb.getBoundingClientRect().height))
    setMeasuredRowHeights(heights)
  }, [toursWithDelay, expandedId, visibleCols, prefs.colWidths])

  return (
    <div className="p-6">
      {waybillTourId && <TourWaybill tourId={waybillTourId} onClose={() => setWaybillTourId(null)} />}
      {routeSheetTourId && <DriverRouteSheet tourId={routeSheetTourId} onClose={() => setRouteSheetTourId(null)} />}

      {/* Modale affectation telephone (QR + direct) / Device assignment modal (QR + direct) */}
      {assignQrTour && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <div className="rounded-2xl p-6 shadow-2xl" style={{ backgroundColor: 'var(--bg-secondary)', minWidth: 360, maxWidth: 420 }}>
            <h3 className="text-lg font-bold mb-1 text-center" style={{ color: 'var(--text-primary)' }}>Affecter au telephone</h3>
            <p className="text-sm mb-3 text-center" style={{ color: 'var(--color-primary)' }}>{assignQrTour.code}</p>

            {/* Onglets QR / Direct / Tabs QR / Direct */}
            <div className="flex mb-4 rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-color)' }}>
              <button
                onClick={() => setAssignMode('qr')}
                className="flex-1 py-2 text-sm font-semibold transition-all"
                style={{
                  backgroundColor: assignMode === 'qr' ? 'var(--color-primary)' : 'var(--bg-tertiary)',
                  color: assignMode === 'qr' ? '#fff' : 'var(--text-secondary)',
                }}
              >
                QR Code
              </button>
              <button
                onClick={() => setAssignMode('direct')}
                className="flex-1 py-2 text-sm font-semibold transition-all"
                style={{
                  backgroundColor: assignMode === 'direct' ? 'var(--color-primary)' : 'var(--bg-tertiary)',
                  color: assignMode === 'direct' ? '#fff' : 'var(--text-secondary)',
                }}
              >
                Affectation directe
              </button>
            </div>

            {assignMode === 'qr' ? (
              <div className="text-center">
                <div className="flex justify-center mb-4 p-4 rounded-xl" style={{ backgroundColor: '#fff' }}>
                  <QRCodeSVG value={`TOUR:${assignQrTour.id}`} size={200} level="H" />
                </div>
                <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                  Scannez ce QR avec l'application chauffeur pour affecter le tour.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Dropdown telephone / Device dropdown */}
                <div>
                  <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Telephone</label>
                  <select
                    value={assignDeviceId}
                    onChange={(e) => setAssignDeviceId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  >
                    <option value="">-- Choisir un telephone --</option>
                    {assignDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.friendly_name || `Tel #${d.id}`} {d.device_identifier ? `(${d.device_identifier.slice(0, 8)}...)` : '(non enregistre)'}
                      </option>
                    ))}
                  </select>
                  {assignDevices.length === 0 && (
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Aucun telephone enregistre pour cette base.</p>
                  )}
                </div>
                {/* Nom chauffeur / Driver name */}
                <div>
                  <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>Nom du chauffeur</label>
                  <input
                    type="text"
                    value={assignDriverName}
                    onChange={(e) => setAssignDriverName(e.target.value)}
                    placeholder="Nom du chauffeur"
                    className="w-full px-3 py-2 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
                {/* Bouton affecter / Assign button */}
                <button
                  onClick={handleDirectAssign}
                  disabled={!assignDeviceId || assignBusy}
                  className="w-full py-2.5 rounded-lg text-sm font-bold transition-all hover:opacity-80 disabled:opacity-40"
                  style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
                >
                  {assignBusy ? 'Affectation...' : 'Affecter'}
                </button>
              </div>
            )}

            <button
              onClick={() => setAssignQrTour(null)}
              className="w-full mt-3 px-6 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-80"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            >
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* En-tête / Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {t('operations.title')}
        </h1>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs px-2 py-1 rounded-lg" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              {t('operations.autoRefresh')} &middot; {lastRefresh}
            </span>
          )}
          {/* Menu colonnes / Column menu */}
          <div className="relative" ref={colMenuRef}>
            <button
              onClick={() => setShowColMenu((v) => !v)}
              className="px-3 py-2 rounded-lg border text-sm transition-all hover:opacity-80"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)' }}
              title={t('common.columns')}
            >
              &#8801; {t('common.columns')}
            </button>
            {showColMenu && (
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[180px]"
                style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
              >
                {ALL_COLUMNS.map((col) => (
                  <label key={col.key} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm hover:opacity-80" style={{ color: 'var(--text-primary)' }}>
                    <input type="checkbox" checked={!hiddenCols.has(col.key)} onChange={() => toggleCol(col.key)} className="accent-orange-500" />
                    {col.label === 'EQC' ? 'EQC' : t(col.label)}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button
            className="px-3 py-2 rounded-lg border text-sm transition-all hover:opacity-80"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)' }}
            onClick={toggleFullscreen}
            title={isFullscreen ? t('tourPlanning.exitFullscreen') : t('tourPlanning.enterFullscreen')}
          >
            {isFullscreen ? '\u229F' : '\u229E'}
          </button>
        </div>
      </div>

      {/* Filtres / Filters */}
      <div className="flex gap-4 mb-5 flex-wrap">
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{t('common.date')}</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-3 py-2 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
        </div>
        <div>
          <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{t('operations.base')}</label>
          <select value={baseId} onChange={(e) => setBaseId(e.target.value ? Number(e.target.value) : '')} className="px-3 py-2 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
            <option value="">{t('operations.selectBase')}</option>
            {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <button
            onClick={handleExportPlanning}
            disabled={!baseId || exportingPlanning || tours.length === 0}
            className="px-3 py-2 rounded-lg border text-sm font-medium transition-colors hover:opacity-80 disabled:opacity-50"
            style={{ color: 'white', backgroundColor: 'var(--color-success)', borderColor: 'var(--color-success)' }}
            title="Exporter le planning du jour au format Excel (feuille Tours / Tournées ERT)"
          >
            {exportingPlanning ? '...' : '⬇ Export planning (Excel)'}
          </button>
        </div>
      </div>

      {/* Alertes impact 2e tour / Second tour impact alerts */}
      {impacts.map((imp, i) => (
        <div key={i} className="flex items-center gap-2 mb-3 px-4 py-2 rounded-lg border text-sm font-semibold"
          style={{ backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>
          <span>&#9888;</span>
          <span>{t('operations.tour2Impact', {
            code1: imp.delayedTour.code, time1: imp.delayedTour.estimated_return,
            code2: imp.impactedTour.code, time2: imp.impactedTour.departure_time, overlap: imp.overlapMinutes,
          })}</span>
        </div>
      ))}

      {/* Contenu principal / Main content */}
      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</p>
      ) : tours.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>{baseId ? t('operations.noTours') : t('operations.selectBaseHint')}</p>
      ) : (
        <div ref={splitContainerRef} className="flex" style={{ alignItems: 'flex-start' }}>
          {/* Panneau gauche — Tableau accordéon / Left panel */}
          <div className="min-w-0 overflow-hidden" style={{ width: `${prefs.splitPct}%` }}>
            <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
              <div className="overflow-x-auto">
                <table ref={tableRef} className="w-full" style={{ tableLayout: 'fixed', fontSize: '10px' }}>
                  <colgroup>
                    {visibleCols.map((col) => <col key={col.key} style={{ width: `${getColWidth(col)}px` }} />)}
                  </colgroup>
                  <thead>
                    <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                      {visibleCols.map((col) => (
                        <th
                          key={col.key}
                          className={`px-3 py-2 font-medium relative whitespace-nowrap ${col.align === 'center' ? 'text-center' : 'text-left'}`}
                          style={{ color: 'var(--text-muted)', overflow: 'hidden' }}
                        >
                          {col.label === 'EQC' ? 'EQC' : t(col.label)}
                          {/* Poignée redimensionnement / Resize handle */}
                          <div
                            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-orange-500/30 transition-colors"
                            onMouseDown={(e) => {
                              const th = e.currentTarget.parentElement as HTMLTableCellElement
                              handleColResize(e, col.key, th)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {toursWithDelay.map((tour) => {
                    const contract = tour.contract_id ? contractMap.get(tour.contract_id) : null
                    const isExpanded = expandedId === tour.id
                    const form = forms[tour.id]
                    const color = DELAY_COLORS[tour.delay_level]

                    return (
                      <tbody key={tour.id} data-tour-id={tour.id}>
                        <TourRow
                          tour={tour} contract={contract ?? null} form={form}
                          isExpanded={isExpanded} color={color} pdvMap={pdvMap} volumes={volumes}
                          saving={saving === tour.id} eqc={getTourEqp(tour)} fleetVehicles={fleetVehicles}
                          visibleCols={visibleCols} colCount={colCount} t={t}
                          onToggle={() => toggleExpand(tour.id)}
                          onFormChange={(field, value) => updateForm(tour.id, field, value)}
                          onSave={() => handleSave(tour.id)}
                          onRouteSheet={() => setRouteSheetTourId(tour.id)}
                          onWaybill={() => setWaybillTourId(tour.id)}
                          onAssignDevice={() => setAssignQrTour({ id: tour.id, code: tour.code, driver_name: tour.driver_name ?? undefined })}
                          onUnassignDevice={() => handleUnassignDevice(tour)}
                          onSetNow={(field) => updateForm(tour.id, field, nowFormatted())}
                          onLoaderLookup={(code) => handleLoaderLookup(tour.id, code)}
                          onRefresh={() => loadTours(true)}
                          onPatchStopsEqc={(eqcByPdv) => patchTourStopsEqc(tour.id, eqcByPdv)}
                          canModifyStops={canModifyStops}
                          onRemoveStop={handleRemoveStop}
                          onAddStop={handleAddStop}
                          pdvs={pdvs}
                        />
                      </tbody>
                    )
                  })}
                </table>
              </div>
            </div>
          </div>

          {/* Séparateur redimensionnable / Draggable split handle */}
          <div
            className="flex-shrink-0 cursor-col-resize flex items-center justify-center group"
            style={{ width: '12px' }}
            onMouseDown={handleSplitResize}
          >
            <div className="w-1 h-12 rounded-full transition-colors group-hover:bg-orange-500/50" style={{ backgroundColor: 'var(--border-color)' }} />
          </div>

          {/* Panneau droit — Gantt / Right panel */}
          <div className="min-w-[200px]" style={{ width: `${100 - prefs.splitPct}%` }}>
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-color)' }}>
              <TourGantt
                tours={toursWithDelay}
                activeTourId={expandedId}
                onTourClick={(id) => toggleExpand(id)}
                rowHeights={measuredRowHeights}
                headerHeight={measuredTheadHeight}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Composant ligne tour / Tour row component ─── */

/* Mini-composant pour ajouter un PDV dans un tour / Inline add-stop widget */
function AddStopInline({ pdvs, tourStopPdvIds, onAdd }: { pdvs: PDV[]; tourStopPdvIds: Set<number>; onAdd: (pdvId: number, eqpCount: number) => void }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedPdv, setSelectedPdv] = useState<PDV | null>(null)
  const [eqpCount, setEqpCount] = useState('')

  const reset = () => { setOpen(false); setSearch(''); setSelectedPdv(null); setEqpCount('') }

  if (!open) {
    return (
      <button
        className="text-[10px] px-2 py-1 rounded border font-semibold transition-all hover:opacity-80 mb-2"
        style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}
      >
        + Ajouter un PDV
      </button>
    )
  }

  if (selectedPdv) {
    return (
      <div className="flex items-center gap-2 mb-2 p-2 rounded-lg border" style={{ borderColor: 'var(--color-primary)', backgroundColor: 'rgba(249,115,22,0.05)' }} onClick={(e) => e.stopPropagation()}>
        <span className="text-xs font-semibold" style={{ color: 'var(--color-primary)' }}>{selectedPdv.code} — {selectedPdv.name}</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={eqpCount}
          onChange={(e) => setEqpCount(e.target.value)}
          placeholder="EQC"
          className="w-20 px-2 py-1 rounded border text-xs text-center"
          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          autoFocus
        />
        <button
          className="text-[10px] px-2 py-1 rounded font-semibold text-white transition-all hover:opacity-80"
          style={{ backgroundColor: 'var(--color-primary)' }}
          onClick={() => { onAdd(selectedPdv.id, Number(eqpCount) || 0); reset() }}
        >
          Confirmer
        </button>
        <button className="text-[10px] px-2 py-1 rounded" style={{ color: 'var(--text-muted)' }} onClick={reset}>Annuler</button>
      </div>
    )
  }

  const q = search.toLowerCase()
  const filtered = pdvs.filter((p) => !tourStopPdvIds.has(p.id) && p.latitude && p.longitude && (p.code.toLowerCase().includes(q) || (p.name ?? '').toLowerCase().includes(q) || (p.city ?? '').toLowerCase().includes(q))).slice(0, 15)
  return (
    <div className="flex items-center gap-2 mb-2" onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        placeholder="Chercher un PDV (code, nom, ville)..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="px-2 py-1 rounded border text-xs flex-1"
        style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
        autoFocus
      />
      {search.length >= 2 && filtered.length > 0 && (
        <div className="flex gap-1 overflow-x-auto">
          {filtered.slice(0, 5).map((p) => (
            <button
              key={p.id}
              className="text-[10px] px-2 py-1 rounded border font-semibold whitespace-nowrap transition-all hover:opacity-80"
              style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
              onClick={() => setSelectedPdv(p)}
            >
              {p.code} — {p.name}
            </button>
          ))}
        </div>
      )}
      <button className="text-[10px] px-2 py-1 rounded" style={{ color: 'var(--text-muted)' }} onClick={reset}>Annuler</button>
    </div>
  )
}

interface TourRowProps {
  tour: TourWithDelay
  contract: Contract | null
  form: { driver_name: string; driver_arrival_time: string; loading_end_time: string; total_weight_kg: string; remarks: string; loader_code: string; loader_name: string; trailer_number: string; dock_door_number: string; trailer_ready_time: string; eqp_loaded: string; departure_signal_time: string; trailer_ready_temp: string; loading_end_temp: string; vehicle_id: string; tractor_id: string } | undefined
  fleetVehicles: VehicleSummary[]
  isExpanded: boolean
  color: string
  pdvMap: Map<number, PDV>
  volumes: Volume[]
  saving: boolean
  eqc: number
  visibleCols: OpsCol[]
  colCount: number
  t: (key: string, opts?: Record<string, unknown>) => string
  onToggle: () => void
  onFormChange: (field: string, value: string) => void
  onSave: () => void
  onRouteSheet: () => void
  onWaybill: () => void
  onAssignDevice: () => void
  onUnassignDevice: () => void
  onSetNow: (field: string) => void
  onLoaderLookup: (code: string) => void
  onRefresh: () => Promise<void>
  onPatchStopsEqc: (eqcByPdv: Record<string, number>) => void
  canModifyStops: boolean
  onRemoveStop: (tourId: number, stopId: number, pdvCode: string, temps?: TemperatureClass[]) => void
  onAddStop: (tourId: number, pdvId: number, eqpCount: number) => void
  pdvs: PDV[]
}

function TourRow({
  tour, contract, form, isExpanded, color, pdvMap, volumes, saving, eqc, fleetVehicles,
  visibleCols, colCount, t,
  onToggle, onFormChange, onSave, onRouteSheet, onWaybill, onAssignDevice, onUnassignDevice, onSetNow, onLoaderLookup, onPatchStopsEqc,
  canModifyStops, onRemoveStop, onAddStop, pdvs,
}: TourRowProps) {
  const vehicleLabel = contract?.vehicle_code
    ? `${contract.vehicle_code} — ${contract.vehicle_name ?? ''}`
    : (contract?.code ?? '—')

  /* Rendu cellule / Cell render */
  const cells: Record<string, React.ReactNode> = {
    code: (
      <span className="flex items-center gap-1">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isExpanded ? '▾' : '▸'}</span>
        <span style={{ color: 'var(--color-primary)', fontSize: 11, fontWeight: 400 }}>{tour.code}</span>
        {tour.tour_type && tour.tour_type !== 'LIVRAISON' && (
          <span className="text-[9px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: '#6366f122', color: '#6366f1' }} title={tour.destination ?? ''}>
            {TOUR_TYPE_LABELS[tour.tour_type]}
          </span>
        )}
        {tour.device_assignment_id ? (
          (tour.status === 'DRAFT' || tour.status === 'VALIDATED') ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUnassignDevice() }}
              className="text-[9px] px-1 py-0.5 rounded font-bold cursor-pointer border-0 transition-all hover:opacity-70"
              style={{ backgroundColor: '#3b82f622', color: '#3b82f6' }}
              title="Cliquer pour desaffecter le telephone"
            >TEL ✕</button>
          ) : (
            <span className="text-[9px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: '#3b82f622', color: '#3b82f6' }}>TEL</span>
          )
        ) : null}
      </span>
    ),
    vehicle: <span className="truncate" title={vehicleLabel}>{vehicleLabel}</span>,
    driver: <span className="truncate">{tour.driver_name || '—'}</span>,
    departure: <span className="font-mono text-xs">{tour.departure_time}</span>,
    priority: <span className="font-semibold" style={{ color: tour.priority != null ? 'var(--color-primary)' : 'var(--text-muted)' }}>{tour.priority ?? '—'}</span>,
    stops: <>{tour.stops.length}</>,
    eqc: <>{eqc}</>,
    delay: <DelayBadge delay={tour.delay_minutes} color={color} t={t} />,
    exit: <span className="font-mono text-xs" style={{ color: tour.barrier_exit_time ? 'var(--text-primary)' : 'var(--text-muted)' }}>{displayDateTime(tour.barrier_exit_time)}</span>,
  }

  return (
    <>
      <tr
        className="border-t cursor-pointer transition-colors"
        style={{ borderColor: 'var(--border-color)', backgroundColor: isExpanded ? 'rgba(249,115,22,0.06)' : undefined }}
        onClick={onToggle}
        onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.backgroundColor = 'var(--bg-hover)' }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = isExpanded ? 'rgba(249,115,22,0.06)' : 'transparent' }}
      >
        {visibleCols.map((col) => (
          <td key={col.key} className={`px-3 py-2 whitespace-nowrap ${col.align === 'center' ? 'text-center' : ''}`} style={{ color: 'var(--text-primary)' }}>
            {cells[col.key]}
          </td>
        ))}
      </tr>

      {/* Détail déplié / Expanded detail */}
      {isExpanded && form && (
        <tr style={{ backgroundColor: 'rgba(249,115,22,0.03)' }}>
          <td colSpan={colCount} className="px-3 py-3 whitespace-nowrap">
            {/* Info répartition + livraison / Dispatch + delivery info */}
            {(() => {
              const tourVolumes = volumes.filter((v) => v.tour_id === tour.id)
              const dispatchVol = tourVolumes.find((v) => v.dispatch_date)
              return (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs px-1 py-1.5 rounded-lg" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                  {dispatchVol && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {t('tourPlanning.dispatchInfo')} <strong style={{ color: 'var(--text-primary)' }}>{formatDate(dispatchVol.dispatch_date)}{dispatchVol.dispatch_time ? ` ${dispatchVol.dispatch_time}` : ''}</strong>
                    </span>
                  )}
                  {tour.delivery_date && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {t('tourPlanning.deliveryDate')}: <strong style={{ color: 'var(--text-primary)' }}>{formatDate(tour.delivery_date)}</strong>
                    </span>
                  )}
                  <span style={{ color: 'var(--text-muted)' }}>
                    {t('tourPlanning.departureTime')}: <strong style={{ color: 'var(--text-primary)' }}>{tour.departure_time ?? '—'}</strong>
                  </span>
                </div>
              )
            })()}
            {/* Arrêts / Stops */}
            <div className="mb-3 overflow-x-auto">
              <table className="w-full text-xs" style={{ tableLayout: 'auto' }}>
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>#</th>
                    <th className="px-2 py-1 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>PDV</th>
                    <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{t('operations.planned')}</th>
                    <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{t('operations.estimated')}</th>
                    <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQC</th>
                    <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{t('operations.pickups')}</th>
                    {canModifyStops && !tour.departure_signal_time && (tour.status === 'DRAFT' || tour.status === 'VALIDATED') && (
                      <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}></th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {tour.estimated_stops
                    .sort((a, b) => a.sequence_order - b.sequence_order)
                    .map((stop) => {
                      const pdv = pdvMap.get(stop.pdv_id)
                      const pickups = [
                        stop.pickup_cardboard && 'C',
                        stop.pickup_containers && 'B',
                        stop.pickup_returns && 'R',
                      ].filter(Boolean).join(' ')
                      const stopDispatch = volumes.find((v) => v.tour_id === tour.id && v.pdv_id === stop.pdv_id && v.dispatch_date)
                      /* Temperatures distinctes des volumes de ce stop, fallback sur le stop lui-meme /
                         Distinct temperatures from this stop's volumes, fallback on the stop field */
                      const stopTemps: TemperatureClass[] = (() => {
                        const fromVolumes = volumes
                          .filter((v) => v.tour_id === tour.id && v.pdv_id === stop.pdv_id)
                          .map((v) => v.temperature_class)
                        const distinct = Array.from(new Set(fromVolumes))
                        if (distinct.length > 0) return distinct
                        return stop.temperature_class ? [stop.temperature_class] : []
                      })()

                      return (
                        <tr key={stop.id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                          <td className="px-2 py-1 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{stop.sequence_order}</td>
                          <td className="px-2 py-1 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                            {stopTemps.map((tc) => (
                              <span
                                key={tc}
                                className="mr-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold align-middle"
                                style={{
                                  backgroundColor: `${TEMPERATURE_COLORS[tc]}25`,
                                  color: TEMPERATURE_COLORS[tc],
                                  border: `1px solid ${TEMPERATURE_COLORS[tc]}`,
                                }}
                                title={`Volume ${tc}`}
                              >
                                {tc}
                              </span>
                            ))}
                            <span className="font-semibold">{pdv?.code ?? ''}</span>
                            <span className="ml-1">{pdv?.name ?? `#${stop.pdv_id}`}</span>
                            {pdv?.city && <span className="ml-1" style={{ color: 'var(--text-muted)' }}>({pdv.city})</span>}
                            {stopDispatch && (
                              <span className="ml-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {t('tourPlanning.dispatchInfo')} {formatDate(stopDispatch.dispatch_date)}{stopDispatch.dispatch_time ? ` ${stopDispatch.dispatch_time}` : ''}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-center font-mono whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{stop.arrival_time ?? '—'}</td>
                          <td className="px-2 py-1 text-center font-mono font-semibold whitespace-nowrap" style={{ color: tour.delay_minutes > 0 ? color : 'var(--text-primary)' }}>
                            {stop.estimated_arrival ?? '—'}
                          </td>
                          <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{stop.eqp_count}</td>
                          <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: pickups ? 'var(--color-primary)' : 'var(--text-muted)' }}>
                            {pickups || '—'}
                          </td>
                          {canModifyStops && !tour.departure_signal_time && (tour.status === 'DRAFT' || tour.status === 'VALIDATED') && (
                            <td className="px-2 py-1 text-center whitespace-nowrap">
                              {tour.stops.length > 1 && (
                                <button
                                  className="text-[10px] px-1.5 py-0.5 rounded border font-semibold transition-all hover:opacity-80"
                                  style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
                                  onClick={(e) => { e.stopPropagation(); onRemoveStop(tour.id, stop.id, pdv?.code ?? '', stopTemps) }}
                                >
                                  Retirer
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  <tr className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                    <td className="px-2 py-1 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>&#8617;</td>
                    <td className="px-2 py-1 font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{t('tourPlanning.returnBase')}</td>
                    <td className="px-2 py-1 text-center font-mono whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{tour.return_time ?? '—'}</td>
                    <td className="px-2 py-1 text-center font-mono font-semibold whitespace-nowrap" style={{ color: tour.delay_minutes > 0 ? color : 'var(--text-primary)' }}>
                      {tour.estimated_return ?? '—'}
                    </td>
                    <td /><td />
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Bouton ajouter PDV / Add PDV button */}
            {canModifyStops && !tour.departure_signal_time && (tour.status === 'DRAFT' || tour.status === 'VALIDATED') && (
              <AddStopInline pdvs={pdvs} tourStopPdvIds={new Set(tour.stops.map((s) => s.pdv_id))} onAdd={(pdvId, eqpCount) => onAddStop(tour.id, pdvId, eqpCount)} />
            )}

            {/* Ligne 1 — Prépa semi / Trailer preparation */}
            <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: '2fr 0.8fr 1fr 1fr' }}>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Dispo semi</label>
                <div className="flex gap-1">
                  <input type="datetime-local" value={form.trailer_ready_time} onChange={(e) => onFormChange('trailer_ready_time', e.target.value)}
                    className="flex-1 min-w-0 px-1.5 py-1.5 rounded border text-xs"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    onClick={(e) => e.stopPropagation()} />
                  <button onClick={(e) => { e.stopPropagation(); onSetNow('trailer_ready_time') }}
                    className="px-1.5 rounded text-xs font-bold shrink-0" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }} title="Maintenant">&#9201;</button>
                </div>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: '#3b82f6' }}>T° dispo</label>
                <input type="number" step="0.1" value={form.trailer_ready_temp} onChange={(e) => onFormChange('trailer_ready_temp', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: '#3b82f6', color: 'var(--text-primary)' }}
                  placeholder="°C" onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>N° semi</label>
                <input type="text" value={form.trailer_number} onChange={(e) => onFormChange('trailer_number', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Porte quai</label>
                <input type="text" value={form.dock_door_number} onChange={(e) => onFormChange('dock_door_number', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
            </div>

            {/* Ligne 2 — Chargement / Loading */}
            <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: '1fr 1.5fr 2fr 0.8fr 0.8fr' }}>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Code charg.</label>
                <input type="text" value={form.loader_code} onChange={(e) => onFormChange('loader_code', e.target.value)}
                  onBlur={(e) => onLoaderLookup(e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Chargeur</label>
                <input type="text" value={form.loader_name} readOnly
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{t('operations.loadingEnd')}</label>
                <div className="flex gap-1">
                  <input type="datetime-local" value={form.loading_end_time} onChange={(e) => onFormChange('loading_end_time', e.target.value)}
                    className="flex-1 min-w-0 px-1.5 py-1.5 rounded border text-xs"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    onClick={(e) => e.stopPropagation()} />
                  <button onClick={(e) => { e.stopPropagation(); onSetNow('loading_end_time') }}
                    className="px-1.5 rounded text-xs font-bold shrink-0" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }} title="Maintenant">&#9201;</button>
                </div>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: '#3b82f6' }}>T° fin charg.</label>
                <input type="number" step="0.1" value={form.loading_end_temp} onChange={(e) => onFormChange('loading_end_temp', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: '#3b82f6', color: 'var(--text-primary)' }}
                  placeholder="°C" onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>EQC</label>
                <input type="number" value={form.eqp_loaded} readOnly
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
            </div>

            {/* Ligne 3 — Départ / Departure */}
            <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: '1.2fr 2fr 0.8fr 2fr 1.5fr' }}>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{t('operations.driverName')}</label>
                <input type="text" value={form.driver_name} onChange={(e) => onFormChange('driver_name', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{t('operations.driverArrival')}</label>
                <div className="flex gap-1">
                  <input type="datetime-local" value={form.driver_arrival_time} onChange={(e) => onFormChange('driver_arrival_time', e.target.value)}
                    className="flex-1 min-w-0 px-1.5 py-1.5 rounded border text-xs"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    onClick={(e) => e.stopPropagation()} />
                  <button onClick={(e) => { e.stopPropagation(); onSetNow('driver_arrival_time') }}
                    className="px-1.5 rounded text-xs font-bold shrink-0" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }} title="Maintenant">&#9201;</button>
                </div>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Poids</label>
                <input type="number" step="0.01" min="0" value={form.total_weight_kg} onChange={(e) => onFormChange('total_weight_kg', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  placeholder="kg" onClick={(e) => e.stopPropagation()} />
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Top départ</label>
                <div className="flex gap-1">
                  <input type="datetime-local" value={form.departure_signal_time} onChange={(e) => onFormChange('departure_signal_time', e.target.value)}
                    className="flex-1 min-w-0 px-1.5 py-1.5 rounded border text-xs"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    onClick={(e) => e.stopPropagation()} />
                  <button onClick={(e) => { e.stopPropagation(); onSetNow('departure_signal_time') }}
                    className="px-1.5 rounded text-xs font-bold shrink-0" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }} title="Maintenant">&#9201;</button>
                </div>
              </div>
              <div className="min-w-0">
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>{t('operations.remarks')}</label>
                <input type="text" value={form.remarks} onChange={(e) => onFormChange('remarks', e.target.value)}
                  className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  onClick={(e) => e.stopPropagation()} />
              </div>
            </div>

            {/* Remorque propre (mode propre ou mixte) / Own trailer (own or mixed mode) */}
            {(() => {
              // Mode propre = tractor_id set, pas de contract_id
              // Mode mixte = contract_id set, pas de vehicle_id initialement
              // Dans les deux cas le postier doit pouvoir assigner la remorque
              const isPropre = !!tour.tractor_id && !tour.contract_id
              const isMixte = !!tour.contract_id && !tour.vehicle_id
              const needsTrailer = isPropre || isMixte
              if (!needsTrailer || fleetVehicles.length === 0) return null
              const trailers = fleetVehicles.filter((v) =>
                v.fleet_vehicle_type === 'SEMI_REMORQUE' || v.fleet_vehicle_type === 'REMORQUE'
              )
              return (
                <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <div className="min-w-0">
                    <label className="block text-xs font-semibold mb-1" style={{ color: '#3b82f6' }}>
                      Remorque {isPropre ? '(propre)' : '(mixte)'}
                    </label>
                    <select value={form.vehicle_id} onChange={(e) => onFormChange('vehicle_id', e.target.value)}
                      className="w-full min-w-0 px-1.5 py-1.5 rounded border text-xs"
                      style={{ backgroundColor: 'var(--bg-primary)', borderColor: '#3b82f6', color: 'var(--text-primary)' }}
                      onClick={(e) => e.stopPropagation()}>
                      <option value="">— Choisir une remorque —</option>
                      {trailers.map((v) => (
                        <option key={v.id} value={v.id}>{v.code} — {v.name || v.license_plate || ''}</option>
                      ))}
                    </select>
                  </div>
                  <div className="min-w-0 flex items-end">
                    <span className="text-[10px] px-2 py-1.5 rounded" style={{ backgroundColor: isPropre ? '#8b5cf620' : '#f59e0b20', color: isPropre ? '#8b5cf6' : '#f59e0b' }}>
                      {isPropre ? 'Mode Propre — tracteur + chauffeur assignés' : 'Mode Mixte — tracteur presté'}
                    </span>
                  </div>
                </div>
              )
            })()}

            {/* Actions */}
            <div className="flex gap-2 justify-end">
              {tour.device_assignment_id ? (
                <>
                  <button onClick={(e) => { e.stopPropagation(); onAssignDevice() }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                    style={{ borderColor: '#22c55e', color: '#22c55e', backgroundColor: '#22c55e11' }}>Affecte</button>
                  {(tour.status === 'DRAFT' || tour.status === 'VALIDATED') && (
                    <button onClick={(e) => { e.stopPropagation(); onUnassignDevice() }}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                      style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}>Desaffecter</button>
                  )}
                </>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); onAssignDevice() }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                  style={{ borderColor: '#3b82f6', color: '#3b82f6' }}>Affecter tel.</button>
              )}
              <button onClick={(e) => { e.stopPropagation(); onRouteSheet() }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}>{t('operations.driverRoute')}</button>
              <button onClick={(e) => { e.stopPropagation(); onWaybill() }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}>{t('operations.waybill')}</button>
              <button onClick={(e) => { e.stopPropagation(); onSave() }} disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
                style={{ backgroundColor: 'var(--color-primary)', color: '#fff', opacity: saving ? 0.5 : 1 }}>{saving ? '...' : t('common.save')}</button>
            </div>

            {/* Manifeste WMS / WMS Manifest */}
            <ManifestSection tourId={tour.id} wmsTourCode={tour.wms_tour_code} stops={tour.stops} pdvMap={pdvMap} onImported={(eqcLoaded, eqcByPdv) => { onFormChange('eqp_loaded', String(eqcLoaded)); onPatchStopsEqc(eqcByPdv) }} />
          </td>
        </tr>
      )}
    </>
  )
}

/* ─── Section Manifeste WMS / WMS Manifest section ─── */

interface ManifestSummaryRow {
  pdv_code: string
  eqc_announced: number
  eqc_loaded: number
  supports_total: number
  supports_scanned: number
  lines: ManifestLine[]
}

function ManifestSection({ tourId, wmsTourCode, stops, pdvMap, onImported }: {
  tourId: number; wmsTourCode?: string; stops: Tour['stops']; pdvMap: Map<number, PDV>; onImported: (eqcLoaded: number, eqcByPdv: Record<string, number>) => void
}) {
  const [manifest, setManifest] = useState<ManifestLine[]>([])
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [expandedPdv, setExpandedPdv] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadManifest = useCallback(async () => {
    try {
      const res = await api.get<ManifestLine[]>(`/tours/${tourId}/manifest`)
      setManifest(res.data)
      setLoaded(true)
    } catch { /* no manifest */ setLoaded(true) }
  }, [tourId])

  useEffect(() => { loadManifest() }, [loadManifest])

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setImportMsg('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post<ManifestImportResult>(`/imports/manifest/${tourId}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const d = res.data
      setImportMsg(`${d.created} supports importes${d.skipped ? `, ${d.skipped} ignores (hors tour)` : ''} — ${d.total_rows} lignes${d.errors.length ? ` — ${d.errors.length} erreurs` : ''}`)
      // Recharger manifeste / Reload manifest
      const freshManifest = (await api.get<ManifestLine[]>(`/tours/${tourId}/manifest`)).data
      setManifest(freshManifest)
      // Construire EQC par PDV (arrondi) / Build EQC per PDV (rounded)
      const eqcByPdv: Record<string, number> = {}
      for (const ml of freshManifest) {
        const code = ml.pdv_code.trim()
        eqcByPdv[code] = Math.round((eqcByPdv[code] ?? 0) + ml.eqc)
      }
      const totalEqc = Object.values(eqcByPdv).reduce((s, v) => s + v, 0)
      onImported(totalEqc, eqcByPdv)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Erreur import'
      setImportMsg(msg)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // Construire le tableau comparaison par PDV / Build comparison table per PDV
  const summaryRows = useMemo<ManifestSummaryRow[]>(() => {
    if (!manifest.length) return []

    const announcedMap = new Map<string, number>()
    for (const stop of stops) {
      const pdv = pdvMap.get(stop.pdv_id)
      if (pdv) {
        const code = pdv.code.trim()
        announcedMap.set(code, (announcedMap.get(code) ?? 0) + stop.eqp_count)
      }
    }

    const grouped = new Map<string, ManifestLine[]>()
    for (const ml of manifest) {
      const code = ml.pdv_code.trim()
      const arr = grouped.get(code) ?? []
      arr.push(ml)
      grouped.set(code, arr)
    }

    const rows: ManifestSummaryRow[] = []
    const allCodes = new Set([...announcedMap.keys(), ...grouped.keys()])
    for (const code of [...allCodes].sort()) {
      const lines = grouped.get(code) ?? []
      rows.push({
        pdv_code: code,
        eqc_announced: announcedMap.get(code) ?? 0,
        eqc_loaded: lines.reduce((s, l) => s + l.eqc, 0),
        supports_total: lines.length,
        supports_scanned: lines.filter((l) => l.scanned).length,
        lines,
      })
    }
    return rows
  }, [manifest, stops, pdvMap])

  if (!loaded) return null

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>Manifeste WMS</span>
        {wmsTourCode && (
          <span className="text-xs px-1.5 py-0.5 rounded font-mono font-semibold" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }}>
            WMS {wmsTourCode}
          </span>
        )}
        <label
          className="px-3 py-1 rounded-lg text-xs font-semibold border cursor-pointer transition-all hover:opacity-80"
          style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {importing ? '...' : manifest.length ? 'Reimporter .xls' : 'Importer .xls'}
          <input ref={fileRef} type="file" accept=".xls" className="hidden" onChange={handleImport} onClick={(e) => e.stopPropagation()} />
        </label>
        {importMsg && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{importMsg}</span>}
        {manifest.length > 0 && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {manifest.length} supports — {manifest.filter((m) => m.scanned).length} scannes
          </span>
        )}
      </div>

      {summaryRows.length > 0 && (
        <table className="w-full text-xs mb-1" style={{ tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th className="px-2 py-1 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>PDV</th>
              <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQC annonce</th>
              <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQC charge</th>
              <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Supports</th>
              <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Scannes</th>
              <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Statut</th>
            </tr>
          </thead>
          <tbody>
            {summaryRows.map((row) => {
              const noManifest = row.supports_total === 0 && row.eqc_announced > 0
              const allScanned = row.supports_total > 0 && row.supports_scanned === row.supports_total
              const someScanned = row.supports_scanned > 0 && row.supports_scanned < row.supports_total
              const statusColor = noManifest ? '#ef4444' : allScanned ? '#22c55e' : someScanned ? '#f59e0b' : '#3b82f6'
              const statusLabel = noManifest ? 'Manquant' : allScanned ? 'Livre' : someScanned ? 'En cours' : 'Charge'
              const isOpen = expandedPdv === row.pdv_code
              return (
                <Fragment key={row.pdv_code}>
                  <tr
                    className="border-t cursor-pointer transition-colors hover:opacity-80"
                    style={{ borderColor: 'var(--border-color)' }}
                    onClick={(e) => { e.stopPropagation(); setExpandedPdv(isOpen ? null : row.pdv_code) }}
                  >
                    <td className="px-2 py-1 font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      <span className="text-[10px] mr-1" style={{ color: 'var(--text-muted)' }}>{isOpen ? '▾' : '▸'}</span>
                      {row.pdv_code}
                    </td>
                    <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{row.eqc_announced}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: Math.abs(row.eqc_announced - row.eqc_loaded) < 0.01 ? 'var(--text-primary)' : '#f59e0b' }}>{row.eqc_loaded.toFixed(2)}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{row.supports_total}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: row.supports_scanned === row.supports_total && row.supports_total > 0 ? '#22c55e' : 'var(--text-muted)' }}>
                      {row.supports_scanned}/{row.supports_total}
                    </td>
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: `${statusColor}18`, color: statusColor }}>
                        {statusLabel}
                      </span>
                    </td>
                  </tr>
                  {isOpen && row.lines.length > 0 && (
                    <tr>
                      <td colSpan={6} className="px-2 py-1 whitespace-nowrap" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr>
                              <th className="px-2 py-0.5 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>N° Support</th>
                              <th className="px-2 py-0.5 text-left font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Libelle</th>
                              <th className="px-2 py-0.5 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQC</th>
                              <th className="px-2 py-0.5 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Colis</th>
                              <th className="px-2 py-0.5 text-center font-semibold whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Scan</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.lines.map((line) => (
                              <tr key={line.id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                                <td className="px-2 py-0.5 font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{line.support_number}</td>
                                <td className="px-2 py-0.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{line.support_label || '—'}</td>
                                <td className="px-2 py-0.5 text-center whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{line.eqc}</td>
                                <td className="px-2 py-0.5 text-center whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{line.nb_colis}</td>
                                <td className="px-2 py-0.5 text-center whitespace-nowrap">
                                  {line.scanned
                                    ? <span style={{ color: '#22c55e' }}>&#10003;</span>
                                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ─── Badge retard / Delay badge ─── */

function DelayBadge({ delay, color, t }: { delay: number; color: string; t: (k: string) => string }) {
  if (delay <= 0) {
    return <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold" style={{ color: '#22c55e' }}>{t('operations.onTime')}</span>
  }
  return <span className="text-xs px-1.5 py-0.5 rounded-full font-bold" style={{ backgroundColor: `${color}18`, color }}>+{delay}&#8242;</span>
}
