/* Contrôles « support » intégrés à la barre du haut (à gauche du sélecteur de
   langue) :
   - « ● » : lance une capture de session À LA DEMANDE (rien n'est capturé avant).
     Pendant l'enregistrement : chrono + panneau de notes pour épingler des
     commentaires aux moments clés, puis « Arrêter » ou « Créer le ticket ».
   - « 🎫 Signaler » : ouvre la modale de création de ticket (le contexte et
     l'éventuel enregistrement sont joints automatiquement).

   Ticket #16 : ces contrôles étaient auparavant un cluster flottant en bas à
   droite (`fixed bottom-4 right-4`) qui recouvrait les flèches de pagination des
   onglets. Ils vivent désormais dans le header ; le panneau d'enregistrement est
   un popover ancré sous la barre, il n'obstrue plus le contenu. */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CreateTicketModal } from './CreateTicketModal'
import {
  recordUserNote, startRecording, stopRecording, clearSession,
  isRecording, recordingElapsedMs, recordedEventCount,
} from '../../services/supportContext'

function mmss(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function ReportButton() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [recording, setRecording] = useState(isRecording())
  const [panelOpen, setPanelOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [evtCount, setEvtCount] = useState(0)
  const [note, setNote] = useState('')
  const [savedNote, setSavedNote] = useState(false)

  /* Chrono + compteur d'événements pendant l'enregistrement */
  useEffect(() => {
    if (!recording) return
    const id = setInterval(() => {
      setElapsed(Math.floor(recordingElapsedMs() / 1000))
      setEvtCount(recordedEventCount())
    }, 1000)
    return () => clearInterval(id)
  }, [recording])

  const start = () => { startRecording(); setRecording(true); setPanelOpen(true); setElapsed(0); setEvtCount(0) }
  const stop = () => { stopRecording(); setRecording(false); setPanelOpen(false) }
  const addNote = () => {
    const n = note.trim()
    if (n) { recordUserNote(n); setSavedNote(true); setTimeout(() => setSavedNote(false), 1400) }
    setNote('')
  }

  return (
    <>
      {/* Contrôles compacts intégrés à la barre du haut / Compact top-bar controls */}
      <div className="flex items-center gap-1.5 print-hide">
        {recording ? (
          <button
            onClick={() => setPanelOpen((v) => !v)}
            title="Enregistrement en cours — ouvrir le panneau"
            className="h-8 inline-flex items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors hover:opacity-80"
            style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
          >
            <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: 'var(--color-danger)' }} />
            {mmss(elapsed)}
          </button>
        ) : (
          <button
            onClick={start}
            title="Enregistrer une courte session pour illustrer un bug (rien n'est capturé avant de démarrer)"
            className="h-8 w-8 inline-flex items-center justify-center rounded-lg border transition-colors hover:opacity-80"
            style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
          >
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'var(--color-danger)' }} />
          </button>
        )}
        <button
          onClick={() => setOpen(true)}
          className="h-8 inline-flex items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white transition-all hover:opacity-90"
          style={{ backgroundColor: 'var(--color-primary)' }}
          title="Signaler un bug ou une demande (contexte capturé automatiquement)"
        >
          🎫 Signaler
        </button>
      </div>

      {/* Panneau d'enregistrement : popover ancré sous la barre du haut (fixed) —
          n'obstrue plus le contenu ni la pagination en bas de page. */}
      {recording && panelOpen && (
        <div
          className="fixed top-16 right-4 z-50 rounded-xl shadow-lg p-3 w-72 print-hide"
          style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--color-danger)' }}>
              <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--color-danger)' }} />
              Enregistrement {mmss(elapsed)}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{evtCount} évén.</span>
          </div>

          {/* Zone de notes : épingler un commentaire à l'instant courant */}
          <div className="flex items-center gap-1 mb-1">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addNote() }}
              placeholder="Note : ce qui se passe ici…"
              className="flex-1 text-xs px-2 py-1.5 rounded-md outline-none"
              style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
            />
            <button
              onClick={addNote}
              title="Épingler la note à cet instant de l'enregistrement"
              className="text-sm px-2 py-1.5 rounded-md font-semibold text-white shrink-0"
              style={{ backgroundColor: 'var(--color-primary)' }}
            >
              📌
            </button>
          </div>
          <p className="text-[10px] mb-2 h-3" style={{ color: 'var(--color-success)' }}>{savedNote ? '✓ Note ajoutée' : ''}</p>

          <div className="flex gap-1">
            <button
              onClick={stop}
              className="flex-1 text-xs px-2 py-1.5 rounded-md font-semibold"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              ⏹ Arrêter
            </button>
            <button
              onClick={() => setOpen(true)}
              className="flex-1 text-xs px-2 py-1.5 rounded-md font-semibold text-white"
              style={{ backgroundColor: 'var(--color-primary)' }}
            >
              🎫 Créer le ticket
            </button>
          </div>
        </div>
      )}

      <CreateTicketModal
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(t) => { clearSession(); setRecording(false); setPanelOpen(false); navigate(`/tickets?focus=${t.id}`) }}
      />
    </>
  )
}
