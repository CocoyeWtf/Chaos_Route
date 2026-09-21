/* Filtres & légende de la carte / Map filter checkboxes & legend */

import { useTranslation } from 'react-i18next'
import { useMapStore } from '../../stores/useMapStore'

/* Entrée de couche avec checkbox / Layer entry with checkbox */
interface LayerEntry {
  key: 'showBases' | 'showPdvs' | 'showSuppliers' | 'showRoutes'
  label: string
  checked: boolean
  color: string
  shape: 'circle' | 'square' | 'line'
}

/* Entrée de légende (indicateur seul) / Legend-only entry */
interface LegendEntry {
  label: string
  color: string
  shape: 'circle' | 'square' | 'line'
  size?: number
}

/* Pastille de forme / Shape swatch */
function Swatch({ color, shape, size = 10 }: { color: string; shape: string; size?: number }) {
  if (shape === 'line') {
    return (
      <span className="inline-flex items-center" style={{ width: 16, height: size }}>
        <span style={{ width: 16, height: 0, borderTop: `2px dashed ${color}` }} />
      </span>
    )
  }
  const borderRadius = shape === 'square' ? '2px' : '50%'
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        backgroundColor: color,
        borderRadius,
        border: '1.5px solid #fff',
        boxShadow: '0 0 2px rgba(0,0,0,.3)',
      }}
    />
  )
}

export function MapFilters() {
  const { t } = useTranslation()
  const { showBases, showPdvs, showSuppliers, showRoutes, showPdvLabels, showDayPdvs, showNightPdvs, dayNightTemp, toggleLayer, setDayNightTemp } = useMapStore()

  const layers: LayerEntry[] = [
    { key: 'showBases', label: t('nav.bases'), checked: showBases, color: '#f97316', shape: 'square' },
    { key: 'showPdvs', label: t('nav.pdvs'), checked: showPdvs, color: '#22c55e', shape: 'circle' },
    { key: 'showSuppliers', label: t('nav.suppliers'), checked: showSuppliers, color: '#8b5cf6', shape: 'square' },
    { key: 'showRoutes', label: t('map.routes'), checked: showRoutes, color: '#f97316', shape: 'line' },
  ]

  /* Sous-légende PDV par statut volume / PDV sub-legend by volume status */
  const pdvLegend: LegendEntry[] = [
    { label: t('map.pdvNoVolume'), color: '#9ca3af', shape: 'circle', size: 8 },
    { label: t('map.pdvUnassigned'), color: '#ef4444', shape: 'circle', size: 10 },
    // Reste à quai (#68) : volume disponible revenant d'une tournée non partie.
    { label: 'Reste à quai', color: '#eab308', shape: 'circle', size: 10 },
    { label: t('map.pdvAssigned'), color: '#22c55e', shape: 'circle', size: 10 },
    { label: t('map.pdvSelected'), color: '#f97316', shape: 'circle', size: 12 },
    { label: 'Reprise en attente', color: '#f59e0b', shape: 'circle', size: 6 },
  ]

  return (
    <div
      className="absolute top-3 right-3 z-[1000] rounded-lg p-3 shadow-lg"
      style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
    >
      {/* Couches / Layers */}
      {layers.map((f) => (
        <label key={f.key} className="flex items-center gap-2 cursor-pointer mb-1 last:mb-0">
          <input
            type="checkbox"
            checked={f.checked}
            onChange={() => toggleLayer(f.key)}
            className="w-3.5 h-3.5 rounded accent-orange-500"
          />
          <Swatch color={f.color} shape={f.shape} />
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{f.label}</span>
        </label>
      ))}

      {/* Sous-légende PDV / PDV sub-legend */}
      {showPdvs && (
        <>
          <div
            className="my-1.5"
            style={{ borderTop: '1px solid var(--border-color)' }}
          />
          <div className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
            {t('map.pdvLegend')}
          </div>
          {pdvLegend.map((entry) => (
            <div key={entry.label} className="flex items-center gap-2 mb-0.5 last:mb-0 pl-5">
              <Swatch color={entry.color} shape={entry.shape} size={entry.size} />
              <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{entry.label}</span>
            </div>
          ))}
          <label className="flex items-center gap-2 cursor-pointer mt-1.5 pl-5">
            <input
              type="checkbox"
              checked={showPdvLabels}
              onChange={() => toggleLayer('showPdvLabels')}
              className="w-3 h-3 rounded accent-orange-500"
            />
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>Labels EQC</span>
          </label>

          {/* Filtre jour/nuit / Day/night filter */}
          <div
            className="my-1.5"
            style={{ borderTop: '1px solid var(--border-color)' }}
          />
          <div className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
            Horaires livraison
          </div>
          <div className="flex gap-1 pl-5 mb-1">
            {(['ALL', 'SEC', 'FRAIS', 'GEL'] as const).map((t) => (
              <button
                key={t}
                className="text-[9px] px-1.5 py-0.5 rounded font-bold transition-all"
                style={{
                  backgroundColor: dayNightTemp === t ? (t === 'SEC' ? '#f59e0b' : t === 'FRAIS' ? '#3b82f6' : t === 'GEL' ? '#8b5cf6' : 'var(--color-primary)') : 'var(--bg-tertiary)',
                  color: dayNightTemp === t ? '#fff' : 'var(--text-muted)',
                }}
                onClick={() => setDayNightTemp(t)}
              >
                {t === 'ALL' ? 'Toutes' : t}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 cursor-pointer mb-0.5 pl-5">
            <input
              type="checkbox"
              checked={showDayPdvs}
              onChange={() => toggleLayer('showDayPdvs')}
              className="w-3 h-3 rounded accent-orange-500"
            />
            <span className="text-[10px]" style={{ color: '#f59e0b' }}>Jour</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer pl-5">
            <input
              type="checkbox"
              checked={showNightPdvs}
              onChange={() => toggleLayer('showNightPdvs')}
              className="w-3 h-3 rounded accent-orange-500"
            />
            <span className="text-[10px]" style={{ color: '#6366f1' }}>Nuit</span>
          </label>
        </>
      )}
    </div>
  )
}
