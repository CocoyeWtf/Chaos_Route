/* Page visibilite des supports par PDV / Per-PDV support visibility page (#105).

   A la demande du PDV 01717 : l'app du magasin propose 41 types de support
   retournables, dont 20 casiers biere, alors qu'il en utilise 16. On regle ici
   ce que chaque magasin voit au moment d'encoder un retour.

   Pas de matrice comme « Regles support/base » : 170 PDV x 41 supports font
   7 000 cases. Un magasin a la fois, et une copie en masse pour propager le
   meme reglage a une enseigne entiere. */

import { useState, useEffect, useCallback, useMemo } from 'react'
import api from '../services/api'

interface PdvRow { id: number; code: string; name: string; hidden_count: number }
interface SupportRow {
  id: number
  code: string
  name: string
  is_combi: boolean
  has_image: boolean
  visible: boolean
}

/* Familles de code, dans l'ordre ou le magasin les rencontre. Les 20 casiers
   « PL » sont le gros du bruit denonce par le ticket : les grouper permet de
   tous les decocher d'un geste. / Code families, PL being the bulk of the noise. */
const FAMILIES: { prefix: string; label: string }[] = [
  { prefix: 'CO', label: 'Combis' },
  { prefix: 'PA', label: 'Palettes' },
  { prefix: 'PL', label: 'Casiers biere (palettisation)' },
  { prefix: 'RE', label: 'Balles / recyclage' },
  { prefix: 'SF', label: 'Autres contenants' },
]

function familyOf(code: string): string {
  const prefix = code.slice(0, 2).toUpperCase()
  return FAMILIES.some((f) => f.prefix === prefix) ? prefix : 'SF'
}

export default function PdvSupportRules() {
  const [pdvs, setPdvs] = useState<PdvRow[]>([])
  const [pdvId, setPdvId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [supports, setSupports] = useState<SupportRow[]>([])
  const [loadingPdvs, setLoadingPdvs] = useState(true)
  const [loadingRules, setLoadingRules] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyTargets, setCopyTargets] = useState<Set<number>>(new Set())
  const [copySearch, setCopySearch] = useState('')

  /* Etat enregistre, pour savoir s'il reste des modifications a sauver /
     Saved state, to know whether there are pending changes */
  const [savedHidden, setSavedHidden] = useState<Set<number>>(new Set())

  const loadPdvs = useCallback(async () => {
    try {
      const { data } = await api.get<PdvRow[]>('/pdv-support-rules/pdvs')
      setPdvs(data)
    } catch {
      setError('Impossible de charger la liste des PDV.')
    } finally {
      setLoadingPdvs(false)
    }
  }, [])

  useEffect(() => { loadPdvs() }, [loadPdvs])

  const loadRules = useCallback(async (id: number) => {
    setLoadingRules(true)
    setMessage(null)
    setError(null)
    try {
      const { data } = await api.get<{ support_types: SupportRow[] }>(
        `/pdv-support-rules/${id}`,
      )
      setSupports(data.support_types)
      setSavedHidden(new Set(data.support_types.filter((s) => !s.visible).map((s) => s.id)))
    } catch {
      setError('Impossible de charger les supports de ce PDV.')
      setSupports([])
    } finally {
      setLoadingRules(false)
    }
  }, [])

  useEffect(() => {
    if (pdvId != null) loadRules(pdvId)
  }, [pdvId, loadRules])

  const filteredPdvs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return pdvs
    return pdvs.filter((p) => `${p.code} ${p.name}`.toLowerCase().includes(q))
  }, [pdvs, search])

  const hiddenIds = useMemo(
    () => new Set(supports.filter((s) => !s.visible).map((s) => s.id)),
    [supports],
  )

  const dirty = useMemo(() => {
    if (hiddenIds.size !== savedHidden.size) return true
    for (const id of hiddenIds) if (!savedHidden.has(id)) return true
    return false
  }, [hiddenIds, savedHidden])

  const grouped = useMemo(() => {
    return FAMILIES.map((f) => ({
      ...f,
      items: supports.filter((s) => familyOf(s.code) === f.prefix),
    })).filter((g) => g.items.length > 0)
  }, [supports])

  const toggle = (id: number) => {
    setMessage(null)
    setSupports((prev) => prev.map((s) => (s.id === id ? { ...s, visible: !s.visible } : s)))
  }

  const setFamily = (prefix: string, visible: boolean) => {
    setMessage(null)
    setSupports((prev) => prev.map(
      (s) => (familyOf(s.code) === prefix ? { ...s, visible } : s),
    ))
  }

  const setAll = (visible: boolean) => {
    setMessage(null)
    setSupports((prev) => prev.map((s) => ({ ...s, visible })))
  }

  const handleSave = async () => {
    if (pdvId == null) return
    setSaving(true)
    setError(null)
    try {
      await api.put(`/pdv-support-rules/${pdvId}`, {
        items: supports.map((s) => ({ support_type_id: s.id, visible: s.visible })),
      })
      setSavedHidden(new Set(hiddenIds))
      setPdvs((prev) => prev.map(
        (p) => (p.id === pdvId ? { ...p, hidden_count: hiddenIds.size } : p),
      ))
      setMessage(
        hiddenIds.size === 0
          ? 'Enregistre. Ce PDV voit de nouveau tous les supports.'
          : `Enregistre. ${hiddenIds.size} support(s) masque(s) dans l'app de ce PDV.`,
      )
    } catch {
      setError("Echec de l'enregistrement.")
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (pdvId == null) return
    if (!confirm('Rendre tous les supports visibles pour ce PDV ?')) return
    setSaving(true)
    try {
      await api.delete(`/pdv-support-rules/${pdvId}`)
      await loadRules(pdvId)
      setPdvs((prev) => prev.map((p) => (p.id === pdvId ? { ...p, hidden_count: 0 } : p)))
      setMessage('Reinitialise : tous les supports sont visibles.')
    } catch {
      setError('Echec de la reinitialisation.')
    } finally {
      setSaving(false)
    }
  }

  const handleCopy = async () => {
    if (pdvId == null || copyTargets.size === 0) return
    const n = copyTargets.size
    if (!confirm(
      `Remplacer la configuration de ${n} PDV par celle de ce magasin ?\n`
      + 'Leurs reglages actuels seront ecrases.',
    )) return
    setSaving(true)
    try {
      await api.post(`/pdv-support-rules/${pdvId}/copy`, {
        target_pdv_ids: [...copyTargets],
      })
      setPdvs((prev) => prev.map(
        (p) => (copyTargets.has(p.id) ? { ...p, hidden_count: hiddenIds.size } : p),
      ))
      setCopyTargets(new Set())
      setCopyOpen(false)
      setMessage(`Configuration copiee vers ${n} PDV.`)
    } catch {
      setError('Echec de la copie.')
    } finally {
      setSaving(false)
    }
  }

  const selectedPdv = pdvs.find((p) => p.id === pdvId) || null

  const copyCandidates = useMemo(() => {
    const q = copySearch.trim().toLowerCase()
    const base = pdvs.filter((p) => p.id !== pdvId)
    if (!q) return base
    return base.filter((p) => `${p.code} ${p.name}`.toLowerCase().includes(q))
  }, [pdvs, pdvId, copySearch])

  if (loadingPdvs) {
    return <div className="p-6" style={{ color: 'var(--text-muted)' }}>Chargement...</div>
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
        Supports visibles par PDV
      </h1>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Choisir les types de support qui apparaissent dans l&apos;app du magasin au
        moment d&apos;encoder un retour. Le reglage est propre a chaque PDV.
        Un support decoche reste parfaitement reprenable : il n&apos;est plus propose,
        c&apos;est tout. Les reprises deja encodees ne bougent pas.
      </p>

      {error && (
        <div className="rounded-lg px-3 py-2 text-sm"
          style={{ backgroundColor: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg px-3 py-2 text-sm"
          style={{ backgroundColor: 'rgba(34,197,94,0.12)', color: '#22c55e' }}>
          {message}
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(220px, 300px) 1fr' }}>
        {/* Colonne PDV / PDV column */}
        <div className="rounded-xl border overflow-hidden"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
          <div className="p-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un PDV..."
              className="w-full px-2 py-1.5 rounded-lg text-sm"
              style={{
                backgroundColor: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
              }}
            />
          </div>
          <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
            {filteredPdvs.map((p) => (
              <button
                key={p.id}
                onClick={() => setPdvId(p.id)}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-b"
                style={{
                  borderColor: 'var(--border-color)',
                  backgroundColor: p.id === pdvId ? 'rgba(249,115,22,0.10)' : 'transparent',
                  color: 'var(--text-primary)',
                }}
              >
                <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
                  {p.code}
                </span>
                <span className="flex-1 truncate">{p.name}</span>
                {p.hidden_count > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                    style={{ backgroundColor: 'rgba(249,115,22,0.18)', color: '#f97316' }}
                    title={`${p.hidden_count} support(s) masque(s)`}>
                    {p.hidden_count}
                  </span>
                )}
              </button>
            ))}
            {filteredPdvs.length === 0 && (
              <p className="px-3 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                Aucun PDV ne correspond.
              </p>
            )}
          </div>
        </div>

        {/* Colonne supports / Supports column */}
        <div className="rounded-xl border"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
          {pdvId == null ? (
            <p className="p-6 text-sm" style={{ color: 'var(--text-muted)' }}>
              Choisissez un PDV a gauche.
            </p>
          ) : loadingRules ? (
            <p className="p-6 text-sm" style={{ color: 'var(--text-muted)' }}>Chargement...</p>
          ) : (
            <>
              <div className="p-3 border-b flex flex-wrap items-center gap-2"
                style={{ borderColor: 'var(--border-color)' }}>
                <div className="flex-1 min-w-[180px]">
                  <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {selectedPdv?.code} — {selectedPdv?.name}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {supports.length - hiddenIds.size} support(s) visible(s) sur {supports.length}
                  </p>
                </div>
                <button onClick={() => setAll(true)} className="px-2 py-1 rounded-lg text-xs"
                  style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                  Tout cocher
                </button>
                <button onClick={() => setAll(false)} className="px-2 py-1 rounded-lg text-xs"
                  style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                  Tout decocher
                </button>
                <button onClick={handleReset} disabled={saving}
                  className="px-2 py-1 rounded-lg text-xs"
                  style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                  Reinitialiser
                </button>
                <button onClick={() => setCopyOpen((v) => !v)} disabled={saving || dirty}
                  className="px-2 py-1 rounded-lg text-xs"
                  style={{
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-muted)',
                    opacity: dirty ? 0.45 : 1,
                  }}
                  title={dirty ? 'Enregistrez d\'abord ce PDV' : 'Copier vers d\'autres PDV'}>
                  Copier vers...
                </button>
                <button onClick={handleSave} disabled={saving || !dirty}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                  style={{
                    backgroundColor: dirty ? '#f97316' : 'var(--bg-tertiary)',
                    color: dirty ? '#fff' : 'var(--text-muted)',
                    opacity: saving ? 0.6 : 1,
                  }}>
                  {saving ? 'Enregistrement...' : 'Enregistrer'}
                </button>
              </div>

              {copyOpen && (
                <div className="p-3 border-b space-y-2"
                  style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    La configuration de {selectedPdv?.code} <strong>remplacera</strong> celle des
                    PDV coches — elle ne s&apos;y ajoute pas.
                  </p>
                  <input
                    value={copySearch}
                    onChange={(e) => setCopySearch(e.target.value)}
                    placeholder="Filtrer les PDV cibles..."
                    className="w-full px-2 py-1.5 rounded-lg text-sm"
                    style={{
                      backgroundColor: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border-color)',
                    }}
                  />
                  <div className="overflow-auto grid gap-1"
                    style={{ maxHeight: '220px', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                    {copyCandidates.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-xs px-1 py-0.5"
                        style={{ color: 'var(--text-primary)' }}>
                        <input
                          type="checkbox"
                          checked={copyTargets.has(p.id)}
                          onChange={() => setCopyTargets((prev) => {
                            const next = new Set(prev)
                            if (next.has(p.id)) next.delete(p.id)
                            else next.add(p.id)
                            return next
                          })}
                        />
                        <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{p.code}</span>
                        <span className="truncate">{p.name}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={handleCopy} disabled={saving || copyTargets.size === 0}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                      style={{
                        backgroundColor: copyTargets.size ? '#f97316' : 'var(--bg-secondary)',
                        color: copyTargets.size ? '#fff' : 'var(--text-muted)',
                      }}>
                      Copier vers {copyTargets.size} PDV
                    </button>
                    <button onClick={() => { setCopyOpen(false); setCopyTargets(new Set()) }}
                      className="px-2 py-1 rounded-lg text-xs"
                      style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                      Annuler
                    </button>
                  </div>
                </div>
              )}

              <div className="p-3 space-y-4 overflow-auto" style={{ maxHeight: '62vh' }}>
                {grouped.map((g) => {
                  const visibles = g.items.filter((s) => s.visible).length
                  return (
                    <div key={g.prefix}>
                      <div className="flex items-center gap-2 mb-1">
                        <h2 className="text-xs font-bold uppercase tracking-wide"
                          style={{ color: 'var(--text-muted)' }}>
                          {g.label} ({visibles}/{g.items.length})
                        </h2>
                        <button onClick={() => setFamily(g.prefix, true)}
                          className="text-[10px] underline" style={{ color: 'var(--text-muted)' }}>
                          tout
                        </button>
                        <button onClick={() => setFamily(g.prefix, false)}
                          className="text-[10px] underline" style={{ color: 'var(--text-muted)' }}>
                          aucun
                        </button>
                      </div>
                      <div className="grid gap-1"
                        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                        {g.items.map((s) => (
                          <label key={s.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer"
                            style={{
                              border: '1px solid var(--border-color)',
                              backgroundColor: s.visible ? 'transparent' : 'rgba(239,68,68,0.08)',
                              color: 'var(--text-primary)',
                              opacity: s.visible ? 1 : 0.65,
                            }}>
                            <input type="checkbox" checked={s.visible} onChange={() => toggle(s.id)} />
                            <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {s.code}
                            </span>
                            <span className="flex-1 truncate">{s.name}</span>
                            {s.is_combi && (
                              <span className="text-[9px] font-bold px-1 rounded"
                                style={{ backgroundColor: 'rgba(249,115,22,0.18)', color: '#f97316' }}>
                                COMBI
                              </span>
                            )}
                            {!s.has_image && (
                              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}
                                title="Aucune photo : l'app affichera un cadre vide">
                                sans photo
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
