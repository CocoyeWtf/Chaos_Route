/* Rappels periodiques affiches a la connexion (#17, #26).

   Samuel a choisi de garder deux taches manuelles — l'archive trimestrielle de
   l'historique et la mise a jour hebdomadaire du prix du carburant — a
   condition que l'application les reclame tant qu'elles ne sont pas faites.

   Deux comportements, voulus differents :
   - le rappel carburant n'a PAS de bouton « c'est fait » : il disparait tout
     seul des qu'un prix couvre la semaine. Une case a cocher permettrait de
     faire taire l'alerte sans faire la tache, ce qui est exactement ce qu'on
     veut eviter sur un chiffre qui entre dans la facturation ;
   - le rappel d'archive en a un : l'application ne peut pas constater qu'un
     fichier Excel a ete range quelque part.

   Le bandeau se masque pour la session en cours sur demande, et revient a la
   connexion suivante tant que la tache n'est pas faite — c'est la demande
   litterale des deux tickets. */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../services/api'

interface Reminder {
  key: string
  period_key: string
  title: string
  message: string
  link: string
  link_label: string
  acknowledgeable: boolean
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
}

const COULEURS: Record<string, { bord: string; fond: string; texte: string }> = {
  HIGH: { bord: '#ef4444', fond: 'rgba(239,68,68,0.10)', texte: '#ef4444' },
  MEDIUM: { bord: '#f59e0b', fond: 'rgba(245,158,11,0.10)', texte: '#f59e0b' },
  LOW: { bord: 'var(--border-color)', fond: 'var(--bg-secondary)', texte: 'var(--text-muted)' },
}

export function ReminderBanner() {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [masques, setMasques] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const charger = useCallback(() => {
    api.get<Reminder[]>('/reminders/')
      .then((r) => setReminders(r.data))
      .catch(() => setReminders([]))
  }, [])

  useEffect(() => { charger() }, [charger])

  const confirmer = async (r: Reminder) => {
    setBusy(r.key)
    try {
      await api.post(`/reminders/${r.key}/ack`, {})
      charger()
    } catch {
      /* On laisse le bandeau : mieux vaut un rappel de trop qu'une tache oubliee. */
    } finally {
      setBusy(null)
    }
  }

  const visibles = reminders.filter((r) => !masques.has(r.key))
  if (visibles.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      {visibles.map((r) => {
        const c = COULEURS[r.severity] ?? COULEURS.LOW
        return (
          <div key={r.key} className="rounded-xl border px-4 py-3 flex flex-wrap items-center gap-3"
            style={{ backgroundColor: c.fond, borderColor: c.bord }}>
            <span style={{ color: c.texte }}>&#9888;</span>
            <div className="flex-1 min-w-[240px]">
              <p className="text-sm font-semibold" style={{ color: c.texte }}>{r.title}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{r.message}</p>
            </div>
            <Link to={r.link}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold"
              style={{ backgroundColor: c.bord, color: '#fff' }}>
              {r.link_label}
            </Link>
            {r.acknowledgeable && (
              <button onClick={() => confirmer(r)} disabled={busy === r.key}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                style={{ border: `1px solid ${c.bord}`, color: c.texte }}>
                {busy === r.key ? '…' : "C'est fait"}
              </button>
            )}
            <button
              onClick={() => setMasques((p) => new Set(p).add(r.key))}
              title="Masquer jusqu'à la prochaine connexion"
              className="px-2 py-1 rounded text-xs"
              style={{ color: 'var(--text-muted)' }}>
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
