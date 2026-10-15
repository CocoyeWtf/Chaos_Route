/* Fiche détaillée d'un tour (overlay imprimable) / Printable tour detail sheet */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { displayDateTime, formatDate } from '../../utils/tourTimeUtils'
import api from '../../services/api'
import { useAuthStore } from '../../stores/useAuthStore'
import { PasswordConfirmDialog } from '../data/PasswordConfirmDialog'

interface TourStop {
  sequence_order: number
  pdv_code: string
  pdv_name: string
  eqp_count: number
  distance_from_previous_km: number
  duration_from_previous_minutes: number
  arrival_time?: string
  departure_time?: string
  pickup_cardboard?: boolean
  pickup_containers?: boolean
  pickup_returns?: boolean
  pickup_consignment?: boolean
}

interface CostBreakdown {
  fuel_cost: number
  km_tax_total: number
  surcharges_total?: number
  total_calculated: number
}

interface TimeBreakdown {
  travel_minutes: number
  dock_minutes: number
  unload_minutes: number
  total_minutes: number
}

interface SurchargeTypeOption {
  id: number
  code: string
  label: string
  is_active: boolean
}

interface Surcharge {
  id: number
  tour_id: number
  amount: number
  surcharge_type_id: number | null
  surcharge_type_label: string
  comment: string | null
  motif: string
  status: string
  created_by_id: number
  created_at: string
  validated_by_id: number | null
  validated_at: string | null
  created_by_username: string
  validated_by_username: string | null
}

export interface TourDetailData {
  tour_id: number
  tour_code: string
  date: string
  base_code: string
  base_name: string
  departure_time?: string
  return_time?: string
  total_km: number
  total_eqp: number
  total_duration_minutes: number
  total_cost: number
  status: string
  driver_name?: string
  driver_arrival_time?: string
  loading_end_time?: string
  barrier_exit_time?: string
  barrier_entry_time?: string
  remarks?: string
  cost_breakdown: CostBreakdown
  time_breakdown?: TimeBreakdown
  stops: TourStop[]
  /* Contexte contrat (injecté par la page parent) / Contract context (injected by parent) */
  contract_code?: string
  transporter_name?: string
  vehicle_code?: string
  vehicle_name?: string
}

interface TourDetailSheetProps {
  tour: TourDetailData
  onClose: () => void
  onSurchargesChanged?: () => void
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h${String(m).padStart(2, '0')}`
}

export function TourDetailSheet({ tour, onClose, onSurchargesChanged }: TourDetailSheetProps) {
  const { t } = useTranslation()
  const hasPermission = useAuthStore((s) => s.hasPermission)

  const handlePrint = () => window.print()

  /* ---- Surcharges state ---- */
  const [surcharges, setSurcharges] = useState<Surcharge[]>([])
  const [surchargeLoading, setSurchargeLoading] = useState(false)
  const [surchargeError, setSurchargeError] = useState<string | null>(null)
  const [surchargesDirty, setSurchargesDirty] = useState(false)

  /* Types de surcharge / Surcharge types */
  const [surchargeTypes, setSurchargeTypes] = useState<SurchargeTypeOption[]>([])

  /* Formulaire ajout / Add form */
  const [showAddForm, setShowAddForm] = useState(false)
  const [addAmount, setAddAmount] = useState('')
  const [addTypeId, setAddTypeId] = useState('')
  const [addComment, setAddComment] = useState('')
  const [addLoading, setAddLoading] = useState(false)

  /* Dialogs validation/suppression / Validate/delete dialogs */
  const [validatingId, setValidatingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [dialogLoading, setDialogLoading] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const canRead = hasPermission('surcharges', 'read')
  const canCreate = hasPermission('surcharges', 'create')
  const canUpdate = hasPermission('surcharges', 'update')
  const canDelete = hasPermission('surcharges', 'delete')

  const fetchSurcharges = useCallback(async () => {
    if (!canRead) return
    setSurchargeLoading(true)
    setSurchargeError(null)
    try {
      const { data } = await api.get<Surcharge[]>(`/surcharges/by-tour/${tour.tour_id}`)
      setSurcharges(data)
    } catch {
      setSurchargeError('Erreur chargement surcharges')
    } finally {
      setSurchargeLoading(false)
    }
  }, [tour.tour_id, canRead])

  useEffect(() => {
    fetchSurcharges()
  }, [fetchSurcharges])

  useEffect(() => {
    api.get<SurchargeTypeOption[]>('/surcharge-types/', { params: { is_active: true } })
      .then(({ data }) => setSurchargeTypes(data))
      .catch(() => {})
  }, [])

  const handleAddSurcharge = async () => {
    const amount = parseFloat(addAmount)
    if (!amount || amount <= 0 || !addTypeId) return
    setAddLoading(true)
    try {
      await api.post('/surcharges/', {
        tour_id: tour.tour_id,
        amount,
        surcharge_type_id: Number(addTypeId),
        comment: addComment.trim() || null,
      })
      setAddAmount('')
      setAddTypeId('')
      setAddComment('')
      setShowAddForm(false)
      setSurchargesDirty(true)
      await fetchSurcharges()
    } catch {
      setSurchargeError('Erreur création surcharge')
    } finally {
      setAddLoading(false)
    }
  }

  const handleValidate = async (password: string) => {
    if (validatingId === null) return
    setDialogLoading(true)
    setDialogError(null)
    try {
      await api.post(`/surcharges/${validatingId}/validate`, { password })
      setValidatingId(null)
      setSurchargesDirty(true)
      await fetchSurcharges()
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } } }
      if (err.response?.status === 403) {
        setDialogError('Mot de passe incorrect')
      } else {
        setDialogError(err.response?.data?.detail || 'Erreur validation')
      }
    } finally {
      setDialogLoading(false)
    }
  }

  const handleDelete = async (password: string) => {
    if (deletingId === null) return
    setDialogLoading(true)
    setDialogError(null)
    try {
      await api.delete(`/surcharges/${deletingId}`, { data: { password } })
      setDeletingId(null)
      setSurchargesDirty(true)
      await fetchSurcharges()
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } } }
      if (err.response?.status === 403) {
        setDialogError('Mot de passe incorrect')
      } else {
        setDialogError(err.response?.data?.detail || 'Erreur suppression')
      }
    } finally {
      setDialogLoading(false)
    }
  }

  const validatedTotal = surcharges
    .filter((s) => s.status === 'VALIDATED')
    .reduce((sum, s) => sum + s.amount, 0)

  /* Coût de base (sans surcharges) + surcharges locales → total dynamique
     Base cost (without surcharges) + local surcharges → dynamic total */
  const baseCost = tour.cost_breakdown.total_calculated - (tour.cost_breakdown.surcharges_total || 0)
  const dynamicTotal = Math.round((baseCost + validatedTotal) * 100) / 100

  const handleClose = () => {
    if (surchargesDirty && onSurchargesChanged) onSurchargesChanged()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 overflow-auto print-overlay" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Toolbar (masquée à l'impression / hidden on print) */}
      <div
        className="print-hide sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
      >
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          {t('transporterSummary.tourDetail')} — {tour.tour_code}
        </h2>
        <div className="flex gap-2">
          <button
            onClick={handlePrint}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
            style={{ backgroundColor: 'var(--color-primary)', color: 'white' }}
          >
            {t('transporterSummary.print')}
          </button>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
          >
            {t('transporterSummary.close')}
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Section 1 — Infos tour / Tour info */}
        <section className="rounded-xl border p-5" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
            {t('transporterSummary.tourInfo')}
          </h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <InfoRow label={t('transporterSummary.tourCode')} value={tour.tour_code} />
            <InfoRow label={t('transporterSummary.date')} value={formatDate(tour.date)} />
            <InfoRow label={t('transporterSummary.base')} value={`${tour.base_code} — ${tour.base_name}`} />
            <InfoRow label={t('common.status')} value={tour.status} />
            {tour.contract_code && (
              <InfoRow label={t('transporterSummary.contract')} value={tour.contract_code} />
            )}
            {tour.transporter_name && (
              <InfoRow label={t('transporterSummary.transporter')} value={tour.transporter_name} />
            )}
            {tour.vehicle_code && (
              <InfoRow label={t('transporterSummary.vehicle')} value={`${tour.vehicle_code} — ${tour.vehicle_name || ''}`} />
            )}
            <InfoRow label={t('transporterSummary.departure')} value={tour.departure_time || '—'} />
            <InfoRow label={t('transporterSummary.return')} value={tour.return_time || '—'} />
            <InfoRow label={t('transporterSummary.duration')} value={formatDuration(tour.total_duration_minutes)} />
            <InfoRow label={t('transporterSummary.km')} value={`${tour.total_km.toFixed(1)} km`} />
            <InfoRow label={t('transporterSummary.eqp')} value={String(tour.total_eqp)} />
          </div>
        </section>

        {/* Section 2 — Coût / Cost breakdown */}
        <section className="rounded-xl border p-5" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
            {t('transporterSummary.costBreakdown')}
          </h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <InfoRow label={t('transporterSummary.fuelCost')} value={`${tour.cost_breakdown.fuel_cost.toFixed(2)} \u20AC`} />
            <InfoRow label={t('transporterSummary.kmTax')} value={`${tour.cost_breakdown.km_tax_total.toFixed(2)} \u20AC`} />
            {validatedTotal > 0 && (
              <InfoRow label="Surcharges" value={`${validatedTotal.toFixed(2)} \u20AC`} />
            )}
          </div>
          <div
            className="mt-3 rounded-lg p-3 flex items-center justify-between"
            style={{ backgroundColor: 'rgba(249,115,22,0.08)', borderLeft: '4px solid var(--color-primary)' }}
          >
            <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              {t('transporterSummary.totalCost')}
            </span>
            <span className="text-lg font-bold" style={{ color: 'var(--color-primary)' }}>
              {dynamicTotal.toFixed(2)} &euro;
            </span>
          </div>
        </section>

        {/* Section 2b — Temps / Time breakdown */}
        {tour.time_breakdown && (
          <section className="rounded-xl border p-5" style={{ borderColor: 'var(--border-color)' }}>
            <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
              {t('timeBreakdown.title')}
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <InfoRow label={t('timeBreakdown.travelTime')} value={formatDuration(tour.time_breakdown.travel_minutes)} />
              <InfoRow label={t('timeBreakdown.dockTime')} value={formatDuration(tour.time_breakdown.dock_minutes)} />
              <InfoRow label={t('timeBreakdown.unloadTime')} value={formatDuration(tour.time_breakdown.unload_minutes)} />
            </div>
            <div
              className="mt-3 rounded-lg p-3 flex items-center justify-between"
              style={{ backgroundColor: 'rgba(59,130,246,0.08)', borderLeft: '4px solid var(--color-info, #3b82f6)' }}
            >
              <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {t('timeBreakdown.totalTime')}
              </span>
              <span className="text-lg font-bold" style={{ color: 'var(--color-info, #3b82f6)' }}>
                {formatDuration(tour.time_breakdown.total_minutes)}
              </span>
            </div>
          </section>
        )}

        {/* Section 2c — Surcharges */}
        {canRead && (
          <section className="rounded-xl border p-5 print-hide" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                Surcharges
              </h3>
              {canCreate && (
                <button
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="px-3 py-1 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                  style={{ backgroundColor: 'var(--color-primary)', color: 'white' }}
                >
                  {showAddForm ? 'Annuler' : '+ Ajouter'}
                </button>
              )}
            </div>

            {surchargeError && (
              <p className="text-xs mb-2" style={{ color: 'var(--color-danger)' }}>{surchargeError}</p>
            )}

            {/* Formulaire ajout / Add form */}
            {showAddForm && (
              <div
                className="mb-4 p-3 rounded-lg border space-y-2"
                style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}
              >
                <div className="flex gap-2">
                  <div className="flex flex-col flex-shrink-0" style={{ width: '120px' }}>
                    <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Montant (EUR)</label>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={addAmount}
                      onChange={(e) => setAddAmount(e.target.value)}
                      className="px-2 py-1.5 rounded-lg border text-sm"
                      style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    />
                  </div>
                  <div className="flex flex-col flex-1">
                    <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Type de surcharge</label>
                    <select
                      value={addTypeId}
                      onChange={(e) => setAddTypeId(e.target.value)}
                      className="px-2 py-1.5 rounded-lg border text-sm"
                      style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    >
                      <option value="">-- Sélectionner --</option>
                      {surchargeTypes.map((st) => (
                        <option key={st.id} value={st.id}>{st.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex flex-col">
                  <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Commentaire (optionnel)</label>
                  <input
                    type="text"
                    value={addComment}
                    onChange={(e) => setAddComment(e.target.value)}
                    maxLength={500}
                    placeholder="Commentaire libre..."
                    className="px-2 py-1.5 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={handleAddSurcharge}
                    disabled={addLoading || !addAmount || !addTypeId}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: 'var(--color-primary)' }}
                  >
                    {addLoading ? '...' : 'Créer'}
                  </button>
                </div>
              </div>
            )}

            {/* Liste surcharges */}
            {surchargeLoading ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Chargement...</p>
            ) : surcharges.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Aucune surcharge</p>
            ) : (
              <div className="space-y-2">
                {surcharges.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between p-2 rounded-lg border text-sm"
                    style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs font-medium"
                        style={{
                          backgroundColor: s.status === 'VALIDATED' ? 'rgba(34,197,94,0.15)' : 'rgba(249,115,22,0.15)',
                          color: s.status === 'VALIDATED' ? '#22c55e' : '#f97316',
                        }}
                      >
                        {s.status === 'VALIDATED' ? 'Validée' : 'En attente'}
                      </span>
                      <span className="font-bold" style={{ color: 'var(--color-danger)' }}>
                        {s.amount.toFixed(2)} &euro;
                      </span>
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        {s.surcharge_type_label || s.motif}
                      </span>
                      {s.comment && (
                        <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }} title={s.comment}>
                          {s.comment}
                        </span>
                      )}
                      <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                        par {s.created_by_username}
                        {s.validated_by_username && ` — validée par ${s.validated_by_username}`}
                      </span>
                    </div>
                    <div className="flex gap-1 flex-shrink-0 ml-2">
                      {s.status === 'PENDING' && canUpdate && (
                        <button
                          onClick={() => { setValidatingId(s.id); setDialogError(null) }}
                          className="px-2 py-1 rounded text-xs font-medium text-white"
                          style={{ backgroundColor: '#22c55e' }}
                        >
                          Valider
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => { setDeletingId(s.id); setDialogError(null) }}
                          className="px-2 py-1 rounded text-xs font-medium text-white"
                          style={{ backgroundColor: 'var(--color-danger)' }}
                        >
                          Suppr.
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Total surcharges validées */}
            {validatedTotal > 0 && (
              <div
                className="mt-3 rounded-lg p-3 flex items-center justify-between"
                style={{ backgroundColor: 'rgba(239,68,68,0.08)', borderLeft: '4px solid var(--color-danger)' }}
              >
                <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                  Total surcharges validées
                </span>
                <span className="text-lg font-bold" style={{ color: 'var(--color-danger)' }}>
                  {validatedTotal.toFixed(2)} &euro;
                </span>
              </div>
            )}
          </section>
        )}

        {/* Section 3 — Itinéraire / Itinerary */}
        <section className="rounded-xl border p-5" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
            {t('transporterSummary.itinerary')}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left pb-2 font-medium whitespace-nowrap">{t('transporterSummary.sequence')}</th>
                  <th className="text-left pb-2 font-medium whitespace-nowrap">{t('transporterSummary.pdvCode')}</th>
                  <th className="text-left pb-2 font-medium whitespace-nowrap">{t('transporterSummary.pdvName')}</th>
                  <th className="text-right pb-2 font-medium whitespace-nowrap">{t('transporterSummary.km')}</th>
                  <th className="text-right pb-2 font-medium whitespace-nowrap">{t('transporterSummary.duration')}</th>
                  <th className="text-right pb-2 font-medium whitespace-nowrap">{t('transporterSummary.arrivalTime')}</th>
                  <th className="text-right pb-2 font-medium whitespace-nowrap">{t('transporterSummary.eqp')}</th>
                  <th className="text-center pb-2 font-medium whitespace-nowrap">{t('transporterSummary.pickups')}</th>
                  <th className="text-right pb-2 font-medium whitespace-nowrap">{t('transporterSummary.departureTime')}</th>
                </tr>
              </thead>
              <tbody>
                {tour.stops.map((stop) => (
                  <tr key={stop.sequence_order} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                    <td className="py-1.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{stop.sequence_order}</td>
                    <td className="py-1.5 font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{stop.pdv_code}</td>
                    <td className="py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{stop.pdv_name}</td>
                    <td className="py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {stop.distance_from_previous_km.toFixed(1)}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {stop.duration_from_previous_minutes}′
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      {stop.arrival_time || '—'}
                    </td>
                    <td className="py-1.5 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      {stop.eqp_count}
                    </td>
                    <td className="py-1.5 text-center whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {[
                        stop.pickup_cardboard && 'C',
                        stop.pickup_containers && 'B',
                        stop.pickup_returns && 'R',
                        stop.pickup_consignment && 'K',
                      ].filter(Boolean).join('/') || '—'}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                      {stop.departure_time || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 4 — Opérationnel / Operational */}
        <section className="rounded-xl border p-5" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-base font-bold mb-3" style={{ color: 'var(--text-primary)' }}>
            {t('transporterSummary.operationalInfo')}
          </h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <InfoRow label={t('transporterSummary.driverName')} value={tour.driver_name || '—'} />
            <InfoRow label={t('transporterSummary.driverArrival')} value={displayDateTime(tour.driver_arrival_time)} />
            <InfoRow label={t('transporterSummary.loadingEnd')} value={displayDateTime(tour.loading_end_time)} />
            <InfoRow label={t('transporterSummary.barrierExit')} value={displayDateTime(tour.barrier_exit_time)} />
            <InfoRow label={t('transporterSummary.barrierEntry')} value={displayDateTime(tour.barrier_entry_time)} />
          </div>
          {tour.remarks && (
            <div className="mt-3 p-3 rounded-lg text-sm" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
              <span className="font-medium" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.remarks')} : </span>
              {tour.remarks}
            </div>
          )}
        </section>
      </div>

      {/* Dialogs confirmation par mot de passe */}
      <PasswordConfirmDialog
        open={validatingId !== null}
        onClose={() => { setValidatingId(null); setDialogError(null) }}
        onConfirm={handleValidate}
        title="Valider la surcharge"
        message="Saisissez votre mot de passe pour confirmer la validation."
        loading={dialogLoading}
        error={dialogError}
      />
      <PasswordConfirmDialog
        open={deletingId !== null}
        onClose={() => { setDeletingId(null); setDialogError(null) }}
        onConfirm={handleDelete}
        title="Supprimer la surcharge"
        message="Saisissez votre mot de passe pour confirmer la suppression."
        loading={dialogLoading}
        danger
        error={dialogError}
      />
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}
