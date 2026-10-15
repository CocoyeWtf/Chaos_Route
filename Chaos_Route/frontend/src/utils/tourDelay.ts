/* Utilitaires calcul de retard / Delay calculation utilities */

import type { Tour, TourStop } from '../types'
import { parseTime, formatTime } from './tourTimeUtils'

/* --- Retard / Delay --- */

/** Retard en minutes (0 si pas de retard ou données manquantes) / Delay in minutes */
export function getDelayMinutes(tour: Tour): number {
  if (!tour.barrier_exit_time || !tour.departure_time) return 0
  const exit = parseTime(tour.barrier_exit_time)
  const planned = parseTime(tour.departure_time)
  return Math.max(0, exit - planned)
}

export type DelayLevel = 'on_time' | 'warning' | 'critical'

export function getDelayLevel(delayMinutes: number): DelayLevel {
  if (delayMinutes <= 0) return 'on_time'
  if (delayMinutes <= 15) return 'warning'
  return 'critical'
}

export const DELAY_COLORS: Record<DelayLevel, string> = {
  on_time: '#22c55e',
  warning: '#f59e0b',
  critical: '#ef4444',
}

/* --- Tour enrichi / Enriched tour --- */

export interface EstimatedStop extends TourStop {
  estimated_arrival: string | null
  estimated_departure: string | null
}

export interface TourWithDelay extends Tour {
  delay_minutes: number
  delay_level: DelayLevel
  estimated_stops: EstimatedStop[]
  estimated_return: string | null
  actual_departure: string | null
  /** Retour CONSTATE par le poste de garde, s'il a eu lieu (#101). */
  actual_return: string | null
  /** Heure de retour a retenir : le constat s'il existe, sinon l'estimation. */
  effective_return: string | null
}

function addMinutes(time: string | undefined | null, delta: number): string | null {
  if (!time) return null
  return formatTime(parseTime(time) + delta)
}

/** Calculer retard et heures estimées pour un tour / Compute delay and estimated times */
export function computeTourDelay(tour: Tour): TourWithDelay {
  const delay = getDelayMinutes(tour)
  const level = getDelayLevel(delay)

  const estimated_stops: EstimatedStop[] = tour.stops.map((stop) => ({
    ...stop,
    estimated_arrival: delay > 0 ? addMinutes(stop.arrival_time, delay) : (stop.arrival_time ?? null),
    estimated_departure: delay > 0 ? addMinutes(stop.departure_time, delay) : (stop.departure_time ?? null),
  }))

  const estimated_return = delay > 0
    ? addMinutes(tour.return_time, delay)
    : (tour.return_time ?? null)
  /* Le poste de garde enregistre le retour reel a la barriere (#101). Des qu'il
     existe, il remplace l'estimation : une projection ne survit pas au fait. */
  const actual_return = tour.barrier_entry_time || null

  return {
    ...tour,
    delay_minutes: delay,
    delay_level: level,
    estimated_stops,
    estimated_return,
    actual_departure: tour.barrier_exit_time || tour.departure_time || null,
    actual_return,
    effective_return: actual_return || estimated_return,
  }
}

/* --- Impact 2e tour / Second tour impact --- */

export interface TourImpact {
  delayedTour: TourWithDelay
  impactedTour: TourWithDelay
  overlapMinutes: number
  /** L'alerte repose-t-elle sur un retour CONSTATE ou sur une projection ? */
  fromActualReturn: boolean
}

/** Détecter les impacts de retard sur le 2e tour du même contrat / Detect delay cascade */
export function detectSecondTourImpacts(tours: TourWithDelay[]): TourImpact[] {
  const impacts: TourImpact[] = []

  // Grouper par contrat / Group by contract
  const byContract = new Map<number, TourWithDelay[]>()
  for (const t of tours) {
    if (t.contract_id == null) continue
    const list = byContract.get(t.contract_id) || []
    list.push(t)
    byContract.set(t.contract_id, list)
  }

  for (const [, contractTours] of byContract) {
    if (contractTours.length < 2) continue
    contractTours.sort((a, b) => (parseTime(a.departure_time!) || 0) - (parseTime(b.departure_time!) || 0))

    for (let i = 0; i < contractTours.length - 1; i++) {
      const current = contractTours[i]
      const next = contractTours[i + 1]
      if (current.delay_minutes <= 0 || !next.departure_time) continue

      /* Une fois le camion rentre, l'alerte doit se taire (#101).

         Elle comparait le retour ESTIME — depart reel + retard, donc une
         projection faite au moment du depart — a l'heure de depart suivante,
         sans jamais regarder si le camion etait revenu. Le poste de garde avait
         beau enregistrer son retour, l'alerte restait affichee chez le postier :
         elle annoncait un chevauchement deja dementi par les faits.

         On raisonne donc sur le retour EFFECTIF : le constat de la barriere
         s'il existe, l'estimation sinon. Un retour reellement posterieur au
         depart suivant alerte toujours — c'est alors un vrai probleme, et non
         plus une prevision. / Once the guard logs the return, the projection
         gives way to the fact. */
      const retour = current.effective_return
      if (!retour) continue

      const retourMin = parseTime(retour)
      const nextDeparture = parseTime(next.departure_time)
      if (retourMin > nextDeparture) {
        impacts.push({
          delayedTour: current,
          impactedTour: next,
          overlapMinutes: retourMin - nextDeparture,
          fromActualReturn: current.actual_return != null,
        })
      }
    }
  }

  return impacts
}
