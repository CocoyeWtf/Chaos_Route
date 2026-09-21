/* Page Aide à la Décision Niveau 1 / Decision Support Level 1 page.
   Simulation pure : génère un plan affiché en tableau, sans créer de tours ni consommer de volumes. */

import { useState, useRef, useEffect, useCallback } from 'react'
import * as XLSX from 'xlsx'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import api from '../services/api'
import { useApi } from '../hooks/useApi'
import type { BaseLogistics } from '../types'

/* ── Types réponse API / API response types ── */

interface SuggestedStop {
  sequence_order: number
  pdv_id: number
  pdv_code: string
  pdv_name: string
  pdv_city: string | null
  eqp_count: number
  weight_kg: number
  nb_colis: number
  has_sas: boolean
  arrival_time: string | null
  departure_time: string | null
  distance_from_previous_km: number
  duration_from_previous_minutes: number
  deadline: string | null
  warnings: string[]
}

interface SuggestedContract {
  contract_id: number
  contract_code: string
  transporter_name: string
  vehicle_code: string | null
  vehicle_name: string | null
  vehicle_type: string | null
  temperature_type: string | null
  capacity_eqp: number
  has_tailgate: boolean
  tailgate_type: string | null
  score: number
  fill_rate_pct: number
}

interface SuggestedTour {
  tour_number: number
  contract: SuggestedContract | null
  stops: SuggestedStop[]
  total_eqp: number
  total_weight_kg: number
  total_km: number
  total_cost: number
  departure_time: string | null
  return_time: string | null
  total_duration_minutes: number
  warnings: string[]
}

interface UnassignedPDV {
  pdv_id: number
  pdv_code: string
  pdv_name: string
  pdv_city: string | null
  eqp_count: number
  reason: string
}

interface AideDecisionSummary {
  total_tours: number
  total_eqp: number
  total_weight_kg: number
  total_km: number
  total_cost: number
  avg_fill_rate_pct: number
}

interface AideDecisionResponse {
  dispatch_date: string
  base_origin_id: number
  base_name: string
  temperature_class: string
  tours: SuggestedTour[]
  unassigned_pdvs: UnassignedPDV[]
  summary: AideDecisionSummary
  warnings: string[]
}

/* ── Helpers ── */

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m}min`
}

function fillRateColor(rate: number): string {
  if (rate >= 85) return 'var(--color-success, #22c55e)'
  if (rate >= 60) return 'var(--color-primary)'
  return 'var(--color-danger, #ef4444)'
}

/* ── Critères d'optimisation / Optimization criteria ── */

const CRITERIA_META: Record<string, { label: string; description: string }> = {
  cost: { label: 'Cout', description: 'Minimiser le cout total' },
  punctuality: { label: 'Ponctualite', description: 'Minimiser les retards' },
  fill_rate: { label: 'Remplissage', description: 'Maximiser le remplissage' },
  num_tours: { label: 'Nb tours', description: 'Minimiser les vehicules' },
}

const RANK_LABELS = ['1er', '2e', '3e', '4e']

/* ── Composant principal / Main component ── */

export default function AideDecision() {
  const { data: bases } = useApi<BaseLogistics>('/bases')

  /* Filtres / Filters */
  const [dispatchDate, setDispatchDate] = useState(() => {
    const d = new Date()
    return d.toISOString().slice(0, 10)
  })
  const [baseOriginId, setBaseOriginId] = useState<number | ''>('')
  const [temperatureClass, setTemperatureClass] = useState('SEC')
  const [level, setLevel] = useState<1 | 2>(1)
  const [timeLimitSeconds, setTimeLimitSeconds] = useState(30)
  const [optimizationPriorities, setOptimizationPriorities] = useState([
    'cost', 'punctuality', 'fill_rate', 'num_tours',
  ])

  /* DnD sensors */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOptimizationPriorities((prev) => {
      const oldIndex = prev.indexOf(active.id as string)
      const newIndex = prev.indexOf(over.id as string)
      if (oldIndex === -1 || newIndex === -1) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }, [])

  /* Timer pour Niveau 2 / Timer for Level 2 */
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  /* Résultat / Result */
  const [result, setResult] = useState<AideDecisionResponse | null>(null)

  /* Export Excel de la simulation affichée (#42) : une feuille « Tours » avec
     une ligne par tournée suggérée, une feuille « Arrêts » avec le détail point
     de vente par point de vente, et une feuille des points de vente non placés —
     c'est souvent celle-là qui déclenche une décision. /
     Excel export of the displayed simulation: tours, stops, and — often the most
     useful — the PDVs that could not be placed. */
  const exportSimulation = useCallback(() => {
    if (!result) return
    const wb = XLSX.utils.book_new()

    const lignesTours = result.tours.map((tr) => ({
      'Tour': tr.tour_number,
      'Contrat': tr.contract?.contract_code ?? '',
      'Transporteur': tr.contract?.transporter_name ?? '',
      'Véhicule': tr.contract?.vehicle_type ?? '',
      'Arrêts': tr.stops.length,
      'EQC': tr.total_eqp,
      'Poids (kg)': tr.total_weight_kg,
      'Km': tr.total_km,
      'Coût (€)': tr.total_cost,
      'Départ': tr.departure_time ?? '',
      'Retour': tr.return_time ?? '',
      'Durée (min)': tr.total_duration_minutes,
      'Avertissements': tr.warnings.join(' ; '),
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignesTours), 'Tours')

    const lignesArrets = result.tours.flatMap((tr) =>
      tr.stops.map((st, i) => ({
        'Tour': tr.tour_number,
        'Ordre': i + 1,
        'PDV': st.pdv_code,
        'Nom': st.pdv_name,
        'Ville': st.pdv_city ?? '',
        'EQC': st.eqp_count,
        'Arrivée': st.arrival_time ?? '',
        'Départ': st.departure_time ?? '',
        'Km depuis précédent': st.distance_from_previous_km ?? '',
      })),
    )
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignesArrets), 'Arrêts')

    if (result.unassigned_pdvs.length > 0) {
      const lignesNonPlaces = result.unassigned_pdvs.map((p) => ({
        'PDV': p.pdv_code,
        'Nom': p.pdv_name,
        'Ville': p.pdv_city ?? '',
        'EQC': p.eqp_count,
        'Raison': p.reason,
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lignesNonPlaces), 'Non placés')
    }

    const nom = `aide_decision_${result.dispatch_date}_${result.base_name}_${result.temperature_class}`
      .replace(/[^a-zA-Z0-9_-]/g, '_')
    XLSX.writeFile(wb, `${nom}.xlsx`)
  }, [result])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* Lignes dépliées / Expanded rows */
  const [expandedTours, setExpandedTours] = useState<Set<number>>(new Set())

  const toggleExpand = (tourNumber: number) => {
    setExpandedTours((prev) => {
      const next = new Set(prev)
      if (next.has(tourNumber)) next.delete(tourNumber)
      else next.add(tourNumber)
      return next
    })
  }

  const expandAll = () => {
    if (!result) return
    if (expandedTours.size === result.tours.length) {
      setExpandedTours(new Set())
    } else {
      setExpandedTours(new Set(result.tours.map((t) => t.tour_number)))
    }
  }

  /* Générer la simulation / Generate simulation */
  const handleGenerate = async () => {
    if (!dispatchDate || !baseOriginId) return
    setLoading(true)
    setError(null)
    setResult(null)
    setExpandedTours(new Set())

    // Timer pour Niveau 2
    setElapsedSeconds(0)
    if (timerRef.current) clearInterval(timerRef.current)
    if (level === 2) {
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1)
      }, 1000)
    }

    try {
      const { data } = await api.post<AideDecisionResponse>('/aide-decision/generate', {
        dispatch_date: dispatchDate,
        base_origin_id: baseOriginId,
        temperature_class: temperatureClass,
        level,
        time_limit_seconds: timeLimitSeconds,
        optimization_priorities: level === 2 ? optimizationPriorities : undefined,
      })
      setResult(data)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue'
      setError(msg)
    } finally {
      setLoading(false)
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }

  return (
    <div className="p-4 space-y-4">
      {/* Titre / Title */}
      <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
        Aide à la décision
      </h1>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Simulation de construction de tournées — aucune donnée modifiée
      </p>

      {/* Filtres / Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
            Date dispatch
          </label>
          <input
            type="date"
            value={dispatchDate}
            onChange={(e) => setDispatchDate(e.target.value)}
            className="px-3 py-1.5 rounded border text-sm"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
            Base d'origine
          </label>
          <select
            value={baseOriginId}
            onChange={(e) => setBaseOriginId(e.target.value ? Number(e.target.value) : '')}
            className="px-3 py-1.5 rounded border text-sm"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="">-- Sélectionner --</option>
            {bases.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
            Température
          </label>
          <select
            value={temperatureClass}
            onChange={(e) => setTemperatureClass(e.target.value)}
            className="px-3 py-1.5 rounded border text-sm"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="SEC">SEC</option>
            <option value="FRAIS">FRAIS</option>
            <option value="GEL">GEL</option>
          </select>
        </div>

        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
            Niveau
          </label>
          <select
            value={level}
            onChange={(e) => setLevel(Number(e.target.value) as 1 | 2)}
            className="px-3 py-1.5 rounded border text-sm"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              borderColor: 'var(--border-color)',
              color: 'var(--text-primary)',
            }}
          >
            <option value={1}>N1 — Rapide (~1s)</option>
            <option value={2}>N2 — Optimisé (~30s)</option>
          </select>
        </div>

        {level === 2 && (
          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
              Limite (s)
            </label>
            <input
              type="number"
              min={5}
              max={120}
              value={timeLimitSeconds}
              onChange={(e) => setTimeLimitSeconds(Math.max(5, Math.min(120, Number(e.target.value))))}
              className="px-3 py-1.5 rounded border text-sm w-20"
              style={{
                backgroundColor: 'var(--bg-secondary)',
                borderColor: 'var(--border-color)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
        )}

        <button
          onClick={handleGenerate}
          disabled={loading || !dispatchDate || !baseOriginId}
          className="px-4 py-1.5 rounded text-sm font-semibold text-white transition-colors disabled:opacity-50"
          style={{ backgroundColor: 'var(--color-primary)' }}
        >
          {loading
            ? level === 2
              ? `Optimisation... ${elapsedSeconds}s`
              : 'Calcul en cours...'
            : 'Générer'}
        </button>
      </div>

      {/* Priorités d'optimisation N2 / Optimization priorities N2 */}
      {level === 2 && (
        <div>
          <label className="block text-xs mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            Priorites d'optimisation
          </label>
          <div
            className="rounded border p-1 w-full max-w-md"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={optimizationPriorities} strategy={verticalListSortingStrategy}>
                {optimizationPriorities.map((key, idx) => (
                  <SortableCriterion key={key} id={key} rank={RANK_LABELS[idx]} meta={CRITERIA_META[key]} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Glisser pour reordonner
          </p>
        </div>
      )}

      {/* Erreur / Error */}
      {error && (
        <div
          className="p-3 rounded border text-sm"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderColor: 'var(--color-danger, #ef4444)', color: 'var(--color-danger, #ef4444)' }}
        >
          {error}
        </div>
      )}

      {/* Warnings globaux / Global warnings */}
      {result && result.warnings.length > 0 && (
        <div
          className="p-3 rounded border text-sm space-y-1"
          style={{ backgroundColor: 'rgba(234,179,8,0.1)', borderColor: '#eab308', color: '#eab308' }}
        >
          {result.warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      {/* Résultat — Tableau des tours / Result — Tours table */}
      {result && result.tours.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Tours suggérés — {result.base_name} — {result.temperature_class} — {result.dispatch_date}
            </h2>
            <div className="flex items-center gap-2">
              {/* Export de la simulation (#42). Il part du résultat affiché plutôt
                  que d'interroger le serveur : relancer le calcul renverrait une
                  proposition potentiellement différente de celle qu'on a sous les
                  yeux, ce qui n'aurait aucun sens pour un export. /
                  Exports what is on screen: re-running the simulation could
                  return a different plan than the one being looked at. */}
              <button
                onClick={exportSimulation}
                className="text-xs px-2 py-1 rounded font-semibold"
                style={{ color: '#fff', backgroundColor: 'var(--color-success)' }}
                title="Exporter la simulation affichée en Excel"
              >
                Export Excel
              </button>
              <button
                onClick={expandAll}
                className="text-xs px-2 py-1 rounded"
                style={{ color: 'var(--color-primary)', backgroundColor: 'var(--bg-tertiary)' }}
              >
                {expandedTours.size === result.tours.length ? 'Tout replier' : 'Tout déplier'}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto rounded border" style={{ borderColor: 'var(--border-color)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}></th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Tour #</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Contrat / Véhicule</th>
                  <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>PDVs</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQP</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>KM</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Coût</th>
                  <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Départ</th>
                  <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Retour</th>
                  <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Durée</th>
                  <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Remplissage</th>
                  <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}></th>
                </tr>
              </thead>
              <tbody>
                {result.tours.map((tour) => {
                  const isExpanded = expandedTours.has(tour.tour_number)
                  const fillRate = tour.contract?.fill_rate_pct ?? 0
                  return (
                    <TourRow
                      key={tour.tour_number}
                      tour={tour}
                      isExpanded={isExpanded}
                      fillRate={fillRate}
                      onToggle={() => toggleExpand(tour.tour_number)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Résumé / Summary */}
      {result && result.tours.length > 0 && (
        <div
          className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3"
        >
          <SummaryCard label="Tours" value={result.summary.total_tours} />
          <SummaryCard label="EQP" value={result.summary.total_eqp} />
          <SummaryCard label="Poids (kg)" value={result.summary.total_weight_kg.toFixed(0)} />
          <SummaryCard label="KM" value={result.summary.total_km.toFixed(1)} />
          <SummaryCard label="Coût total" value={`${result.summary.total_cost.toFixed(2)} €`} />
          <SummaryCard label="Remplissage moy." value={`${result.summary.avg_fill_rate_pct.toFixed(1)}%`} />
        </div>
      )}

      {/* Non placés / Unassigned */}
      {result && result.unassigned_pdvs.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-danger, #ef4444)' }}>
            PDV non placés ({result.unassigned_pdvs.length})
          </h2>
          <div className="overflow-x-auto rounded border" style={{ borderColor: 'var(--border-color)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Code</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Nom</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Ville</th>
                  <th className="px-3 py-2 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQP</th>
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Raison</th>
                </tr>
              </thead>
              <tbody>
                {result.unassigned_pdvs.map((p) => (
                  <tr key={p.pdv_id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{p.pdv_code}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{p.pdv_name}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{p.pdv_city || '—'}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{p.eqp_count}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: '#eab308' }}>{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Résultat vide / Empty result */}
      {result && result.tours.length === 0 && result.unassigned_pdvs.length === 0 && (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          Aucun tour à suggérer pour ces critères.
        </div>
      )}
    </div>
  )
}

/* ── Sous-composants / Sub-components ── */

function TourRow({
  tour,
  isExpanded,
  fillRate,
  onToggle,
}: {
  tour: SuggestedTour
  isExpanded: boolean
  fillRate: number
  onToggle: () => void
}) {
  const hasWarnings = tour.warnings.length > 0
  return (
    <>
      <tr
        className="border-t cursor-pointer hover:opacity-90 transition-colors"
        style={{ borderColor: 'var(--border-color)', backgroundColor: isExpanded ? 'var(--bg-secondary)' : 'transparent' }}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
          {isExpanded ? '▼' : '▶'}
        </td>
        <td className="px-3 py-2 font-semibold whitespace-nowrap" style={{ color: 'var(--color-primary)' }}>
          {tour.tour_number}
        </td>
        <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
          {tour.contract ? (
            <span title={`${tour.contract.transporter_name} — ${tour.contract.vehicle_name || tour.contract.vehicle_code || ''}`}>
              {tour.contract.contract_code}
              <span className="ml-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                {tour.contract.vehicle_type || ''}
                {tour.contract.has_tailgate ? ' + hayon' : ''}
              </span>
            </span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>Aucun contrat</span>
          )}
        </td>
        <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.stops.length}</td>
        <td className="px-3 py-2 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.total_eqp}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{tour.total_km.toFixed(1)}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.total_cost.toFixed(2)} €</td>
        <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{tour.departure_time || '—'}</td>
        <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{tour.return_time || '—'}</td>
        <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
          {formatDuration(tour.total_duration_minutes)}
        </td>
        <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ color: fillRateColor(fillRate) }}>
          {fillRate > 0 ? `${fillRate.toFixed(0)}%` : '—'}
        </td>
        <td className="px-3 py-2 text-center whitespace-nowrap">
          {hasWarnings && <span title={tour.warnings.join('\n')}>⚠️</span>}
        </td>
      </tr>

      {/* Détails stops / Stop details */}
      {isExpanded && (
        <tr>
          <td colSpan={12} style={{ backgroundColor: 'var(--bg-secondary)' }}>
            <div className="px-6 py-2">
              {/* Contract info */}
              {tour.contract && (
                <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                  {tour.contract.transporter_name} — {tour.contract.vehicle_name || tour.contract.vehicle_code}
                  {' '} ({tour.contract.capacity_eqp} EQP)
                  {tour.contract.has_tailgate && ` — Hayon ${tour.contract.tailgate_type || ''}`}
                </div>
              )}

              {/* Tour warnings */}
              {tour.warnings.length > 0 && (
                <div className="text-xs mb-2 space-y-0.5" style={{ color: '#eab308' }}>
                  {tour.warnings.map((w, i) => (
                    <div key={i}>⚠️ {w}</div>
                  ))}
                </div>
              )}

              <table className="w-full text-xs">
                <thead>
                  <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                    <th className="px-2 py-1 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Seq</th>
                    <th className="px-2 py-1 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Arrivée</th>
                    <th className="px-2 py-1 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>PDV</th>
                    <th className="px-2 py-1 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Ville</th>
                    <th className="px-2 py-1 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>EQP</th>
                    <th className="px-2 py-1 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Dist (km)</th>
                    <th className="px-2 py-1 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Deadline</th>
                    <th className="px-2 py-1 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>SAS</th>
                    <th className="px-2 py-1 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {tour.stops.map((stop) => {
                    const hasStopWarning = stop.warnings.length > 0
                    return (
                      <tr
                        key={stop.sequence_order}
                        className="border-t"
                        style={{ borderColor: 'var(--border-color)' }}
                      >
                        <td className="px-2 py-1 text-center whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                          {stop.sequence_order}
                        </td>
                        <td className="px-2 py-1 text-center font-mono whitespace-nowrap" style={{ color: hasStopWarning ? '#eab308' : 'var(--text-primary)' }}>
                          {stop.arrival_time || '—'}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                          <span className="font-medium">{stop.pdv_code}</span>
                          <span className="ml-1" style={{ color: 'var(--text-secondary)' }}>— {stop.pdv_name}</span>
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {stop.pdv_city || '—'}
                        </td>
                        <td className="px-2 py-1 text-right font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                          {stop.eqp_count}
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {stop.distance_from_previous_km.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 text-center font-mono whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {stop.deadline || '—'}
                        </td>
                        <td className="px-2 py-1 text-center whitespace-nowrap">
                          {stop.has_sas ? (
                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: 'rgba(59,130,246,0.15)', color: '#3b82f6' }}>
                              SAS
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1 text-center whitespace-nowrap">
                          {hasStopWarning && (
                            <span title={stop.warnings.join('\n')} style={{ cursor: 'help' }}>⚠️</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function SummaryCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      className="rounded border px-4 py-3 text-center"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
    >
      <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

function SortableCriterion({
  id,
  rank,
  meta,
}: {
  id: string
  rank: string
  meta: { label: string; description: string }
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    backgroundColor: isDragging ? 'var(--bg-tertiary)' : 'transparent',
    borderColor: isDragging ? 'var(--color-primary)' : 'transparent',
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-2 py-1.5 rounded border text-sm"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-base select-none"
        style={{ color: 'var(--text-muted)' }}
      >
        ⠿
      </span>
      <span
        className="inline-block w-8 text-center text-[10px] font-bold rounded px-1 py-0.5"
        style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }}
      >
        {rank}
      </span>
      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{meta.label}</span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>— {meta.description}</span>
    </div>
  )
}
