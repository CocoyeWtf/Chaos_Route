/* Dialogue d'import CSV/Excel / Import dialog for CSV/Excel files */

import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import api, { fetchAll } from '../../services/api'
import type { BaseLogistics } from '../../types'

interface DuplicateInfo {
  existing: { date?: string; dispatch_date?: string; dispatch_time?: string; base: string; count: number }[]
  total_existing: number
  new_row_count: number
  planned_tours?: string[]
  other_bases?: { base: string; count: number }[]
}

/* #87 — Le jour porte déjà des volumes d'autres bases : confirmer la base. */
interface BaseWarning {
  importing_base: string
  other_bases: { base: string; count: number }[]
  new_row_count: number
}

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  entityType: string
  onSuccess: () => void
}

export function ImportDialog({ open, onClose, entityType, onSuccess }: ImportDialogProps) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateInfo | null>(null)
  const [baseWarning, setBaseWarning] = useState<BaseWarning | null>(null)
  const [dispatchDate, setDispatchDate] = useState('')
  const [dispatchTime, setDispatchTime] = useState('')
  const [activityType, setActivityType] = useState('')
  const [promoStartDate, setPromoStartDate] = useState('')
  const [baseOriginId, setBaseOriginId] = useState('')
  const [temperatureClass, setTemperatureClass] = useState('')
  const [bases, setBases] = useState<BaseLogistics[]>([])

  useEffect(() => {
    if (entityType === 'volumes') {
      fetchAll<BaseLogistics>('/bases').then(setBases).catch(() => {})
    }
  }, [entityType])

  if (!open) return null

  const isVolumes = entityType === 'volumes'

  const doImport = async (mode: string) => {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)

    const formData = new FormData()
    formData.append('file', file)

    try {
      let url = `/imports/${entityType}?mode=${mode}`
      if (isVolumes && dispatchDate) {
        url += `&dispatch_date=${encodeURIComponent(dispatchDate)}`
        if (dispatchTime) url += `&dispatch_time=${encodeURIComponent(dispatchTime)}`
      }
      if (isVolumes && activityType) {
        url += `&activity_type=${encodeURIComponent(activityType)}`
        if (activityType === 'MEAV' && promoStartDate) url += `&promo_start_date=${encodeURIComponent(promoStartDate)}`
      }
      if (isVolumes && baseOriginId) {
        url += `&base_origin_id=${encodeURIComponent(baseOriginId)}`
      }
      if (isVolumes && temperatureClass) {
        url += `&temperature_class=${encodeURIComponent(temperatureClass)}`
      }
      const resp = await api.post(url, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })

      if (resp.data.status === 'duplicate_warning') {
        setDuplicateWarning(resp.data)
        return
      }
      if (resp.data.status === 'base_warning') {
        setBaseWarning(resp.data)
        return
      }
      setBaseWarning(null)

      setDuplicateWarning(null)
      setResult(resp.data.message || 'Import réussi')
      onSuccess()
    } catch (err: unknown) {
      // Le détail serveur dit POURQUOI (ex. #116 : remplacement refusé) /
      // Surface the server detail, not the generic axios message
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      const message = typeof detail === 'string' ? detail
        : err instanceof Error ? err.message : "Erreur lors de l'import"
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const handleImport = () => doImport('check')
  const handleReplace = () => { setDuplicateWarning(null); doImport('replace') }
  const handleAppend = () => { setDuplicateWarning(null); doImport('append') }

  const handleFileChange = (f: File | null) => {
    setFile(f)
    setDuplicateWarning(null)
    setBaseWarning(null)
    setError(null)
    setResult(null)
    setDispatchDate('')
    setDispatchTime('')
    setActivityType('')
    setPromoStartDate('')
    setBaseOriginId('')
    setTemperatureClass('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative rounded-xl border shadow-2xl w-full max-w-md"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            {t('common.import')} — {entityType}
          </h3>
          <button onClick={onClose} className="text-xl leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
        </div>

        <div className="p-6 space-y-4">
          <div
            className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors"
            style={{ borderColor: 'var(--border-color)' }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
            />
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {file ? file.name : t('import.dropOrClick')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>CSV, XLSX</p>
          </div>

          {/* Base d'origine + Température pour volumes / Base origin + Temperature for volumes */}
          {isVolumes && file && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                  Base d'origine
                </label>
                <select
                  value={baseOriginId}
                  onChange={(e) => setBaseOriginId(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border text-sm"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                >
                  <option value="">— (dans le fichier)</option>
                  {bases.map((b) => (
                    <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                  Température
                </label>
                <select
                  value={temperatureClass}
                  onChange={(e) => setTemperatureClass(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border text-sm"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                >
                  <option value="">— (dans le fichier)</option>
                  <option value="SEC">SEC</option>
                  <option value="FRAIS">FRAIS</option>
                  <option value="GEL">GEL</option>
                </select>
              </div>
            </div>
          )}

          {/* Champs date/heure répartition pour volumes / Dispatch date/time fields for volumes */}
          {isVolumes && file && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                  {t('import.dispatchDate')}
                </label>
                <input
                  type="date"
                  value={dispatchDate}
                  onChange={(e) => setDispatchDate(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border text-sm"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                  {t('import.dispatchTime')}
                </label>
                <input
                  type="time"
                  value={dispatchTime}
                  onChange={(e) => setDispatchTime(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border text-sm"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                />
              </div>
            </div>
          )}

          {/* Activité et date promo / Activity type and promo date */}
          {isVolumes && file && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                  Activité
                </label>
                <select
                  value={activityType}
                  onChange={(e) => { setActivityType(e.target.value); if (e.target.value !== 'MEAV') setPromoStartDate('') }}
                  className="w-full px-3 py-1.5 rounded-lg border text-sm"
                  style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                >
                  <option value="">— (optionnel)</option>
                  <option value="SUIVI">Suivi (fond de rayon)</option>
                  <option value="MEAV">Mise en avant (promo)</option>
                </select>
              </div>
              {activityType === 'MEAV' && (
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Date début promo
                  </label>
                  <input
                    type="date"
                    value={promoStartDate}
                    onChange={(e) => setPromoStartDate(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
              )}
            </div>
          )}

          {/* #87 : la journée porte déjà d'autres bases / Other bases already loaded */}
          {baseWarning && (
            <div className="rounded-lg border p-4 space-y-2" style={{ backgroundColor: 'rgba(249,115,22,0.08)', borderColor: 'var(--color-warning)' }}>
              <p className="text-sm font-semibold" style={{ color: 'var(--color-warning)' }}>
                Vous importez {baseWarning.new_row_count} ligne(s) sur <strong>{baseWarning.importing_base}</strong>
              </p>
              <p className="text-xs" style={{ color: 'var(--text-primary)' }}>
                Ce jour porte déjà des volumes de : {baseWarning.other_bases.map((b) => `${b.base} (${b.count})`).join(', ')}.
                Vérifiez que la base d'origine est la bonne.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => { setBaseWarning(null); doImport('append') }}
                  disabled={loading}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-primary)' }}
                >
                  {loading ? '...' : 'Confirmer la base et importer'}
                </button>
                <button
                  onClick={() => setBaseWarning(null)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
                >
                  Corriger
                </button>
              </div>
            </div>
          )}

          {/* Alerte doublons / Duplicate warning */}
          {duplicateWarning && (
            <div className="rounded-lg border p-4 space-y-2" style={{ backgroundColor: 'rgba(249,115,22,0.08)', borderColor: 'var(--color-warning)' }}>
              <p className="text-sm font-semibold" style={{ color: 'var(--color-warning)' }}>
                {t('import.duplicateWarning')}
              </p>
              <ul className="text-xs space-y-0.5" style={{ color: 'var(--text-primary)' }}>
                {duplicateWarning.existing.map((e, i) => (
                  <li key={i}>
                    {e.dispatch_date
                      ? t('import.duplicateDetailDispatch', { dispatch_date: e.dispatch_date, dispatch_time: e.dispatch_time || '', base: e.base, count: e.count })
                      : t('import.duplicateDetail', { date: e.date, base: e.base, count: e.count })}
                  </li>
                ))}
              </ul>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {t('import.totalExisting', { count: duplicateWarning.total_existing })}
                {' — '}
                {t('import.newRows', { count: duplicateWarning.new_row_count })}
              </p>
              {duplicateWarning.other_bases && duplicateWarning.other_bases.length > 0 && (
                <p className="text-xs" style={{ color: 'var(--text-primary)' }}>
                  Ce jour porte aussi des volumes de : {duplicateWarning.other_bases.map((b) => `${b.base} (${b.count})`).join(', ')}.
                </p>
              )}
              {duplicateWarning.planned_tours && duplicateWarning.planned_tours.length > 0 && (
                <p className="text-xs font-semibold" style={{ color: 'var(--color-danger)' }}>
                  {duplicateWarning.planned_tours.length} tournée(s) utilisent déjà ces volumes
                  ({duplicateWarning.planned_tours.slice(0, 8).join(', ')}{duplicateWarning.planned_tours.length > 8 ? ' …' : ''}).
                  Le remplacement est impossible tant qu'elles existent : il viderait ces tournées.
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleReplace}
                  disabled={loading || (duplicateWarning.planned_tours?.length ?? 0) > 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-danger)' }}
                >
                  {loading ? '...' : t('import.replaceExisting')}
                </button>
                <button
                  onClick={handleAppend}
                  disabled={loading}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50"
                  style={{ borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
                >
                  {loading ? '...' : t('import.appendAnyway')}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm px-3 py-2 rounded-lg" style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: 'var(--color-danger)' }}>
              {error}
            </p>
          )}

          {result && (
            <p className="text-sm px-3 py-2 rounded-lg" style={{ backgroundColor: 'rgba(34,197,94,0.1)', color: 'var(--color-success)' }}>
              {result}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              {t('common.cancel')}
            </button>
            {!duplicateWarning && !baseWarning && (
              <button
                onClick={handleImport}
                disabled={!file || loading}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--color-primary)' }}
              >
                {loading ? t('common.loading') : t('common.import')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
