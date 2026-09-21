/* Résumé du tour en cours avec drag & drop / Current tour summary panel with DnD reordering */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
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
import type { TourStop, PDV, Volume, VehicleType, TemperatureType, TemperatureClass } from '../../types'
import { VEHICLE_TYPE_DEFAULTS, TEMPERATURE_COLORS, TEMPERATURE_TYPE_LABELS } from '../../types'
import type { StopTimeline } from '../../utils/tourTimeUtils'
import { formatDuration } from '../../utils/tourTimeUtils'

/* Couleurs pour BI_TEMP et TRI_TEMP / Colors for multi-temp types */
const MULTI_TEMP_COLORS: Record<string, string> = {
  BI_TEMP: '#8b5cf6',
  TRI_TEMP: '#d946ef',
}

/* Identité d'un stop (retrait / MAJ ciblés). Le volume source quand il existe
   (unique), sinon le PDV (pickup = 1 stop/PDV). / Stop identity for targeted ops. */
type StopKey = Pick<TourStop, 'pdv_id' | 'volume_id'>
const stopKey = (s: StopKey): StopKey => ({ pdv_id: s.pdv_id, volume_id: s.volume_id })

/* Id DOM stable et UNIQUE (drag & drop + clé React). Basé sur le volume source
   quand il existe, car un PDV peut avoir plusieurs stops de même eqc (Gel/Frais
   9.96) → un id par pdv_id les ferait entrer en collision. / Stable unique DOM id. */
const stopDomId = (s: StopKey): string =>
  s.volume_id != null ? `stop-v${s.volume_id}` : `stop-p${s.pdv_id}`

interface TourSummaryProps {
  stops: TourStop[]
  pdvs: PDV[]
  vehicleType: VehicleType | null
  capacityEqp: number
  totalEqp: number
  totalKm: number
  totalCost: number
  onRemoveStop: (key: StopKey) => void
  onReorderStops: (stops: TourStop[]) => void
  onUpdateStop?: (key: StopKey, data: Partial<TourStop>) => void
  stopTimelines?: StopTimeline[]
  returnTime?: string
  departureTime?: string
  totalDurationMinutes?: number
  temperatureType?: TemperatureType | null
  tourTemperatures?: Set<TemperatureClass>
  isPickupTour?: boolean
  /** Tous les volumes pour calculer la répartition temp par stop */
  volumes?: Volume[]
}

/* Ligne d'arrêt glissable / Sortable stop row */
/* Labels badge reprise / Pickup badge labels */
const PICKUP_BADGE_MAP: { key: keyof TourStop; label: string }[] = [
  { key: 'pickup_cardboard', label: 'B' },
  { key: 'pickup_containers', label: 'C' },
  { key: 'pickup_returns', label: 'M' },
  { key: 'pickup_consignment', label: 'K' },
]

const TEMP_COLORS: Record<string, string> = { SEC: '#f59e0b', FRAIS: '#3b82f6', GEL: '#8b5cf6' }
const TEMP_LABELS: Record<string, string> = { SEC: 'S', FRAIS: 'F', GEL: 'G' }

function StopTempBreakdown({ stop, volumes }: { stop: TourStop; volumes?: Volume[] }) {
  // Si le stop porte directement sa température (phase construction)
  if (stop.temperature_class) {
    const tc = stop.temperature_class
    return (
      <span className="inline-flex items-center gap-1">
        <span className="px-1 rounded text-[8px] font-bold text-white" style={{ backgroundColor: TEMP_COLORS[tc] || '#999' }}>{TEMP_LABELS[tc] || tc}</span>
        <span>{stop.eqp_count} EQC</span>
      </span>
    )
  }
  // Sinon, calculer depuis les volumes (tour sauvegardé)
  if (!volumes || volumes.length === 0) return <span>{stop.eqp_count} EQC</span>
  /* Le volume RÉELLEMENT rattaché à cet arrêt d'abord (#71) : agréger tous les
     volumes du point de vente affichait « S + F » sur chacun de ses arrêts dès
     qu'il était livré en sec ET en frais, et on ne savait plus lequel
     transportait quoi. Même piège que #84 et #3/#6. /
     Read this stop's own volume before falling back to the PDV's volumes. */
  if (stop.volume_id != null) {
    const propre = volumes.find((v) => v.id === stop.volume_id)
    if (propre) {
      const tc = propre.temperature_class
      return (
        <span className="inline-flex items-center gap-1">
          <span className="px-1 rounded text-[8px] font-bold text-white" style={{ backgroundColor: TEMP_COLORS[tc] || '#999' }}>{TEMP_LABELS[tc] || tc}</span>
          <span>{stop.eqp_count} EQC</span>
        </span>
      )
    }
  }
  const stopVols = volumes.filter((v) => v.pdv_id === stop.pdv_id)
  if (stopVols.length === 0) return <span>{stop.eqp_count} EQC</span>
  const byTemp: Record<string, number> = {}
  for (const v of stopVols) {
    byTemp[v.temperature_class] = (byTemp[v.temperature_class] || 0) + v.eqp_count
  }
  const entries = Object.entries(byTemp)
  if (entries.length <= 1) {
    const [tc] = entries[0] ?? ['SEC']
    return (
      <span className="inline-flex items-center gap-1">
        <span className="px-1 rounded text-[8px] font-bold text-white" style={{ backgroundColor: TEMP_COLORS[tc] || '#999' }}>{TEMP_LABELS[tc] || tc}</span>
        <span>{stop.eqp_count} EQC</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {entries.map(([tc, eqp]) => (
        <span key={tc} className="inline-flex items-center gap-0.5">
          <span className="px-1 rounded text-[8px] font-bold text-white" style={{ backgroundColor: TEMP_COLORS[tc] || '#999' }}>{TEMP_LABELS[tc] || tc}</span>
          <span>{eqp}</span>
        </span>
      ))}
    </span>
  )
}

function SortableStopRow({
  stop,
  idx,
  pdv,
  timeline,
  onRemove,
  onUpdate,
  t,
  isPickupTour,
  volumes,
}: {
  stop: TourStop
  idx: number
  pdv: PDV | undefined
  timeline: StopTimeline | undefined
  onRemove: (key: StopKey) => void
  onUpdate?: (key: StopKey, data: Partial<TourStop>) => void
  t: (key: string) => string
  isPickupTour?: boolean
  volumes?: Volume[]
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stopDomId(stop),
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    borderColor: isDragging ? 'var(--color-primary)' : 'var(--border-color)',
    backgroundColor: isDragging ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-lg p-3 mb-2 border group"
    >
      <div className="flex items-center gap-3">
        {/* Poignée de drag / Drag handle */}
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-sm shrink-0 select-none"
          style={{ color: 'var(--text-muted)' }}
          title="Drag"
        >
          ⠿
        </div>

        {/* Numéro de séquence / Sequence number */}
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
          style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
        >
          {idx + 1}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {pdv ? `${pdv.code} — ${pdv.name}` : `PDV #${stop.pdv_id}`}
          </div>
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            {pdv?.city && <span>{pdv.city}</span>}
            {isPickupTour ? (
              <span className="inline-flex gap-0.5">
                {PICKUP_BADGE_MAP.filter(({ key }) => stop[key]).map(({ label }) => (
                  <span
                    key={label}
                    className="px-1 py-0.5 rounded text-[9px] font-bold"
                    style={{ backgroundColor: '#f59e0b', color: '#000' }}
                  >
                    {label}
                  </span>
                ))}
              </span>
            ) : (
              <StopTempBreakdown stop={stop} volumes={volumes} />
            )}
          </div>
        </div>

        {/* Bouton supprimer / Remove button */}
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded"
          style={{ color: 'var(--color-danger)', backgroundColor: 'rgba(239,68,68,0.1)' }}
          onClick={() => onRemove(stopKey(stop))}
          title={t('common.delete')}
        >
          ✕
        </button>
      </div>

      {/* Cases à cocher reprises / Pickup checkboxes */}
      {onUpdate && (
        <div className="mt-2 ml-10 flex flex-wrap gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!stop.pickup_cardboard}
              onChange={() => onUpdate(stopKey(stop), { pickup_cardboard: !stop.pickup_cardboard })}
              className="accent-[var(--color-primary)] w-3.5 h-3.5"
            />
            {t('tourPlanning.pickupCardboard')}
          </label>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!stop.pickup_containers}
              onChange={() => onUpdate(stopKey(stop), { pickup_containers: !stop.pickup_containers })}
              className="accent-[var(--color-primary)] w-3.5 h-3.5"
            />
            {t('tourPlanning.pickupContainers')}
          </label>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!stop.pickup_returns}
              onChange={() => onUpdate(stopKey(stop), { pickup_returns: !stop.pickup_returns })}
              className="accent-[var(--color-primary)] w-3.5 h-3.5"
            />
            {t('tourPlanning.pickupReturns')}
          </label>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!stop.pickup_consignment}
              onChange={() => onUpdate(stopKey(stop), { pickup_consignment: !stop.pickup_consignment })}
              className="accent-[var(--color-primary)] w-3.5 h-3.5"
            />
            Consignes
          </label>
        </div>
      )}

      {/* Timeline du stop / Stop timeline details */}
      {timeline && (
        <div className="mt-2 ml-10 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <div>
            <span style={{ color: 'var(--color-primary)' }}>{t('tourPlanning.arrivalAt')}:</span>{' '}
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{timeline.arrival_time}</span>
          </div>
          <div>
            <span style={{ color: 'var(--color-primary)' }}>{t('tourPlanning.departureAt')}:</span>{' '}
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{timeline.departure_time}</span>
          </div>
          <div>
            {t('tourPlanning.travelTime')}: {timeline.travel_minutes}min ({timeline.distance_km}km)
          </div>
          <div>
            {t('tourPlanning.unloadTime')}: {timeline.unload_minutes}min
          </div>
        </div>
      )}
    </div>
  )
}

export function TourSummary({
  stops, pdvs, vehicleType, capacityEqp, totalEqp, totalKm, totalCost, onRemoveStop, onReorderStops,
  onUpdateStop, stopTimelines = [], returnTime, departureTime, totalDurationMinutes = 0,
  temperatureType, tourTemperatures, isPickupTour, volumes,
}: TourSummaryProps) {
  const { t } = useTranslation()
  const pdvMap = new Map(pdvs.map((p) => [p.id, p]))
  const timelineMap = new Map(stopTimelines.map((st) => [st.pdv_id, st]))

  const hasVehicle = !!vehicleType
  const capacityPct = hasVehicle && capacityEqp > 0 ? Math.round((totalEqp / capacityEqp) * 100) : 0
  const capacityColor =
    capacityPct > 100 ? 'var(--color-danger)' : capacityPct > 80 ? 'var(--color-warning)' : 'var(--color-success)'

  const vehicleLabel = vehicleType ? VEHICLE_TYPE_DEFAULTS[vehicleType]?.label ?? vehicleType : null

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const sortableIds = stops.map((s) => stopDomId(s))

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = sortableIds.indexOf(active.id as string)
    const newIndex = sortableIds.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove([...stops], oldIndex, newIndex).map((s, i) => ({
      ...s,
      sequence_order: i + 1,
    }))
    onReorderStops(reordered)
  }, [stops, sortableIds, onReorderStops])

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
    >
      {/* En-tête avec jauge capacité / Header with capacity gauge */}
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('tourPlanning.currentTour')}
            {vehicleLabel && (
              <span className="ml-2 text-xs font-normal" style={{ color: 'var(--color-primary)' }}>
                {vehicleLabel}
              </span>
            )}
            {/* Badges température / Temperature badges */}
            {tourTemperatures && tourTemperatures.size > 0 && (
              <span className="ml-2 inline-flex gap-1">
                {[...tourTemperatures].map((tc) => (
                  <span
                    key={tc}
                    className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                    style={{
                      backgroundColor: `${TEMPERATURE_COLORS[tc]}20`,
                      color: TEMPERATURE_COLORS[tc],
                    }}
                  >
                    {tc}
                  </span>
                ))}
              </span>
            )}
            {temperatureType && (temperatureType === 'BI_TEMP' || temperatureType === 'TRI_TEMP') && (
              <span
                className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold"
                style={{
                  backgroundColor: `${MULTI_TEMP_COLORS[temperatureType]}20`,
                  color: MULTI_TEMP_COLORS[temperatureType],
                }}
              >
                {TEMPERATURE_TYPE_LABELS[temperatureType]}
              </span>
            )}
          </h3>
          {isPickupTour ? (
            <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
              Reprise vide
            </span>
          ) : hasVehicle ? (
            <span className="text-xs font-bold" style={{ color: capacityColor }}>
              {totalEqp} / {capacityEqp > 0 ? capacityEqp : '—'} EQC ({capacityPct}%)
            </span>
          ) : (
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Vehicule non selectionne
            </span>
          )}
        </div>
        {/* Barre de progression / Progress bar */}
        {hasVehicle && !isPickupTour && (
          <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.min(capacityPct, 100)}%`, backgroundColor: capacityColor }}
            />
          </div>
        )}
      </div>

      {/* Heure de départ / Departure time */}
      {departureTime && stops.length > 0 && (
        <div className="px-4 py-2 flex items-center gap-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
            style={{ backgroundColor: 'var(--color-success)', color: '#fff' }}
          >
            B
          </div>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('tourPlanning.departureTime')}: {departureTime}
          </span>
        </div>
      )}

      {/* Liste des arrêts avec DnD / Stops list with drag and drop */}
      <div className="flex-1 overflow-y-auto p-2">
        {stops.length === 0 ? (
          <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
            {t('tourPlanning.addVolumesHint')}
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {stops.map((stop, idx) => (
                <SortableStopRow
                  key={stopDomId(stop)}
                  stop={stop}
                  idx={idx}
                  pdv={pdvMap.get(stop.pdv_id)}
                  timeline={timelineMap.get(stop.pdv_id)}
                  onRemove={onRemoveStop}
                  onUpdate={isPickupTour ? undefined : onUpdateStop}
                  t={t}
                  isPickupTour={isPickupTour}
                  volumes={volumes}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Retour base / Return to base */}
      {returnTime && stops.length > 0 && (
        <div className="px-4 py-2 flex items-center gap-2 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <div
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
            style={{ backgroundColor: 'var(--color-success)', color: '#fff' }}
          >
            B
          </div>
          <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('tourPlanning.returnBase')}: {returnTime}
          </span>
          {totalDurationMinutes > 0 && (
            <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
              {t('tourPlanning.totalDuration')}: {formatDuration(totalDurationMinutes)}
            </span>
          )}
        </div>
      )}

      {/* Résumé bas / Bottom summary */}
      {stops.length > 0 && (
        <div className={`px-4 py-3 border-t text-xs grid gap-2 ${isPickupTour ? 'grid-cols-3' : 'grid-cols-5'}`} style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
          <div>
            <span className="block font-semibold" style={{ color: 'var(--text-primary)' }}>{stops.length}</span>
            {t('tourPlanning.stops')}
          </div>
          {!isPickupTour && (
            <>
              <div>
                <span className="block font-semibold" style={{ color: 'var(--text-primary)' }}>{totalEqp}</span>
                EQC
              </div>
              <div>
                <span className="block font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {hasVehicle && capacityEqp > 0 ? `${Math.round((totalEqp / capacityEqp) * 100)}%` : '—'}
                </span>
                {t('tourPlanning.fillRate')}
              </div>
            </>
          )}
          <div>
            <span className="block font-semibold" style={{ color: 'var(--text-primary)' }}>
              {totalKm > 0 ? `${totalKm}` : '—'}
            </span>
            km
          </div>
          <div>
            <span className="block font-semibold" style={{ color: 'var(--text-primary)' }}>
              {totalCost > 0 ? `~${totalCost}€` : '—'}
            </span>
            {t('tourHistory.cost')}
          </div>
        </div>
      )}
    </div>
  )
}
