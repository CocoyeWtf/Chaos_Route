/* Sélecteur température + véhicule / Temperature + vehicle selector */

import type { VehicleType, TemperatureType, TemperatureClass } from '../../types'
import { VEHICLE_TYPE_DEFAULTS, TEMPERATURE_COLORS, TEMPERATURE_TYPE_LABELS } from '../../types'
import { getDisabledMonoTemps } from '../../utils/temperatureUtils'

interface VehicleSelectorProps {
  selectedType: VehicleType | null
  onSelect: (type: VehicleType, capacityEqp: number) => void
  selectedTemperature?: TemperatureType | null
  onTemperatureSelect?: (temp: TemperatureType) => void
  suggestedTemperature?: TemperatureType
  tourTemperatures?: Set<TemperatureClass>
  /* Gabarits refusés par un PDV déjà dans le tour → type interdit (#32).
     La valeur est la raison affichée au survol. /
     Vehicle types refused by a PDV already in the tour; value is the reason. */
  blockedVehicleTypes?: Map<VehicleType, string>
}

const VEHICLE_TYPES = Object.keys(VEHICLE_TYPE_DEFAULTS) as VehicleType[]

const ALL_TEMP_TYPES: TemperatureType[] = ['SEC', 'FRAIS', 'GEL', 'BI_TEMP', 'TRI_TEMP']

/* Couleurs pour BI_TEMP et TRI_TEMP / Colors for multi-temp types */
const MULTI_TEMP_COLORS: Record<string, string> = {
  BI_TEMP: '#8b5cf6',
  TRI_TEMP: '#d946ef',
}

function getTempColor(t: TemperatureType): string {
  if (t in TEMPERATURE_COLORS) return TEMPERATURE_COLORS[t as TemperatureClass]
  return MULTI_TEMP_COLORS[t] ?? '#888'
}

/* Couleur du véhicule — orange primaire / Vehicle color — primary orange */
const VEHICLE_COLOR = 'var(--color-primary)'

export function VehicleSelector({
  selectedType, onSelect,
  selectedTemperature, onTemperatureSelect,
  suggestedTemperature, tourTemperatures,
  blockedVehicleTypes,
}: VehicleSelectorProps) {
  const disabledMonos = tourTemperatures ? getDisabledMonoTemps(tourTemperatures) : new Set<TemperatureClass>()
  const hasSteps = !!onTemperatureSelect

  return (
    <div className="space-y-4">
      {/* 1. Mode température / Temperature mode */}
      {onTemperatureSelect && (
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              {hasSteps ? '1.' : ''} Mode température
            </span>
            {suggestedTemperature && selectedTemperature !== suggestedTemperature && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
              >
                suggestion: {TEMPERATURE_TYPE_LABELS[suggestedTemperature]}
              </span>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {ALL_TEMP_TYPES.map((tt) => {
              const selected = tt === selectedTemperature
              const color = getTempColor(tt)
              const isMono = tt === 'SEC' || tt === 'FRAIS' || tt === 'GEL'
              const disabled = isMono && disabledMonos.has(tt as TemperatureClass)
              return (
                <button
                  key={tt}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all border ${disabled ? 'opacity-25 cursor-not-allowed' : 'hover:scale-105'}`}
                  style={{
                    backgroundColor: selected ? color : 'transparent',
                    borderColor: color,
                    color: selected ? '#fff' : color,
                    boxShadow: selected ? `0 0 8px ${color}40` : 'none',
                  }}
                  onClick={() => !disabled && onTemperatureSelect(tt)}
                  disabled={disabled}
                >
                  {TEMPERATURE_TYPE_LABELS[tt]}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Séparateur / Divider */}
      {hasSteps && (
        <div className="flex items-center gap-3 px-4">
          <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-color)' }} />
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>puis</span>
          <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border-color)' }} />
        </div>
      )}

      {/* 2. Type de véhicule / Vehicle type */}
      <div className="text-center">
        {hasSteps && (
          <span className="text-[11px] font-semibold uppercase tracking-wider block mb-2" style={{ color: 'var(--text-muted)' }}>
            2. Type de véhicule
          </span>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {VEHICLE_TYPES.map((vt) => {
            const info = VEHICLE_TYPE_DEFAULTS[vt]
            const selected = vt === selectedType
            /* #32 : un PDV du tour refuse ce gabarit → aucun contrat ne pourra
               etre propose a l'ordonnancement, autant le dire ici. */
            const blocked = blockedVehicleTypes?.get(vt)
            return (
              <button
                key={vt}
                title={blocked ?? undefined}
                className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all border ${blocked ? 'opacity-30 cursor-not-allowed line-through' : 'hover:scale-105'}`}
                style={{
                  backgroundColor: selected ? 'var(--color-primary)' : 'transparent',
                  borderColor: VEHICLE_COLOR,
                  color: selected ? '#fff' : 'var(--color-primary)',
                  boxShadow: selected ? '0 0 8px rgba(249,115,22,0.4)' : 'none',
                }}
                onClick={() => !blocked && onSelect(vt, info.capacity_eqp)}
                disabled={!!blocked}
              >
                {info.label}
                <span
                  className="ml-1.5 text-[10px] font-normal opacity-70"
                >
                  {info.capacity_eqp}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
