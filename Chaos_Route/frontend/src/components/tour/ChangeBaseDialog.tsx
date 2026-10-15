/* Corriger la base de départ/retour de tournées déjà construites (#87).

   Gaetan : « le RCAM s'est trompé de site de départ et ne s'en est pas rendu
   compte. Il a dit à CMRO départ et retour de Villers. Les tours sont validés
   et envoyés à la poste. » Quinze tournées étaient à refaire à la main.

   Le dialogue impose une simulation avant d'écrire : l'action porte sur des
   tournées déjà parties au planning, et elle déplace aussi leurs volumes. */

import { useState, useMemo } from 'react'
import api from '../../services/api'
import type { Tour, BaseLogistics } from '../../types'

interface Props {
  tours: Tour[]
  bases: BaseLogistics[]
  onClose: () => void
  onDone: () => void
}

interface Apercu {
  dry_run: boolean
  modifiables?: { tour_id: number; tour_code: string; ancien_km: number; nouveau_km: number }[]
  modifies?: { tour_id: number; tour_code: string; ancien_km: number; nouveau_km: number }[]
  deja_parties: string[]
  introuvables: number[]
  volumes_a_deplacer?: number
  volumes_deplaces?: number
}

export function ChangeBaseDialog({ tours, bases, onClose, onDone }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [baseId, setBaseId] = useState<string>('')
  const [returnBaseId, setReturnBaseId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [apercu, setApercu] = useState<Apercu | null>(null)
  const [erreur, setErreur] = useState<string | null>(null)

  const baseLabel = useMemo(() => {
    const m = new Map(bases.map((b) => [b.id, `${b.code} — ${b.name}`]))
    return (id: number | null | undefined) => (id != null ? m.get(id) ?? `#${id}` : '—')
  }, [bases])

  /* Les tournées déjà sorties ne sont pas proposées : le passage de barrière est
     un constat du poste de garde, pas une donnée qu'on réécrit. */
  const candidates = useMemo(() => tours.filter((t) => !t.barrier_exit_time), [tours])
  const parties = useMemo(() => tours.filter((t) => t.barrier_exit_time), [tours])

  const toggle = (id: number) => {
    setApercu(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const appel = async (dryRun: boolean) => {
    if (!baseId || selected.size === 0) return
    setBusy(true)
    setErreur(null)
    try {
      const { data } = await api.post<Apercu>('/tours/change-base', {
        tour_ids: [...selected],
        base_id: Number(baseId),
        return_base_id: returnBaseId ? Number(returnBaseId) : null,
        move_volumes: true,
        dry_run: dryRun,
      })
      setApercu(data)
      if (!dryRun) onDone()
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setErreur(detail || 'Échec du changement de base')
    } finally {
      setBusy(false)
    }
  }

  const lignes = apercu?.modifies ?? apercu?.modifiables ?? []
  const applique = apercu != null && apercu.dry_run === false

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl border flex flex-col"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}>

        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            Corriger la base de départ
          </h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Les volumes rattachés suivent la tournée — une tournée n&apos;a qu&apos;une seule
            base d&apos;origine. Horaires, kilométrage et coût sont recalculés.
          </p>
        </div>

        <div className="px-4 py-3 flex flex-wrap items-end gap-3 border-b"
          style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Nouvelle base de départ *
            </label>
            <select value={baseId} onChange={(e) => { setBaseId(e.target.value); setApercu(null) }}
              className="px-2 py-1.5 text-xs rounded-lg border"
              style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
              <option value="">Choisir…</option>
              {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Base de retour
            </label>
            <select value={returnBaseId} onChange={(e) => { setReturnBaseId(e.target.value); setApercu(null) }}
              className="px-2 py-1.5 text-xs rounded-lg border"
              style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
              <option value="">Même que le départ</option>
              {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setSelected(new Set(candidates.map((t) => t.id)))}
              className="px-2 py-1 rounded-lg text-xs"
              style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
              Tout sélectionner ({candidates.length})
            </button>
            <button onClick={() => { setSelected(new Set()); setApercu(null) }}
              className="px-2 py-1 rounded-lg text-xs"
              style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
              Aucune
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 py-2">
          {candidates.length === 0 ? (
            <p className="py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
              Aucune tournée modifiable pour cette journée.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left py-1 w-8" />
                  <th className="text-left py-1">Tournée</th>
                  <th className="text-left py-1">Base actuelle</th>
                  <th className="text-left py-1">Retour</th>
                  <th className="text-right py-1">Km</th>
                  <th className="text-left py-1">Départ</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((t) => (
                  <tr key={t.id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                    <td className="py-1">
                      <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                    <td className="py-1 font-mono" style={{ color: 'var(--text-primary)' }}>{t.code}</td>
                    <td className="py-1" style={{ color: 'var(--text-muted)' }}>{baseLabel(t.base_id)}</td>
                    <td className="py-1" style={{ color: 'var(--text-muted)' }}>
                      {t.return_base_id ? baseLabel(t.return_base_id) : '= départ'}
                    </td>
                    <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>{t.total_km ?? '—'}</td>
                    <td className="py-1" style={{ color: 'var(--text-muted)' }}>{t.departure_time ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {parties.length > 0 && (
            <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              {parties.length} tournée(s) déjà sortie(s) de la barrière ne sont pas
              proposées : {parties.map((t) => t.code).join(', ')}. Le passage au poste
              de garde est un constat, il n&apos;est pas réécrit ici.
            </p>
          )}

          {erreur && (
            <div className="mt-3 rounded-lg px-3 py-2 text-sm"
              style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>{erreur}</div>
          )}

          {apercu && (
            <div className="mt-3 rounded-lg px-3 py-2 text-xs"
              style={{
                backgroundColor: applique ? 'rgba(34,197,94,0.10)' : 'rgba(249,115,22,0.10)',
                color: 'var(--text-primary)',
              }}>
              <p className="font-semibold mb-1">
                {applique
                  ? `Appliqué : ${lignes.length} tournée(s), ${apercu.volumes_deplaces ?? 0} volume(s) déplacé(s).`
                  : `Simulation : ${lignes.length} tournée(s) seraient modifiées, ${apercu.volumes_a_deplacer ?? 0} volume(s) déplacé(s).`}
              </p>
              {lignes.map((l) => (
                <div key={l.tour_id} style={{ color: 'var(--text-muted)' }}>
                  {l.tour_code} : {l.ancien_km} km → <strong>{l.nouveau_km} km</strong>
                </div>
              ))}
              {apercu.deja_parties.length > 0 && (
                <p className="mt-1" style={{ color: '#f59e0b' }}>
                  Ignorées (déjà sorties) : {apercu.deja_parties.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center gap-2"
          style={{ borderColor: 'var(--border-color)' }}>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {selected.size} tournée(s) sélectionnée(s)
          </span>
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs"
              style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
              Fermer
            </button>
            <button onClick={() => appel(true)} disabled={busy || !baseId || selected.size === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
              style={{ border: '1px solid var(--color-primary)', color: 'var(--color-primary)' }}>
              Simuler
            </button>
            {/* Appliquer n'est offert qu'après une simulation : on ne déplace pas
                des tournées déjà envoyées à la poste sans les avoir vues. */}
            <button onClick={() => appel(false)}
              disabled={busy || !baseId || selected.size === 0 || apercu == null || applique}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
              style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}>
              {busy ? '…' : 'Appliquer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
