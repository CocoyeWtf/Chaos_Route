/* Modale de création de ticket — réutilisée par le bouton flottant « Signaler »
   et par le bouton « + Nouveau ticket » du board. Capture le contexte à l'envoi. */

import { useEffect, useMemo, useState } from 'react'
import api from '../../services/api'
import { captureContext } from '../../services/supportContext'
import { useAppStore } from '../../stores/useAppStore'
import type { Ticket, TicketType, TicketPriority } from '../../types'

const TYPES: { v: TicketType; label: string }[] = [
  { v: 'BUG', label: '🐞 Bug' },
  { v: 'FEATURE', label: '✨ Évolution' },
  { v: 'QUESTION', label: '❓ Question' },
]
const PRIOS: { v: TicketPriority; label: string }[] = [
  { v: 'LOW', label: 'Basse' },
  { v: 'MEDIUM', label: 'Moyenne' },
  { v: 'HIGH', label: 'Haute' },
  { v: 'CRITICAL', label: 'Critique' },
]

interface Props {
  open: boolean
  onClose: () => void
  onCreated?: (ticket: Ticket) => void
}

export function CreateTicketModal({ open, onClose, onCreated }: Props) {
  const { selectedRegionId, selectedCountryId } = useAppStore()
  const [type, setType] = useState<TicketType>('BUG')
  const [priority, setPriority] = useState<TicketPriority>('MEDIUM')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)

  const MAX_PHOTOS = 5
  /* Aperçus locaux (révoqués au changement) / Local previews (revoked on change) */
  const previews = useMemo(() => files.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })), [files])
  useEffect(() => () => { previews.forEach((p) => URL.revokeObjectURL(p.url)) }, [previews])

  /* Ticket #19 : coller une capture d'écran (Ctrl+V) plutôt que de parcourir
     l'explorateur. Écoute globale tant que la modale est ouverte. / Paste a
     screenshot from the clipboard while the modal is open. */
  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent) => {
      const imgs = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (imgs.length) {
        e.preventDefault()
        setFiles((prev) => [...prev, ...imgs].slice(0, MAX_PHOTOS))
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [open])

  const reset = () => { setTitle(''); setDescription(''); setType('BUG'); setPriority('MEDIUM'); setFiles([]) }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'))
    setFiles((prev) => [...prev, ...picked].slice(0, MAX_PHOTOS))
    e.target.value = '' // permet de re-sélectionner le même fichier
  }
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i))

  const submit = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      const context = captureContext({ region_id: selectedRegionId, country_id: selectedCountryId })
      const { data } = await api.post<Ticket>('/tickets/', {
        title: title.trim(),
        description: description.trim() || null,
        ticket_type: type,
        priority,
        context,
      })
      // Joindre les photos sélectionnées au ticket créé / Attach selected photos
      for (const f of files) {
        const fd = new FormData()
        fd.append('file', f)
        try {
          await api.post(`/tickets/${data.id}/photos`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        } catch (err) {
          console.error('Upload photo échoué', err)
        }
      }
      reset()
      onClose()
      onCreated?.(data)
    } catch (e) {
      console.error('Création ticket échouée', e)
      alert("Échec de la création du ticket.")
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-md"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Nouveau ticket</h3>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Le contexte (écran, version, erreurs récentes) est joint automatiquement.
            Si vous avez lancé un enregistrement, son déroulé (clics, navigation, erreurs
            réseau, notes épinglées) est également joint.
          </p>

          <div className="flex gap-2 mb-3">
            {TYPES.map((t) => (
              <button key={t.v} onClick={() => setType(t.v)}
                className="flex-1 px-2 py-1.5 rounded-lg border text-xs font-medium transition-all"
                style={{
                  borderColor: type === t.v ? 'var(--color-primary)' : 'var(--border-color)',
                  backgroundColor: type === t.v ? 'rgba(249,115,22,0.1)' : 'var(--bg-primary)',
                  color: type === t.v ? 'var(--color-primary)' : 'var(--text-secondary)',
                }}>{t.label}</button>
            ))}
          </div>

          <input
            value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
            placeholder="Titre court (ex. « bouton export ne répond pas »)"
            className="w-full px-3 py-2 rounded-lg border text-sm mb-3"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)} rows={4}
            placeholder="Décris ce qui s'est passé ou ce que tu veux…"
            className="w-full px-3 py-2 rounded-lg border text-sm mb-3 resize-none"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />

          {/* Photos / captures d'écran (illustrer le problème) */}
          <div className="mb-3">
            <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>
              Photos / captures d'écran <span className="opacity-70">(max {MAX_PHOTOS}, 5 Mo — ou collez avec Ctrl+V)</span>
            </label>
            {previews.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mb-2">
                {previews.map((p, i) => (
                  <div key={p.url} className="relative group">
                    <img src={p.url} alt={p.name} className="w-full h-16 object-cover rounded-lg border"
                      style={{ borderColor: 'var(--border-color)' }} />
                    <button type="button" onClick={() => removeFile(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full text-white text-xs flex items-center justify-center"
                      style={{ backgroundColor: 'var(--color-danger)' }} title="Retirer">×</button>
                  </div>
                ))}
              </div>
            )}
            {files.length < MAX_PHOTOS && (
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-all hover:opacity-80"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-primary)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                Ajouter une photo
                <input type="file" accept="image/*" multiple onChange={onPickFiles} className="hidden" />
              </label>
            )}
          </div>

          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Priorité</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}
              className="px-2 py-1.5 rounded-lg border text-xs"
              style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
              {PRIOS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>Annuler</button>
            <button onClick={submit} disabled={saving || !title.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--color-primary)' }}>
              {saving ? '...' : 'Envoyer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
