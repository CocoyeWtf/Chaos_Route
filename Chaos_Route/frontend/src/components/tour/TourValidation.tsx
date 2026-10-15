/* Validation du tour (phase construction) / Tour validation rules (construction phase) */

import { useTranslation } from 'react-i18next'
import type { TourStop, VehicleType, TemperatureType } from '../../types'
import { TEMPERATURE_TYPE_LABELS, FILL_COLORS, FILL_LABELS, fillLevel } from '../../types'

interface TourValidationProps {
  stops: TourStop[]
  vehicleType: VehicleType | null
  capacityEqp: number
  totalEqp: number
  onValidate: () => void
  /* « Pot » des tournees construites a l'avance (#92). Facultatif : seuls les
     ecrans qui construisent des tournees le proposent. */
  sendToPool?: boolean
  onSendToPoolChange?: (v: boolean) => void
  onReset: () => void
  temperatureType?: TemperatureType | null
  isPickupTour?: boolean
  baseId?: number | null
}

interface ValidationMessage {
  type: 'error' | 'warning' | 'info'
  message: string
}

export function TourValidation({ stops, vehicleType, capacityEqp, totalEqp, onValidate, onReset, temperatureType, isPickupTour, baseId, sendToPool, onSendToPoolChange }: TourValidationProps) {
  const { t } = useTranslation()

  const messages: ValidationMessage[] = []

  if (!vehicleType) {
    messages.push({ type: 'error', message: t('tourPlanning.validation.noVehicle') })
  }

  if (stops.length === 0) {
    messages.push({ type: 'error', message: t('tourPlanning.validation.noStops') })
  }

  if (isPickupTour && !baseId) {
    messages.push({ type: 'error', message: 'Base non selectionnee' })
  }

  if (!isPickupTour && capacityEqp > 0 && totalEqp > capacityEqp * 1.15) {
    messages.push({
      type: 'error',
      message: `Dépassement critique : +${Math.round(((totalEqp - capacityEqp) / capacityEqp) * 100)}% (max 15% autorisé)`,
    })
  } else if (!isPickupTour && capacityEqp > 0 && totalEqp > capacityEqp) {
    messages.push({
      type: 'warning',
      message: `Surbooking : +${Math.round(((totalEqp - capacityEqp) / capacityEqp) * 100)}% au-delà de la capacité`,
    })
  }

  if (!isPickupTour && capacityEqp > 0 && totalEqp > 0 && totalEqp < capacityEqp * 0.5) {
    messages.push({
      type: 'warning',
      message: t('tourPlanning.validation.lowFillRate', {
        pct: Math.round((totalEqp / capacityEqp) * 100),
      }),
    })
  }

  if (!isPickupTour && vehicleType && !temperatureType) {
    messages.push({ type: 'warning', message: 'Temperature non selectionnee' })
  }

  if (!isPickupTour && temperatureType) {
    messages.push({ type: 'info', message: `Temperature: ${TEMPERATURE_TYPE_LABELS[temperatureType]}` })
  }

  if (isPickupTour && vehicleType && stops.length > 0 && baseId) {
    messages.push({ type: 'info', message: t('tourPlanning.validation.readyDraft') })
  } else if (!isPickupTour && vehicleType && stops.length > 0 && totalEqp <= capacityEqp * 1.15) {
    messages.push({ type: 'info', message: t('tourPlanning.validation.readyDraft') })
  }

  const hasErrors = messages.some((m) => m.type === 'error')

  const colorMap = {
    error: { bg: 'rgba(239,68,68,0.1)', text: 'var(--color-danger)', icon: '✕' },
    warning: { bg: 'rgba(234,179,8,0.1)', text: 'var(--color-warning)', icon: '⚠' },
    info: { bg: 'rgba(34,197,94,0.1)', text: 'var(--color-success)', icon: '✓' },
  }

  /* Coefficient de remplissage (#75). Gaetan : « le planning doit faire une
     verification selon le coefficient de remplissage des semis. Un pourcentage
     peut etre ajoute en vert ou en rouge selon un critere defini. »
     Le chiffre existait deja dans les messages de validation, mais noye parmi
     eux et seulement aux extremes — on le montre en permanence, avec sa
     couleur, parce que c'est sur lui qu'on arbitre d'ajouter un PDV de plus. */
  const pctRemplissage = capacityEqp > 0 ? Math.round((totalEqp / capacityEqp) * 100) : 0
  const niveau = fillLevel(pctRemplissage)
  const montrerRemplissage = !isPickupTour && capacityEqp > 0 && stops.length > 0

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
    >
      <div className="px-4 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('tourPlanning.validation.title')}
        </h3>
        {montrerRemplissage && (
          <span className="ml-auto flex items-center gap-2" title={FILL_LABELS[niveau]}>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {totalEqp.toFixed(2)} / {capacityEqp} EQC
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-bold"
              style={{ backgroundColor: `${FILL_COLORS[niveau]}22`, color: FILL_COLORS[niveau] }}>
              {pctRemplissage} %
            </span>
          </span>
        )}
      </div>
      {montrerRemplissage && (
        <div style={{ height: '4px', backgroundColor: 'var(--bg-tertiary)' }}>
          <div style={{
            height: '4px',
            width: `${Math.min(pctRemplissage, 100)}%`,
            backgroundColor: FILL_COLORS[niveau],
            transition: 'width .2s',
          }} />
        </div>
      )}

      <div className="p-3 space-y-2">
        {messages.map((msg, i) => {
          const style = colorMap[msg.type]
          return (
            <div
              key={i}
              className="rounded-lg px-3 py-2 text-xs flex items-center gap-2"
              style={{ backgroundColor: style.bg, color: style.text }}
            >
              <span className="font-bold">{style.icon}</span>
              {msg.message}
            </div>
          )
        })}
      </div>

      {/* Envoyer au « pot » plutot que dans la journee affichee (#92).
          Gaetan construit les tours Gosselies-MEA le vendredi de la S-1 et leur
          donne leur date la semaine suivante ; sans cette case, ils
          atterrissent dans la journee de construction et s'y perdent. */}
      {onSendToPoolChange && (
        <label className="px-4 pt-2 flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!sendToPool}
            onChange={(e) => onSendToPoolChange(e.target.checked)} />
          <span className="text-xs font-medium" style={{ color: sendToPool ? '#8b5cf6' : 'var(--text-secondary)' }}>
            Envoyer au pot (sans date)
          </span>
        </label>
      )}

      <div className="px-4 py-3 border-t flex gap-2" style={{ borderColor: 'var(--border-color)' }}>
        <button
          className="flex-1 px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40"
          style={{
            backgroundColor: hasErrors ? 'var(--bg-tertiary)' : (sendToPool ? '#8b5cf6' : 'var(--color-primary)'),
            color: hasErrors ? 'var(--text-muted)' : '#fff',
          }}
          disabled={hasErrors}
          onClick={onValidate}
        >
          {sendToPool ? 'Enregistrer au pot' : t('tourPlanning.validation.saveDraft')}
        </button>
        <button
          className="px-4 py-2 rounded-lg text-sm border transition-all hover:opacity-80"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
          onClick={onReset}
        >
          {t('tourPlanning.resetTour')}
        </button>
      </div>
    </div>
  )
}
