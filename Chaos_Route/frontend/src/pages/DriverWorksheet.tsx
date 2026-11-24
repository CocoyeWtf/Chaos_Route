/* Feuille de travail — placer les chauffeurs (#89 / #111) /
   Driver worksheet — place base drivers on the day's tours by drag & drop.

   V1 : une feuille large des tournées du jour (N° | H.Dép | Chauffeur | Trac |
   Semi | Départ | Arrivée | PDV n + E.Pn | Eqc | Km | T.Tour | Retour | Coût),
   un panneau « Chauffeurs » à droite (Tours / Km / Reste sur 12:00), et un
   glisser-déposer qui crée des affectations EN ATTENTE, contrôlées puis
   validées en lot via POST /api/tours/assign-drivers (dry_run puis ferme).

   Phase 2 (hors V1, volontairement non construit) :
   - calendrier de présence hebdomadaire des chauffeurs ;
   - déplacer des PDV d'une tournée à l'autre ;
   - glisser une tournée entière pour réordonner la feuille ;
   - choix du type de semi ;
   - fenêtres détachables ;
   - export Excel de la feuille.
*/

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/useAppStore'
import { useAuthStore } from '../stores/useAuthStore'
import api from '../services/api'
import { driverWorksOn } from '../types'
import type { Tour, BaseLogistics, Contract, PDV, Vehicle, BaseDriver } from '../types'

/* Journée de référence d'un chauffeur : 12 h / Driver's reference day: 12 h */
const DAY_MINUTES = 12 * 60

/* Type MIME du glisser-déposer / Drag & drop payload type */
const DND_TYPE = 'application/x-chaos-driver'

/* Affectation en attente : null = retirer le chauffeur / Pending: null = clear */
interface PendingAssignment {
  driver_name: string | null
  driver_code_infolog: string | null
}

interface AssignAlert {
  type: 'CHEVAUCHEMENT' | 'REPOS' | string
  driver_name: string
  tour_codes: string[]
  message: string
}

interface AssignResponse {
  dry_run: boolean
  modifies?: number
  alertes: AssignAlert[]
  recap: Record<string, { tours: number; minutes: number; km: number }>
  introuvables: number[]
}

/* Alerte rédigée pour l'écran / Alert phrased for display */
interface DisplayAlert {
  kind: string
  tourCode: string
  text: string
}

/* Minutes -> « H:MM » (négatif accepté) / Minutes -> "H:MM" (negative allowed) */
function fmtHM(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return '—'
  const sign = min < 0 ? '-' : ''
  const abs = Math.round(Math.abs(min))
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

function fmtKm(km: number | null | undefined): string {
  return km == null ? '—' : Math.round(km).toLocaleString('fr-FR')
}

function fmtCost(c: number | null | undefined): string {
  return c == null ? '—' : `${c.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`
}

function fmtEqc(e: number | null | undefined): string {
  if (e == null) return ''
  return Number.isInteger(e) ? String(e) : e.toFixed(1)
}

function driverDisplayName(d: BaseDriver): string {
  return `${d.last_name} ${d.first_name}`
}

/* Message en clair d'une erreur API / Plain message from an API error */
function apiErrorMessage(e: unknown): string {
  const err = e as { response?: { data?: { detail?: unknown } }; message?: string }
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return err?.message || 'Erreur inconnue'
}

/* Style commun des champs / Shared input style */
const INPUT_STYLE = { backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }

/* Largeurs des colonnes figées (sticky) / Sticky column widths */
const W_CODE = 88
const W_TIME = 52
const W_DRIVER = 170

export default function DriverWorksheet() {
  const { selectedRegionId } = useAppStore()
  const canUpdate = useAuthStore((s) => s.hasPermission('tour-planning', 'update'))

  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [baseFilter, setBaseFilter] = useState<number | ''>('')
  const [driverBaseFilter, setDriverBaseFilter] = useState<number | ''>('')
  const [driverSearch, setDriverSearch] = useState('')
  const [hideNoTimeLeft, setHideNoTimeLeft] = useState(false)

  const regionParams = selectedRegionId ? { region_id: selectedRegionId } : undefined
  const { data: bases } = useApi<BaseLogistics>('/bases', regionParams)
  const { data: contracts } = useApi<Contract>('/contracts', regionParams)
  const { data: pdvs } = useApi<PDV>('/pdvs', regionParams)
  const { data: vehicles } = useApi<Vehicle>('/vehicles', regionParams)
  const { data: baseDrivers } = useApi<BaseDriver>('/base-drivers')

  const baseMap = useMemo(() => new Map(bases.map((b) => [b.id, b])), [bases])
  const contractMap = useMemo(() => new Map(contracts.map((c) => [c.id, c])), [contracts])
  const pdvMap = useMemo(() => new Map(pdvs.map((p) => [p.id, p])), [pdvs])
  const vehicleMap = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles])

  /* Tournées du jour / Day's tours */
  const [tours, setTours] = useState<Tour[]>([])
  const [loadingTours, setLoadingTours] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  /* Affectations en attente, par tournée / Pending assignments per tour */
  const [pending, setPending] = useState<Map<number, PendingAssignment>>(new Map())
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  /* Résultat du dernier contrôle (null = pas encore contrôlé) / Last check result */
  const [checkAlerts, setCheckAlerts] = useState<DisplayAlert[] | null>(null)
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  /* Survol de dépôt / Drop hover */
  const [dropTourId, setDropTourId] = useState<number | null>(null)

  /* Ignorer une réponse arrivée après un changement de date / Drop stale responses */
  const loadSeq = useRef(0)
  const loadTours = useCallback(async () => {
    if (!selectedDate) return
    const seq = ++loadSeq.current
    setLoadingTours(true)
    setLoadError(null)
    try {
      /* limit explicite : l'endpoint plafonne à 200 par défaut (cf. TourScheduler). /
         Explicit limit: the endpoint defaults to 200. */
      const { data } = await api.get<Tour[]>('/tours/', { params: { date: selectedDate, limit: 2000 } })
      if (seq === loadSeq.current) setTours(data)
    } catch (e) {
      if (seq === loadSeq.current) {
        setTours([])
        setLoadError(apiErrorMessage(e))
      }
    } finally {
      if (seq === loadSeq.current) setLoadingTours(false)
    }
  }, [selectedDate])

  useEffect(() => {
    loadTours()
  }, [loadTours])

  /* Changer de date abandonne les affectations en attente (elles visent d'autres
     tournées). / Changing the date drops pending assignments. */
  const changeDate = (d: string) => {
    if (pending.size > 0 && !window.confirm(`${pending.size} affectation(s) en attente seront abandonnées. Continuer ?`)) return
    setPending(new Map())
    setCheckAlerts(null)
    setFlash(null)
    setSelectedDate(d)
  }

  const changeBase = (v: number | '') => {
    setBaseFilter(v)
    /* Le panneau chauffeurs suit la base de la feuille / Driver panel follows */
    setDriverBaseFilter(v)
  }

  /* Chauffeur effectif d'une tournée (attente prioritaire) / Effective driver */
  const effectiveDriver = useCallback((t: Tour): string | null => {
    const p = pending.get(t.id)
    if (p) return p.driver_name
    return t.driver_name || null
  }, [pending])

  /* Tournées affichées, triées par heure de départ puis code /
     Displayed tours, sorted by departure time then code */
  const visibleTours = useMemo(() => {
    const list = baseFilter === '' ? tours : tours.filter((t) => t.base_id === baseFilter)
    return [...list].sort((a, b) => {
      const ta = a.departure_time || '99:99'
      const tb = b.departure_time || '99:99'
      if (ta !== tb) return ta < tb ? -1 : 1
      return (a.code || '').localeCompare(b.code || '')
    })
  }, [tours, baseFilter])

  const maxStops = useMemo(
    () => visibleTours.reduce((m, t) => Math.max(m, t.stops?.length ?? 0), 0),
    [visibleTours],
  )

  const totals = useMemo(() => ({
    count: visibleTours.length,
    km: visibleTours.reduce((s, t) => s + (t.total_km ?? 0), 0),
    cost: visibleTours.reduce((s, t) => s + (t.total_cost ?? 0), 0),
  }), [visibleTours])

  /* Charge par chauffeur sur TOUTES les tournées du jour (pas seulement la base
     filtrée), affectations en attente comprises. / Load per driver over all the
     day's tours, pending assignments included. */
  const driverLoad = useMemo(() => {
    const m = new Map<string, { tours: number; km: number; minutes: number; tractor: string | null }>()
    for (const t of tours) {
      const name = effectiveDriver(t)
      if (!name) continue
      const cur = m.get(name) ?? { tours: 0, km: 0, minutes: 0, tractor: null }
      cur.tours += 1
      cur.km += t.total_km ?? 0
      cur.minutes += t.total_duration_minutes ?? 0
      if (!cur.tractor && t.tractor_id) cur.tractor = vehicleMap.get(t.tractor_id)?.code ?? null
      m.set(name, cur)
    }
    return m
  }, [tours, effectiveDriver, vehicleMap])

  const driverByName = useMemo(
    () => new Map(baseDrivers.map((d) => [driverDisplayName(d), d])),
    [baseDrivers],
  )

  /* Liste du panneau chauffeurs / Driver panel rows */
  const driverRows = useMemo(() => {
    const q = driverSearch.trim().toLowerCase()
    return baseDrivers
      .filter((d) => d.status === 'ACTIVE')
      .filter((d) => driverBaseFilter === '' || d.base_id === driverBaseFilter)
      .map((d) => {
        const name = driverDisplayName(d)
        const load = driverLoad.get(name)
        const minutes = load?.minutes ?? 0
        return {
          driver: d,
          name,
          tours: load?.tours ?? 0,
          km: load?.km ?? 0,
          remaining: DAY_MINUTES - minutes,
          tractor: load?.tractor ?? null,
          works: driverWorksOn(d.work_days, selectedDate),
        }
      })
      .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.driver.code_infolog || '').toLowerCase().includes(q))
      .filter((r) => !hideNoTimeLeft || r.remaining > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [baseDrivers, driverBaseFilter, driverSearch, hideNoTimeLeft, driverLoad, selectedDate])

  /* --- Affectations en attente / Pending assignments --- */

  const setPendingFor = (tour: Tour, value: PendingAssignment | undefined) => {
    setPending((prev) => {
      const next = new Map(prev)
      /* Revenir à l'état d'origine = retirer de l'attente / Back to original = drop */
      if (value === undefined || (value.driver_name || null) === (tour.driver_name || null)) next.delete(tour.id)
      else next.set(tour.id, value)
      return next
    })
    setCheckAlerts(null)
    setFlash(null)
  }

  const assignDriverToTour = (tourId: number, driverId: number) => {
    const tour = tours.find((t) => t.id === tourId)
    const driver = baseDrivers.find((d) => d.id === driverId)
    if (!tour || !driver) return
    setPendingFor(tour, { driver_name: driverDisplayName(driver), driver_code_infolog: driver.code_infolog || null })
  }

  /* --- Glisser-déposer natif / Native drag & drop --- */

  const onDriverDragStart = (e: DragEvent<HTMLElement>, d: BaseDriver, remaining: number) => {
    e.dataTransfer.setData(DND_TYPE, String(d.id))
    e.dataTransfer.setData('text/plain', driverDisplayName(d))
    e.dataTransfer.effectAllowed = 'copy'
    /* Fantôme « 365 - BLAIMONT (reste 12:00) » / Custom drag ghost */
    const ghost = document.createElement('div')
    ghost.textContent = `${d.code_infolog ? `${d.code_infolog} - ` : ''}${d.last_name} (reste ${fmtHM(remaining)})`
    Object.assign(ghost.style, {
      position: 'fixed', top: '-1000px', left: '-1000px', padding: '4px 10px',
      background: '#f97316', color: '#fff', fontSize: '12px', fontWeight: '700',
      borderRadius: '6px', whiteSpace: 'nowrap', fontFamily: 'sans-serif',
    })
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 10, 10)
    setTimeout(() => ghost.remove(), 0)
  }

  const onTourDragOver = (e: DragEvent<HTMLTableRowElement>, tourId: number) => {
    if (!canUpdate || !e.dataTransfer.types.includes(DND_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (dropTourId !== tourId) setDropTourId(tourId)
  }

  const onTourDrop = (e: DragEvent<HTMLTableRowElement>, tourId: number) => {
    e.preventDefault()
    setDropTourId(null)
    const id = Number(e.dataTransfer.getData(DND_TYPE))
    if (id) assignDriverToTour(tourId, id)
  }

  /* --- Contrôle et validation / Check and commit --- */

  const buildPayload = (dryRun: boolean) => ({
    dry_run: dryRun,
    assignments: [...pending.entries()].map(([tour_id, p]) => ({
      tour_id,
      driver_name: p.driver_name,
      driver_code_infolog: p.driver_code_infolog,
    })),
  })

  /* Rédiger les alertes du serveur + contrôles locaux / Phrase server alerts + local checks */
  const toDisplayAlerts = (res: AssignResponse): DisplayAlert[] => {
    const out: DisplayAlert[] = []
    for (const a of res.alertes) {
      if (a.type === 'CHEVAUCHEMENT') {
        const [c1, c2] = a.tour_codes
        out.push({ kind: 'Chevauchement', tourCode: c1, text: `${a.driver_name} est aussi sur ${c2} aux mêmes heures.` })
      } else if (a.type === 'REPOS') {
        const d = driverByName.get(a.driver_name)
        out.push({
          kind: 'Repos',
          tourCode: a.tour_codes[0] ?? '',
          text: `${a.driver_name} ne travaille pas ce jour-là${d?.work_days ? ` (régime : ${d.work_days})` : ''}.`,
        })
      } else {
        out.push({ kind: a.type, tourCode: a.tour_codes.join(', '), text: a.message })
      }
    }
    for (const id of res.introuvables) {
      out.push({ kind: 'Introuvable', tourCode: `#${id}`, text: 'Cette tournée n’existe plus (supprimée entre-temps ?).' })
    }
    /* Contrôles locaux : dépassement de 12 h (une fois par chauffeur), tournée
       prestée / Local checks: over 12 h (once per driver), subcontracted tour */
    const overtimeSeen = new Set<string>()
    for (const [tourId, p] of pending) {
      const t = tours.find((x) => x.id === tourId)
      if (!t || !p.driver_name) continue
      const load = driverLoad.get(p.driver_name)
      if (load && load.minutes > DAY_MINUTES && !overtimeSeen.has(p.driver_name)) {
        overtimeSeen.add(p.driver_name)
        out.push({ kind: 'Temps', tourCode: t.code, text: `${p.driver_name} dépasse 12:00 sur la journée (${fmtHM(load.minutes)}).` })
      }
      if (t.contract_id && !t.vehicle_id && !t.tractor_id) {
        const c = contractMap.get(t.contract_id)
        out.push({ kind: 'Prestée', tourCode: t.code, text: `Tournée confiée au transporteur${c ? ` ${c.code}` : ''} : vérifier qu’un chauffeur base doit bien y être.` })
      }
    }
    return out.sort((a, b) => a.tourCode.localeCompare(b.tourCode))
  }

  const handleCheck = async () => {
    if (pending.size === 0) return
    setChecking(true)
    setFlash(null)
    try {
      const { data } = await api.post<AssignResponse>('/tours/assign-drivers', buildPayload(true))
      setCheckAlerts(toDisplayAlerts(data))
    } catch (e) {
      setFlash({ kind: 'error', text: `Contrôle impossible : ${apiErrorMessage(e)}` })
    } finally {
      setChecking(false)
    }
  }

  const handleValidate = async () => {
    if (pending.size === 0) return
    setSaving(true)
    setFlash(null)
    try {
      const { data } = await api.post<AssignResponse>('/tours/assign-drivers', buildPayload(false))
      const alerts = toDisplayAlerts(data)
      setPending(new Map())
      setCheckAlerts(alerts.length > 0 ? alerts : null)
      setFlash({
        kind: 'ok',
        text: `${data.modifies ?? 0} tournée(s) mise(s) à jour${alerts.length > 0 ? ` — ${alerts.length} alerte(s) à garder en tête` : ''}.`,
      })
      await loadTours()
    } catch (e) {
      setFlash({ kind: 'error', text: `Validation impossible : ${apiErrorMessage(e)}` })
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setPending(new Map())
    setCheckAlerts(null)
    setFlash(null)
  }

  /* --- Rendu / Render --- */

  const th = 'px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap text-left border-b'
  const td = 'px-2 py-1 text-xs whitespace-nowrap border-b'
  const stickyTh = (left: number, width: number) => ({
    position: 'sticky' as const, left, zIndex: 3, minWidth: width, maxWidth: width, width,
    backgroundColor: 'var(--bg-tertiary)',
  })
  const stickyTd = (left: number, width: number, bg: string) => ({
    position: 'sticky' as const, left, zIndex: 1, minWidth: width, maxWidth: width, width, backgroundColor: bg,
  })

  return (
    <div className="flex flex-col gap-3" style={{ color: 'var(--text-primary)' }}>
      {/* En-tête / Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Feuille de travail</h1>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Glisser un chauffeur du panneau de droite sur une tournée, contrôler, puis valider.
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Date de planification</label>
            <input type="date" value={selectedDate} onChange={(e) => changeDate(e.target.value)}
              className="px-3 py-1.5 rounded-lg border text-sm" style={INPUT_STYLE} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Base</label>
            <select value={baseFilter} onChange={(e) => changeBase(e.target.value ? Number(e.target.value) : '')}
              className="px-3 py-1.5 rounded-lg border text-sm" style={INPUT_STYLE}>
              <option value="">Toutes les bases</option>
              {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
            </select>
          </div>
          <button onClick={loadTours} className="px-3 py-1.5 rounded-lg border text-sm hover:opacity-80"
            style={{ ...INPUT_STYLE, color: 'var(--text-secondary)' }} title="Recharger les tournées">
            ↻
          </button>
          <div className="px-3 py-1.5 rounded-lg text-sm font-semibold" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            {totals.count} tournée{totals.count > 1 ? 's' : ''} · {fmtKm(totals.km)} km · {fmtCost(totals.cost)}
          </div>
        </div>
      </div>

      {/* Barre des affectations en attente / Pending bar */}
      {(pending.size > 0 || flash || checkAlerts) && (
        <div className="rounded-lg border p-2 flex flex-col gap-2" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: pending.size > 0 ? 'var(--color-primary)' : 'var(--border-color)' }}>
          <div className="flex items-center gap-3 flex-wrap">
            {pending.size > 0 && (
              <>
                <span className="text-sm font-semibold" style={{ color: 'var(--color-primary)' }}>
                  {pending.size} affectation{pending.size > 1 ? 's' : ''} en attente
                </span>
                <button onClick={handleCheck} disabled={checking || saving}
                  className="px-3 py-1 rounded-lg border text-sm hover:opacity-80 disabled:opacity-50"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)', backgroundColor: 'var(--bg-tertiary)' }}>
                  {checking ? 'Contrôle…' : 'Contrôler'}
                </button>
                <button onClick={handleValidate} disabled={checking || saving}
                  className="px-3 py-1 rounded-lg text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-primary)' }}>
                  {saving ? 'Validation…' : 'Valider'}
                </button>
                <button onClick={handleCancel} disabled={checking || saving}
                  className="px-3 py-1 rounded-lg border text-sm hover:opacity-80 disabled:opacity-50"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
                  Annuler
                </button>
              </>
            )}
            {flash && (
              <span className="text-sm" style={{ color: flash.kind === 'ok' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {flash.text}
              </span>
            )}
          </div>
          {checkAlerts && (
            checkAlerts.length === 0 ? (
              <div className="text-sm" style={{ color: 'var(--color-success)' }}>✓ Aucune alerte : les affectations peuvent être validées.</div>
            ) : (
              <ul className="text-xs flex flex-col gap-0.5 max-h-40 overflow-auto">
                {checkAlerts.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-bold shrink-0" style={{ minWidth: 70 }}>{a.tourCode}</span>
                    <span className="font-semibold shrink-0 px-1.5 rounded" style={{
                      backgroundColor: a.kind === 'Chevauchement' || a.kind === 'Introuvable' ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.15)',
                      color: a.kind === 'Chevauchement' || a.kind === 'Introuvable' ? 'var(--color-danger)' : 'var(--color-warning)',
                    }}>{a.kind}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{a.text}</span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

      <div className="flex gap-3 items-start">
        {/* Tableau des tournées / Tours table */}
        <div className="flex-1 min-w-0 rounded-lg border overflow-auto" style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-secondary)', maxHeight: 'calc(100vh - 220px)' }}>
          {loadError ? (
            <div className="p-4 text-sm" style={{ color: 'var(--color-danger)' }}>Chargement impossible : {loadError}</div>
          ) : visibleTours.length === 0 ? (
            <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              {loadingTours ? 'Chargement…' : 'Aucune tournée pour cette date.'}
            </div>
          ) : (
            <table className="border-separate" style={{ borderSpacing: 0, borderColor: 'var(--border-color)' }}>
              <thead className="sticky top-0" style={{ zIndex: 4 }}>
                <tr style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                  <th className={th} style={{ ...stickyTh(0, W_CODE), borderColor: 'var(--border-color)' }}>N°</th>
                  <th className={th} style={{ ...stickyTh(W_CODE, W_TIME), borderColor: 'var(--border-color)' }}>H.Dép</th>
                  <th className={th} style={{ ...stickyTh(W_CODE + W_TIME, W_DRIVER), borderColor: 'var(--border-color)' }}>Chauffeur</th>
                  {['Trac', 'Semi', 'Départ', 'Arrivée'].map((h) => (
                    <th key={h} className={th} style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}>{h}</th>
                  ))}
                  {Array.from({ length: maxStops }, (_, i) => (
                    <th key={`pdv-${i}`} className={th} colSpan={2} style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}>
                      PDV {i + 1} <span className="opacity-70">/ E.P{i + 1}</span>
                    </th>
                  ))}
                  {['Eqc', 'Km', 'T.Tour', 'Retour', 'Coût'].map((h) => (
                    <th key={h} className={`${th} text-right`} style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleTours.map((t) => {
                  const p = pending.get(t.id)
                  const isDrop = dropTourId === t.id
                  const rowBg = isDrop ? 'rgba(249,115,22,0.18)' : 'var(--bg-secondary)'
                  const contract = t.contract_id ? contractMap.get(t.contract_id) : undefined
                  const depBase = baseMap.get(t.base_id)
                  const arrBase = baseMap.get(t.return_base_id ?? t.base_id)
                  const stops = [...(t.stops ?? [])].sort((a, b) => a.sequence_order - b.sequence_order)
                  const over = t.capacity_eqp != null && (t.total_eqp ?? 0) > t.capacity_eqp
                  const semi = t.trailer_number
                    || (t.vehicle_id ? vehicleMap.get(t.vehicle_id)?.code : undefined)
                    || (contract?.vehicle_code ?? '')
                  const cellBorder = { borderColor: 'var(--border-color)' }
                  return (
                    <tr
                      key={t.id}
                      onDragOver={(e) => onTourDragOver(e, t.id)}
                      onDragLeave={() => setDropTourId((cur) => (cur === t.id ? null : cur))}
                      onDrop={(e) => onTourDrop(e, t.id)}
                      style={{ backgroundColor: rowBg, outline: isDrop ? '2px solid var(--color-primary)' : undefined, outlineOffset: -2 }}
                    >
                      <td className={`${td} font-bold`} style={{ ...stickyTd(0, W_CODE, rowBg), ...cellBorder }} title={t.wms_tour_code ? `Infolog : ${t.wms_tour_code}` : undefined}>
                        {t.code}
                      </td>
                      <td className={td} style={{ ...stickyTd(W_CODE, W_TIME, rowBg), ...cellBorder }}>{t.departure_time || '—'}</td>
                      <td className={td} style={{ ...stickyTd(W_CODE + W_TIME, W_DRIVER, rowBg), ...cellBorder }}>
                        <DriverCell
                          tour={t}
                          pendingAssignment={p}
                          contractCode={contract?.code}
                          canUpdate={canUpdate}
                          onRevert={() => setPendingFor(t, undefined)}
                          onClear={() => setPendingFor(t, { driver_name: null, driver_code_infolog: null })}
                        />
                      </td>
                      <td className={td} style={cellBorder}>{t.tractor_id ? (vehicleMap.get(t.tractor_id)?.code ?? `#${t.tractor_id}`) : ''}</td>
                      <td className={td} style={cellBorder}>{semi}</td>
                      <td className={td} style={cellBorder} title={depBase?.name}>{depBase?.code ?? ''}</td>
                      <td className={td} style={cellBorder} title={arrBase?.name}>{arrBase?.code ?? ''}</td>
                      {Array.from({ length: maxStops }, (_, i) => {
                        const s = stops[i]
                        const pdv = s ? pdvMap.get(s.pdv_id) : undefined
                        return [
                          <td key={`p${i}`} className={td} style={{ ...cellBorder, borderLeft: '1px solid var(--border-color)' }} title={pdv?.name}>
                            {s ? (
                              <div className="leading-tight">
                                <div className="font-bold">{pdv?.code ?? `#${s.pdv_id}`}</div>
                                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{pdv?.city ?? ''}</div>
                              </div>
                            ) : null}
                          </td>,
                          <td key={`e${i}`} className={`${td} text-right`} style={{ ...cellBorder, color: 'var(--text-secondary)' }}>
                            {s ? fmtEqc(s.eqp_count) : ''}
                          </td>,
                        ]
                      })}
                      <td className={`${td} text-right font-semibold`} style={{
                        ...cellBorder,
                        color: over ? 'var(--color-danger)' : undefined,
                        backgroundColor: over ? 'rgba(239,68,68,0.12)' : undefined,
                      }} title={t.capacity_eqp != null ? `Capacité ${t.capacity_eqp}` : undefined}>
                        {fmtEqc(t.total_eqp ?? 0)}{t.capacity_eqp != null && <span className="opacity-60 font-normal">/{t.capacity_eqp}</span>}
                      </td>
                      <td className={`${td} text-right`} style={cellBorder}>{fmtKm(t.total_km)}</td>
                      <td className={`${td} text-right`} style={cellBorder}>{fmtHM(t.total_duration_minutes)}</td>
                      <td className={`${td} text-right`} style={cellBorder}>{t.return_time || '—'}</td>
                      <td className={`${td} text-right`} style={cellBorder}>{fmtCost(t.total_cost)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Panneau chauffeurs / Driver panel */}
        <div className="w-[340px] shrink-0 rounded-lg border flex flex-col" style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-secondary)', maxHeight: 'calc(100vh - 220px)' }}>
          <div className="p-2 border-b flex flex-col gap-2" style={{ borderColor: 'var(--border-color)' }}>
            <div className="text-sm font-bold">Chauffeurs</div>
            <select value={driverBaseFilter} onChange={(e) => setDriverBaseFilter(e.target.value ? Number(e.target.value) : '')}
              className="px-2 py-1 rounded border text-xs" style={INPUT_STYLE}>
              <option value="">Toutes les bases</option>
              {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
            </select>
            <input type="text" value={driverSearch} onChange={(e) => setDriverSearch(e.target.value)}
              placeholder="Rechercher (nom, code)…" className="px-2 py-1 rounded border text-xs" style={INPUT_STYLE} />
            <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={hideNoTimeLeft} onChange={(e) => setHideNoTimeLeft(e.target.checked)} className="accent-orange-500" />
              Masquer les chauffeurs sans temps restant
            </label>
          </div>
          <div className="overflow-auto flex-1">
            <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
              <thead className="sticky top-0" style={{ zIndex: 2 }}>
                <tr style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                  <th className={th} style={{ borderColor: 'var(--border-color)' }}>Trac</th>
                  <th className={th} style={{ borderColor: 'var(--border-color)' }}>Chauffeur</th>
                  <th className={`${th} text-right`} style={{ borderColor: 'var(--border-color)' }}>Tours</th>
                  <th className={`${th} text-right`} style={{ borderColor: 'var(--border-color)' }}>Km</th>
                  <th className={`${th} text-right`} style={{ borderColor: 'var(--border-color)' }}>Reste</th>
                </tr>
              </thead>
              <tbody>
                {driverRows.length === 0 ? (
                  <tr><td colSpan={5} className="p-3 text-xs" style={{ color: 'var(--text-muted)' }}>Aucun chauffeur.</td></tr>
                ) : driverRows.map((r) => (
                  <tr
                    key={r.driver.id}
                    draggable={canUpdate}
                    onDragStart={(e) => onDriverDragStart(e, r.driver, r.remaining)}
                    onDragEnd={() => setDropTourId(null)}
                    className={canUpdate ? 'cursor-grab hover:opacity-80' : ''}
                    style={{ opacity: r.works ? 1 : 0.55 }}
                    title={r.works ? `${r.driver.code_infolog || ''} — glisser sur une tournée` : `Repos ce jour (régime : ${r.driver.work_days})`}
                  >
                    <td className={td} style={{ borderColor: 'var(--border-color)' }}>{r.tractor ?? ''}</td>
                    <td className={td} style={{ borderColor: 'var(--border-color)' }}>
                      <span className="font-semibold">{r.name}</span>
                      {r.driver.code_infolog && <span className="ml-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>{r.driver.code_infolog}</span>}
                      {!r.works && <span className="ml-1 text-[10px] font-bold" style={{ color: 'var(--color-warning)' }}>repos</span>}
                    </td>
                    <td className={`${td} text-right`} style={{ borderColor: 'var(--border-color)' }}>{r.tours}</td>
                    <td className={`${td} text-right`} style={{ borderColor: 'var(--border-color)' }}>{fmtKm(r.km)}</td>
                    <td className={`${td} text-right font-semibold`} style={{
                      borderColor: 'var(--border-color)',
                      color: r.remaining < 0 ? 'var(--color-danger)' : r.remaining === 0 ? 'var(--text-muted)' : 'var(--color-success)',
                    }}>
                      {fmtHM(r.remaining)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

/* Cellule « Chauffeur » d'une tournée / Tour driver cell */
function DriverCell({ tour, pendingAssignment, contractCode, canUpdate, onRevert, onClear }: {
  tour: Tour
  pendingAssignment: PendingAssignment | undefined
  contractCode: string | undefined
  canUpdate: boolean
  onRevert: () => void
  onClear: () => void
}) {
  const btn = 'ml-1 px-1 text-[11px] leading-none rounded hover:opacity-70 shrink-0'
  if (pendingAssignment) {
    /* En attente : orange italique ; × annule l'attente / Pending: orange italic */
    return (
      <div className="flex items-center min-w-0">
        <span className="italic font-semibold truncate" style={{ color: 'var(--color-primary)' }}
          title={tour.driver_name ? `Avant : ${tour.driver_name}` : undefined}>
          {pendingAssignment.driver_name ?? <span className="line-through">{tour.driver_name}</span>}
          {!pendingAssignment.driver_name && ' (retiré)'}
        </span>
        <button className={btn} style={{ color: 'var(--color-primary)' }} onClick={onRevert} title="Annuler cette affectation en attente">×</button>
      </div>
    )
  }
  if (tour.driver_name) {
    return (
      <div className="flex items-center min-w-0">
        <span className="truncate font-semibold" title={tour.driver_name}>{tour.driver_name}</span>
        {canUpdate && (
          <button className={btn} style={{ color: 'var(--text-muted)' }} onClick={onClear} title="Retirer le chauffeur (en attente de validation)">×</button>
        )}
      </div>
    )
  }
  if (contractCode) {
    /* Tournée prestée : le « chauffeur » est le contrat / Subcontracted tour */
    return <span className="truncate" style={{ color: 'var(--text-secondary)' }} title="Contrat transporteur">{contractCode}</span>
  }
  return <span style={{ color: 'var(--text-muted)' }}>—</span>
}
