/* Le « pot » : tournées construites à l'avance, en attente de date (#92).

   Gaetan : « les tours Gosselies-MEA sont faits le vendredi de la S-1. Lors de
   la création on dit à CMRO d'envoyer ces tours dans un "pot", et lorsqu'on
   planifie un jour X de la S-0 on intègre un ou des tours à la bonne date. Ce
   sous-menu devrait avoir un indicatif des tours restant à planifier afin de ne
   pas oublier de le faire, comme (48) pour 48 tours restant. »

   Le compteur est le cœur de la demande : sans lui, une tournée construite le
   vendredi se perd jusqu'à ce que quelqu'un se souvienne d'aller la chercher.
   Il est donc porté par le bouton lui-même, visible sans ouvrir le panneau. */

import { useCallback, useEffect, useState } from 'react'
import api from '../../services/api'
import type { BaseLogistics } from '../../types'

interface PooledTour {
  id: number
  code: string
  base_id: number
  built_on: string
  vehicle_type: string | null
  temperature_type: string | null
  stops_count: number
  total_eqp: number
  total_km: number
}

interface Props {
  bases: BaseLogistics[]
  /** Date affichée à l'ordonnancement : la cible proposée par défaut. */
  targetDate: string
  onScheduled: () => void
}

export function PooledToursPanel({ bases, targetDate, onScheduled }: Props) {
  const [open, setOpen] = useState(false)
  const [tours, setTours] = useState<PooledTour[]>([])
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [date, setDate] = useState(targetDate)
  const [deliveryDate, setDeliveryDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const charger = useCallback(() => {
    api.get<{ count: number; tours: PooledTour[] }>('/tours/pooled')
      .then((r) => { setCount(r.data.count); setTours(r.data.tours) })
      .catch(() => { setCount(0); setTours([]) })
  }, [])

  useEffect(() => { charger() }, [charger])
  useEffect(() => { setDate(targetDate) }, [targetDate])

  const baseLabel = (id: number) => {
    const b = bases.find((x) => x.id === id)
    return b ? `${b.code} — ${b.name}` : `#${id}`
  }

  const planifier = async () => {
    if (selected.size === 0 || !date) return
    setBusy(true)
    setMessage(null)
    try {
      const { data } = await api.post('/tours/pooled/schedule', {
        tour_ids: [...selected],
        date,
        delivery_date: deliveryDate || null,
      })
      setMessage(`${data.scheduled.length} tournée(s) planifiée(s) au ${date}.`)
      setSelected(new Set())
      charger()
      onScheduled()
    } catch {
      setMessage('Échec de la planification.')
    } finally {
      setBusy(false)
    }
  }

  /* Pas de pot, pas de bouton : on n'encombre pas la barre pour rien. */
  if (count === 0 && !open) return null

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
        style={{ borderColor: '#8b5cf6', color: '#8b5cf6' }}
        title="Tournées construites à l'avance, en attente d'une date"
      >
        Pot
        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold"
          style={{ backgroundColor: '#8b5cf6', color: '#fff' }}>
          {count}
        </span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={() => setOpen(false)}>
          <div className="w-full max-w-3xl rounded-xl border flex flex-col"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', maxHeight: '85vh' }}
            onClick={(e) => e.stopPropagation()}>

            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                Tournées en attente de date ({count})
              </h2>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Construites à l&apos;avance, elles n&apos;apparaissent dans aucune journée
                tant qu&apos;on ne leur en a pas donné une.
              </p>
            </div>

            <div className="px-4 py-3 flex flex-wrap items-end gap-3 border-b"
              style={{ borderColor: 'var(--border-color)' }}>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Date de planification *
                </label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded-lg border"
                  style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  Date de livraison
                </label>
                <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded-lg border"
                  style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
                  title="Laisser vide pour conserver celle de la tournée" />
              </div>
              <button onClick={() => setSelected(new Set(tours.map((t) => t.id)))}
                className="px-2 py-1 rounded-lg text-xs"
                style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                Tout sélectionner
              </button>
              <button onClick={() => setSelected(new Set())}
                className="px-2 py-1 rounded-lg text-xs"
                style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                Aucune
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-2">
              {tours.length === 0 ? (
                <p className="py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
                  Le pot est vide.
                </p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: 'var(--text-muted)' }}>
                      <th className="text-left py-1 w-8" />
                      <th className="text-left py-1">Tournée</th>
                      <th className="text-left py-1">Base</th>
                      <th className="text-left py-1">Construite le</th>
                      <th className="text-left py-1">Véhicule</th>
                      <th className="text-right py-1">Arrêts</th>
                      <th className="text-right py-1">EQC</th>
                      <th className="text-right py-1">Km</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tours.map((t) => (
                      <tr key={t.id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                        <td className="py-1">
                          <input type="checkbox" checked={selected.has(t.id)}
                            onChange={() => setSelected((p) => {
                              const n = new Set(p)
                              if (n.has(t.id)) n.delete(t.id)
                              else n.add(t.id)
                              return n
                            })} />
                        </td>
                        <td className="py-1 font-mono" style={{ color: 'var(--text-primary)' }}>{t.code}</td>
                        <td className="py-1" style={{ color: 'var(--text-muted)' }}>{baseLabel(t.base_id)}</td>
                        <td className="py-1" style={{ color: 'var(--text-muted)' }}>{t.built_on}</td>
                        <td className="py-1" style={{ color: 'var(--text-muted)' }}>{t.vehicle_type ?? '—'}</td>
                        <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>{t.stops_count}</td>
                        <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>{t.total_eqp}</td>
                        <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>{t.total_km}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {message && (
                <p className="mt-3 text-xs font-semibold" style={{ color: 'var(--color-success)' }}>{message}</p>
              )}
            </div>

            <div className="px-4 py-3 border-t flex items-center gap-2"
              style={{ borderColor: 'var(--border-color)' }}>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {selected.size} sélectionnée(s)
              </span>
              <div className="ml-auto flex gap-2">
                <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-xs"
                  style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                  Fermer
                </button>
                <button onClick={planifier} disabled={busy || selected.size === 0 || !date}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ backgroundColor: '#8b5cf6', color: '#fff' }}>
                  {busy ? '…' : `Planifier au ${date || '…'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
