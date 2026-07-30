/* Panel des volumes disponibles avec tri par proximité / Available volumes panel with proximity sorting */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Volume, PDV, DistanceEntry, PdvPickupSummary, TemperatureClass } from '../../types'
import { TEMPERATURE_COLORS } from '../../types'
import { formatDate } from '../../utils/tourTimeUtils'

/* Labels courts par type de reprise / Short labels per pickup type */
const PICKUP_TYPE_SHORT: Record<string, string> = {
  CONTAINER: 'Contenants',
  CARDBOARD: 'Cartons',
  MERCHANDISE: 'Marchandise',
  CONSIGNMENT: 'Consignes',
}

/* Lettre badge par type / Badge letter per type */
const PICKUP_TYPE_LETTER: Record<string, string> = {
  CONTAINER: 'C',
  CARDBOARD: 'B',
  MERCHANDISE: 'M',
  CONSIGNMENT: 'K',
}

const TEMP_CHIPS: { key: TemperatureClass; label: string }[] = [
  { key: 'SEC', label: 'Sec' },
  { key: 'FRAIS', label: 'Frais' },
  { key: 'GEL', label: 'Gel' },
]

interface VolumePanelProps {
  volumes: Volume[]
  pdvs: PDV[]
  consumedVolumeIds: Set<number>
  onAddVolume: (volume: Volume) => void
  vehicleCapacity: number
  currentEqp: number
  /* Pour le tri par proximité / For proximity sorting */
  lastStopPdvId: number | null
  baseId: number | null
  distanceIndex: Map<string, DistanceEntry>
  pickupSummaries?: PdvPickupSummary[]
  /* Filtre température contrôlé par le parent / Temperature filter controlled by parent */
  tempFilters: Set<TemperatureClass>
  onTempFiltersChange: (filters: Set<TemperatureClass>) => void
  /* Filtre base d'origine contrôlé par le parent (ticket #20) / Origin base filter */
  baseFilters: Set<number>
  onBaseFiltersChange: (filters: Set<number>) => void
  availableBases: { id: number; code: string; name: string }[]
}

export function VolumePanel({
  volumes, pdvs, consumedVolumeIds, onAddVolume, vehicleCapacity, currentEqp,
  lastStopPdvId, baseId, distanceIndex, pickupSummaries, tempFilters, onTempFiltersChange,
  baseFilters, onBaseFiltersChange, availableBases,
}: VolumePanelProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const pdvMap = useMemo(() => new Map(pdvs.map((p) => [p.id, p])), [pdvs])
  const pickupMap = useMemo(() => {
    const m = new Map<number, PdvPickupSummary>()
    pickupSummaries?.forEach((s) => m.set(s.pdv_id, s))
    return m
  }, [pickupSummaries])
  const remaining = vehicleCapacity > 0 ? vehicleCapacity - currentEqp : Infinity

  const toggleTempFilter = (cls: TemperatureClass) => {
    const next = new Set(tempFilters)
    if (next.has(cls)) next.delete(cls)
    else next.add(cls)
    onTempFiltersChange(next)
  }

  const toggleBaseFilter = (id: number) => {
    const next = new Set(baseFilters)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onBaseFiltersChange(next)
  }

  /* Fonction lookup distance bidirectionnelle / Bidirectional distance lookup */
  const getDistanceKm = (fromType: string, fromId: number, toType: string, toId: number): number | null => {
    const d = distanceIndex.get(`${fromType}:${fromId}->${toType}:${toId}`)
      || distanceIndex.get(`${toType}:${toId}->${fromType}:${fromId}`)
    return d ? d.distance_km : null
  }

  /* Volumes triés par proximité au dernier stop + filtrés par recherche + filtrés par température /
     Volumes sorted by proximity to last stop + filtered by search + filtered by temperature */
  const sortedVolumes = useMemo(() => {
    const needle = search.trim().toLowerCase()

    /* Filtrer par recherche / Filter by search */
    let filtered = needle
      ? volumes.filter((v) => {
          const pdv = pdvMap.get(v.pdv_id)
          if (!pdv) return false
          return pdv.code.toLowerCase().includes(needle)
            || pdv.name.toLowerCase().includes(needle)
            || (pdv.city?.toLowerCase().includes(needle) ?? false)
        })
      : volumes

    /* Filtrer par température / Filter by temperature */
    if (tempFilters.size > 0) {
      filtered = filtered.filter((v) => tempFilters.has(v.temperature_class))
    }

    /* Filtrer par base d'origine (ticket #20) / Filter by origin base */
    if (baseFilters.size > 0) {
      filtered = filtered.filter((v) => baseFilters.has(v.base_origin_id))
    }

    const consumed = filtered.filter((v) => consumedVolumeIds.has(v.id))
    const available = filtered.filter((v) => !consumedVolumeIds.has(v.id))

    if (!lastStopPdvId && !baseId) return [...available, ...consumed]

    const refType = lastStopPdvId ? 'PDV' : 'BASE'
    const refId = lastStopPdvId ?? baseId!

    const withDist = available.map((v) => {
      const km = getDistanceKm(refType, refId, 'PDV', v.pdv_id)
      return { vol: v, km: km ?? 999999 }
    })
    withDist.sort((a, b) => a.km - b.km)

    return [...withDist.map((w) => w.vol), ...consumed]
  }, [volumes, consumedVolumeIds, lastStopPdvId, baseId, distanceIndex, search, pdvMap, tempFilters, baseFilters])

  /* Distance affichée par volume / Displayed distance per volume */
  const getDisplayDistance = (pdvId: number): number | null => {
    if (!lastStopPdvId && !baseId) return null
    const refType = lastStopPdvId ? 'PDV' : 'BASE'
    const refId = lastStopPdvId ?? baseId!
    return getDistanceKm(refType, refId, 'PDV', pdvId)
  }

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
    >
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('tourPlanning.availableVolumes')}
          </h3>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
            {volumes.filter((v) => !consumedVolumeIds.has(v.id)).length}
          </span>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('tourPlanning.searchPdv')}
          className="w-full rounded-lg border px-3 py-1.5 text-xs"
          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
        />
        {/* Chips filtre température / Temperature filter chips */}
        <div className="flex gap-1.5 mt-2">
          {TEMP_CHIPS.map(({ key, label }) => {
            const active = tempFilters.has(key)
            return (
              <button
                key={key}
                className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border"
                style={{
                  backgroundColor: active ? TEMPERATURE_COLORS[key] : 'transparent',
                  borderColor: TEMPERATURE_COLORS[key],
                  color: active ? '#fff' : TEMPERATURE_COLORS[key],
                }}
                onClick={() => toggleTempFilter(key)}
              >
                {label}
              </button>
            )
          })}
        </div>
        {/* Chips filtre base d'origine (ticket #20) — n'apparaît que si plusieurs
            bases sont présentes dans les volumes du jour / Origin base filter chips */}
        {availableBases.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {availableBases.map((b) => {
              const active = baseFilters.has(b.id)
              return (
                <button
                  key={b.id}
                  title={b.name}
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border"
                  style={{
                    backgroundColor: active ? 'var(--color-primary)' : 'transparent',
                    borderColor: 'var(--color-primary)',
                    color: active ? '#fff' : 'var(--color-primary)',
                  }}
                  onClick={() => toggleBaseFilter(b.id)}
                >
                  {b.code}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sortedVolumes.map((vol) => {
          const pdv = pdvMap.get(vol.pdv_id)
          const consumed = consumedVolumeIds.has(vol.id)
          const clickable = !consumed
          const overCapacity = remaining !== Infinity && vol.eqp_count > remaining
          const dist = clickable ? getDisplayDistance(vol.pdv_id) : null
          const pickup = pickupMap.get(vol.pdv_id)

          return (
            <div
              key={vol.id}
              className={`rounded-lg p-3 mb-2 border transition-all ${consumed ? 'opacity-40' : clickable ? 'cursor-pointer hover:scale-[1.01]' : ''}`}
              style={{
                borderColor: consumed ? 'var(--border-color)' : overCapacity && clickable ? 'var(--color-danger)' : 'var(--border-color)',
                backgroundColor: consumed ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
                borderLeftWidth: '4px',
                borderLeftColor: TEMPERATURE_COLORS[vol.temperature_class],
              }}
              onClick={() => clickable && onAddVolume(vol)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium" style={{ color: consumed ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                  {pdv ? `${pdv.code} — ${pdv.name}` : vol.pdv_code ? `${vol.pdv_code}${vol.pdv_name ? ` — ${vol.pdv_name}` : ''}` : `PDV #${vol.pdv_id}`}
                  {pickup && pickup.pending_count > 0 && (
                    <span className="ml-2 inline-flex gap-0.5">
                      {pickup.requests.map(r => (
                        <span
                          key={r.id}
                          className="px-1 py-0.5 rounded text-[9px] font-bold"
                          style={{ backgroundColor: '#f59e0b', color: '#000' }}
                          title={`${PICKUP_TYPE_SHORT[r.pickup_type]}: ${r.quantity}`}
                        >
                          {PICKUP_TYPE_LETTER[r.pickup_type]}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: overCapacity && clickable ? 'rgba(239,68,68,0.15)' : 'rgba(249,115,22,0.15)',
                    color: overCapacity && clickable ? 'var(--color-danger)' : 'var(--color-primary)',
                  }}
                >
                  {vol.eqp_count} EQC
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                {pdv?.city && <span>{pdv.city}</span>}
                {/* Badge température coloré / Colored temperature badge */}
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                  style={{
                    backgroundColor: `${TEMPERATURE_COLORS[vol.temperature_class]}20`,
                    color: TEMPERATURE_COLORS[vol.temperature_class],
                  }}
                >
                  {vol.temperature_class}
                </span>
                {vol.weight_kg && <span>{vol.weight_kg} kg</span>}
                {dist != null && (
                  <span className="ml-auto font-semibold" style={{ color: 'var(--color-primary)' }}>
                    {Math.round(dist * 10) / 10} km
                  </span>
                )}
              </div>
              {vol.dispatch_date && (
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {t('tourPlanning.dispatchInfo')} {formatDate(vol.dispatch_date)}{vol.dispatch_time ? ` ${vol.dispatch_time}` : ''}
                </div>
              )}
              {consumed && (
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>✓ {t('tourPlanning.assigned')}</div>
              )}
            </div>
          )
        })}

        {volumes.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
            {t('common.noData')}
          </p>
        )}
      </div>
    </div>
  )
}
