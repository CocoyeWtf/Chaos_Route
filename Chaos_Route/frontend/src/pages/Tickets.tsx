/* Board de tickets TRANSPARENT (type « Issue Council ») : tout le monde voit
   tous les tickets, tous les échanges et le statut. Traçabilité complète. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../services/api'
import { CreateTicketModal } from '../components/support/CreateTicketModal'
import { useAuthStore } from '../stores/useAuthStore'
import type { Ticket, TicketStatus, TicketType, TicketPriority } from '../types'
import {
  TICKET_TYPE_LABELS, TICKET_STATUS_LABELS, TICKET_STATUS_COLORS, TICKET_PRIORITY_LABELS,
} from '../types'

const PRIORITY_ORDER: TicketPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const TYPE_ORDER: TicketType[] = ['BUG', 'FEATURE', 'QUESTION', 'OTHER']

const STATUS_ORDER: TicketStatus[] = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED']

function StatusBadge({ status }: { status: TicketStatus }) {
  const c = TICKET_STATUS_COLORS[status]
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0"
      style={{ backgroundColor: `${c}22`, color: c }}>{TICKET_STATUS_LABELS[status]}</span>
  )
}

function fmt(d?: string | null): string {
  if (!d) return ''
  try { return new Date(d).toLocaleString('fr-BE', { dateStyle: 'short', timeStyle: 'short' }) } catch { return d }
}

export default function Tickets() {
  const [params, setParams] = useSearchParams()
  const [list, setList] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'ALL'>('ALL')
  const [typeFilter, setTypeFilter] = useState<TicketType | 'ALL'>('ALL')
  const [search, setSearch] = useState('')

  const [selected, setSelected] = useState<Ticket | null>(null)
  const [newComment, setNewComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  /* Photos du ticket ouvert (chargées en blob authentifié) + visionneuse */
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({})
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [exporting, setExporting] = useState(false)
  /* Édition/suppression du ticket par son auteur (ticket #19) */
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editType, setEditType] = useState<TicketType>('BUG')
  const [editPriority, setEditPriority] = useState<TicketPriority>('MEDIUM')
  /* Seuls les admins (tickets:update, superadmin inclus) changent le statut */
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const user = useAuthStore((s) => s.user)
  const canManage = hasPermission('tickets', 'update')
  /* L'auteur (ou un admin) peut modifier/supprimer son ticket (ticket #19) */
  const canEdit = !!selected && (canManage || (!!user && selected.created_by_user_id === user.id))

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<Ticket[]>('/tickets/')
      setList(data)
    } catch (e) { console.error('Chargement tickets échoué', e) }
    finally { setLoading(false) }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    try {
      const { data } = await api.get<Ticket>(`/tickets/${id}`)
      setSelected(data)
    } catch (e) { console.error('Chargement ticket échoué', e) }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  /* Ouverture auto via ?focus=<id> (depuis le bouton Signaler) */
  useEffect(() => {
    const focus = params.get('focus')
    if (focus) { loadDetail(Number(focus)); params.delete('focus'); setParams(params, { replace: true }) }
  }, [params, loadDetail, setParams])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return list.filter((t) =>
      (statusFilter === 'ALL' || t.status === statusFilter) &&
      (typeFilter === 'ALL' || t.ticket_type === typeFilter) &&
      (!q || t.title.toLowerCase().includes(q) || (t.created_by_name ?? '').toLowerCase().includes(q) || String(t.id) === q)
    )
  }, [list, statusFilter, typeFilter, search])

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    list.forEach((t) => { m[t.status] = (m[t.status] ?? 0) + 1 })
    return m
  }, [list])

  /* Charger les photos du ticket sélectionné en blob (endpoint authentifié) /
     Load the selected ticket's photos as authenticated blobs */
  useEffect(() => {
    const created: string[] = []
    const photos = selected?.photos ?? []
    if (selected && photos.length) {
      (async () => {
        const entries = await Promise.all(photos.map(async (p) => {
          try {
            const res = await api.get(`/tickets/${selected.id}/photos/${p.id}`, { responseType: 'blob' })
            const url = URL.createObjectURL(res.data as Blob)
            created.push(url)
            return [p.id, url] as const
          } catch { return null }
        }))
        setPhotoUrls(Object.fromEntries(entries.filter(Boolean) as [number, string][]))
      })()
    } else {
      setPhotoUrls({})
    }
    return () => { created.forEach((u) => URL.revokeObjectURL(u)) }
  }, [selected?.id, selected?.photos?.length])

  const uploadPhotoFile = useCallback(async (file: File) => {
    if (!selected || !file || !file.type.startsWith('image/')) return
    if ((selected.photos?.length ?? 0) >= 5) { alert('Maximum 5 photos par ticket.'); return }
    setUploadingPhoto(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/tickets/${selected.id}/photos`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      await loadDetail(selected.id)
      loadList()
    } catch (err) {
      console.error(err)
      alert("Échec de l'ajout de la photo.")
    } finally {
      setUploadingPhoto(false)
    }
  }, [selected, loadDetail, loadList])

  const addPhotoToTicket = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) uploadPhotoFile(file)
  }

  /* Ticket #19 : coller une capture (Ctrl+V) dans le ticket ouvert. Ignoré si la
     modale de création est ouverte (elle gère son propre collage). */
  useEffect(() => {
    if (!selected || creating) return
    const onPaste = (e: ClipboardEvent) => {
      const img = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .find((f): f is File => !!f)
      if (img) { e.preventDefault(); uploadPhotoFile(img) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [selected, creating, uploadPhotoFile])

  /* Sortir du mode édition dès qu'on change de ticket (ou qu'on ferme) */
  useEffect(() => { setEditing(false) }, [selected?.id])

  /* Ouvre le formulaire d'édition pré-rempli avec le ticket courant */
  const startEditing = () => {
    if (!selected) return
    setEditTitle(selected.title)
    setEditDescription(selected.description ?? '')
    setEditType(selected.ticket_type)
    setEditPriority(selected.priority)
    setEditing(true)
  }

  const saveEditing = async () => {
    if (!selected || !editTitle.trim()) return
    setBusy(true)
    try {
      const { data } = await api.put<Ticket>(`/tickets/${selected.id}`, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        ticket_type: editType,
        priority: editPriority,
      })
      setSelected(data)
      setEditing(false)
      loadList()
    } catch (e) {
      console.error(e)
      alert("Échec de la modification du ticket.")
    } finally { setBusy(false) }
  }

  const deleteTicket = async () => {
    if (!selected) return
    if (!window.confirm(`Supprimer définitivement le ticket #${selected.id} « ${selected.title} » ?\nLes échanges et photos seront également supprimés.`)) return
    setBusy(true)
    try {
      await api.delete(`/tickets/${selected.id}`)
      setSelected(null)
      loadList()
    } catch (e) {
      console.error(e)
      alert("Échec de la suppression du ticket.")
    } finally { setBusy(false) }
  }

  /* Exporter le ticket en ZIP (Markdown + JSON + photos) à injecter dans Claude Code */
  const exportTicket = async () => {
    if (!selected) return
    setExporting(true)
    try {
      const res = await api.get(`/tickets/${selected.id}/export`, { responseType: 'blob' })
      const cd = (res.headers?.['content-disposition'] as string | undefined) ?? ''
      const filename = /filename="?([^"]+)"?/.exec(cd)?.[1] || `ticket-${selected.id}.zip`
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Export ticket échoué', e)
      alert("Échec de l'export du ticket.")
    } finally {
      setExporting(false)
    }
  }

  const addComment = async () => {
    if (!selected || !newComment.trim()) return
    setBusy(true)
    try {
      await api.post(`/tickets/${selected.id}/comments`, { body: newComment.trim() })
      setNewComment('')
      await loadDetail(selected.id)
      loadList()
    } catch (e) { console.error(e) } finally { setBusy(false) }
  }

  const changeStatus = async (status: TicketStatus) => {
    if (!selected) return
    setBusy(true)
    try {
      const { data } = await api.put<Ticket>(`/tickets/${selected.id}/status`, { status })
      setSelected(data)
      loadList()
    } catch (e) { console.error(e) } finally { setBusy(false) }
  }

  const ctx = useMemo(() => {
    if (!selected?.context) return null
    try { return JSON.parse(selected.context) } catch { return null }
  }, [selected])

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Tickets</h2>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Board transparent — tout le monde voit tous les tickets et les échanges.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TICKET_STATUS_COLORS[s] }} />
                {TICKET_STATUS_LABELS[s]} {counts[s]}
              </span>
            ))}
          </div>
          <button onClick={() => setCreating(true)}
            className="px-3 py-2 rounded-lg text-sm font-semibold text-white transition-all hover:opacity-90"
            style={{ backgroundColor: 'var(--color-primary)' }}>
            + Nouveau ticket
          </button>
        </div>
      </div>

      <CreateTicketModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t) => { loadList(); loadDetail(t.id) }}
      />

      {/* Filtres */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher (titre, auteur, #id)…"
          className="rounded-lg border px-3 py-2 text-sm" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)', minWidth: '240px' }} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TicketStatus | 'ALL')}
          className="rounded-lg border px-2 py-2 text-sm" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
          <option value="ALL">Tous statuts</option>
          {STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_LABELS[s]}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TicketType | 'ALL')}
          className="rounded-lg border px-2 py-2 text-sm" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
          <option value="ALL">Tous types</option>
          {(['BUG', 'FEATURE', 'QUESTION', 'OTHER'] as TicketType[]).map((t) => <option key={t} value={t}>{TICKET_TYPE_LABELS[t]}</option>)}
        </select>
      </div>

      {/* Liste */}
      {loading ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Chargement…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Aucun ticket.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <button key={t.id} onClick={() => loadDetail(t.id)}
              className="w-full text-left rounded-xl border px-4 py-3 transition-all hover:opacity-90 flex items-center gap-3"
              style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
              <span className="font-mono text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>#{t.id}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{TICKET_TYPE_LABELS[t.ticket_type]}</span>
              <span className="font-semibold truncate flex-1" style={{ color: 'var(--text-primary)' }}>{t.title}</span>
              <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.created_by_name} · {fmt(t.created_at)}</span>
              {!!t.comment_count && <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>💬 {t.comment_count}</span>}
              {!!t.photo_count && <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>📎 {t.photo_count}</span>}
              <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ color: 'var(--text-muted)' }}>{TICKET_PRIORITY_LABELS[t.priority]}</span>
              <StatusBadge status={t.status} />
            </button>
          ))}
        </div>
      )}

      {/* Détail (modale) */}
      {selected && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative rounded-xl border shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }} onClick={(e) => e.stopPropagation()}>
            <div className="p-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>#{selected.id}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{TICKET_TYPE_LABELS[selected.ticket_type]}</span>
                  <StatusBadge status={selected.status} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canEdit && !editing && (
                    <>
                      <button onClick={startEditing} disabled={busy}
                        title="Modifier ce ticket (auteur ou administrateur)"
                        className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border transition-all hover:opacity-80 disabled:opacity-50"
                        style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-primary)' }}>
                        ✏ Modifier
                      </button>
                      <button onClick={deleteTicket} disabled={busy}
                        title="Supprimer ce ticket (auteur ou administrateur)"
                        className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border transition-all hover:opacity-80 disabled:opacity-50"
                        style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', backgroundColor: 'var(--bg-primary)' }}>
                        🗑 Supprimer
                      </button>
                    </>
                  )}
                  <button onClick={exportTicket} disabled={exporting}
                    title="Télécharger un ZIP (Markdown + JSON + photos) du ticket"
                    className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border transition-all hover:opacity-80 disabled:opacity-50"
                    style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-primary)' }}>
                    {exporting ? '…' : '⬇ Exporter'}
                  </button>
                  <button onClick={() => setSelected(null)} className="text-xl leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
                </div>
              </div>
              {editing ? (
                /* Formulaire d'édition (ticket #19) — auteur ou admin */
                <div className="mb-3 space-y-2">
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Titre du ticket"
                    className="w-full px-3 py-2 rounded-lg border text-sm" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                  <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={4}
                    placeholder="Description"
                    className="w-full px-3 py-2 rounded-lg border text-sm resize-none" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                  <div className="flex items-center gap-2 flex-wrap">
                    <select value={editType} onChange={(e) => setEditType(e.target.value as TicketType)}
                      className="rounded-lg border px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                      {TYPE_ORDER.map((t) => <option key={t} value={t}>{TICKET_TYPE_LABELS[t]}</option>)}
                    </select>
                    <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as TicketPriority)}
                      className="rounded-lg border px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                      {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>)}
                    </select>
                    <div className="flex-1" />
                    <button onClick={() => setEditing(false)} disabled={busy}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>Annuler</button>
                    <button onClick={saveEditing} disabled={busy || !editTitle.trim()}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50" style={{ backgroundColor: 'var(--color-primary)' }}>Enregistrer</button>
                  </div>
                </div>
              ) : (
                <>
                  <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{selected.title}</h3>
                  <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>Ouvert par {selected.created_by_name} · {fmt(selected.created_at)}</p>
                  {selected.description && <p className="text-sm mb-3 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{selected.description}</p>}
                </>
              )}

              {/* Photos / captures jointes */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Photos</h4>
                  {(selected.photos?.length ?? 0) < 5 && (
                    <label className="text-xs cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded-lg border transition-all hover:opacity-80"
                      style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-primary)' }}
                      title="Ajouter depuis un fichier, ou collez une capture avec Ctrl+V">
                      {uploadingPhoto ? '…' : '+ Ajouter (ou Ctrl+V)'}
                      <input type="file" accept="image/*" className="hidden" onChange={addPhotoToTicket} disabled={uploadingPhoto} />
                    </label>
                  )}
                </div>
                {(selected.photos?.length ?? 0) === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Aucune photo jointe.</p>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {selected.photos!.map((p) => (
                      <button key={p.id} type="button" onClick={() => photoUrls[p.id] && setLightbox(photoUrls[p.id])}
                        className="block" title={p.filename}>
                        {photoUrls[p.id] ? (
                          <img src={photoUrls[p.id]} alt={p.filename}
                            className="w-full h-16 object-cover rounded-lg border" style={{ borderColor: 'var(--border-color)' }} />
                        ) : (
                          <div className="w-full h-16 rounded-lg border flex items-center justify-center text-[10px]"
                            style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>…</div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Statut — changement réservé aux admins (tickets:update) */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Statut :</span>
                {canManage ? (
                  <select value={selected.status} disabled={busy} onChange={(e) => changeStatus(e.target.value as TicketStatus)}
                    className="rounded-lg border px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                    {STATUS_ORDER.map((s) => <option key={s} value={s}>{TICKET_STATUS_LABELS[s]}</option>)}
                  </select>
                ) : (
                  <StatusBadge status={selected.status} />
                )}
              </div>

              {/* Contexte capturé */}
              {ctx && (
                <details className="mb-4 rounded-lg border" style={{ borderColor: 'var(--border-color)' }}>
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    🔍 Contexte technique capturé
                  </summary>
                  <div className="px-3 pb-3 text-[11px] font-mono space-y-1" style={{ color: 'var(--text-muted)' }}>
                    <div>Écran : {ctx.route}</div>
                    <div>Version : {ctx.app_version} · {ctx.screen}</div>
                    {Array.isArray(ctx.breadcrumb) && ctx.breadcrumb.length > 0 && (
                      <div>Parcours : {ctx.breadcrumb.map((b: { path: string }) => b.path).join(' → ')}</div>
                    )}
                    {Array.isArray(ctx.recent_errors) && ctx.recent_errors.length > 0 && (
                      <div style={{ color: 'var(--color-danger)' }}>Erreurs : {ctx.recent_errors.join(' | ')}</div>
                    )}
                    <div>Agent : {String(ctx.user_agent).slice(0, 90)}</div>
                  </div>
                </details>
              )}

              {/* Échanges */}
              <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Échanges</h4>
              <div className="space-y-2 mb-3">
                {(selected.comments ?? []).map((c) => (
                  <div key={c.id} className="rounded-lg px-3 py-2 text-sm"
                    style={{ backgroundColor: c.is_system ? 'transparent' : 'var(--bg-primary)', border: c.is_system ? 'none' : '1px solid var(--border-color)' }}>
                    {c.is_system ? (
                      <p className="text-[11px] italic" style={{ color: 'var(--text-muted)' }}>— {c.body} ({fmt(c.created_at)})</p>
                    ) : (
                      <>
                        <p className="text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{c.user_name} · {fmt(c.created_at)}</p>
                        <p className="whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{c.body}</p>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* Ajouter un échange */}
              <div className="flex gap-2">
                <input value={newComment} onChange={(e) => setNewComment(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addComment()}
                  placeholder="Ajouter un message…"
                  className="flex-1 rounded-lg border px-3 py-2 text-sm" style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                <button onClick={addComment} disabled={busy || !newComment.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ backgroundColor: 'var(--color-primary)' }}>
                  Envoyer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Visionneuse plein écran / Fullscreen image viewer */}
      {lightbox && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
          onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  )
}
