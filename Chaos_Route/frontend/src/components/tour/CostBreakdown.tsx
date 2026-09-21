/* Modal détail du calcul de coût / Cost calculation breakdown modal */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import api from '../../services/api'

interface SegmentDetail {
  origin: string
  destination: string
  distance_km: number
  segment_tax: number
}

interface CostBreakdownData {
  tour_id: number
  tour_code: string
  tour_date?: string
  total_km: number
  total_cost_stored: number
  total_cost_calculated: number
  message?: string
  contract?: {
    code: string
    transporter_name: string
    fixed_daily_cost: number
    vacation: number
    consumption_coefficient: number
  }
  fixed_cost?: {
    daily_cost: number
    nb_tours_today: number
    share: number
  }
  /* Terme km et terme remorque (#59) : facturés par l'extraction, ils
     n'apparaissaient nulle part dans le coût de la tournée. */
  km_term?: {
    total_km: number
    cost_per_km: number
    cost: number
  }
  trailer_term?: {
    daily_cost: number
    nb_tours_today: number
    own_trailer: boolean
    cost: number
  }
  vacation_cost?: {
    daily_cost: number
    nb_tours_today: number
    share: number
  }
  fuel_cost?: {
    total_km: number
    fuel_price_per_liter: number
    consumption_coefficient: number
    cost: number
  }
  km_tax?: {
    total: number
    segments: SegmentDetail[]
  }
  warnings?: string[]
}

interface CostBreakdownProps {
  tourId: number
  onClose: () => void
}

export function CostBreakdown({ tourId, onClose }: CostBreakdownProps) {
  const { t } = useTranslation()
  const [data, setData] = useState<CostBreakdownData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const { data: res } = await api.get<CostBreakdownData>(`/tours/${tourId}/cost-breakdown`)
        setData(res)
      } catch (e: unknown) {
        const err = e as { response?: { status?: number; data?: { detail?: string } }; message?: string }
        const detail = err?.response?.data?.detail || err?.message || 'Unknown error'
        const status = err?.response?.status
        setError(`${t('costBreakdown.error')} (${status ?? '?'}: ${detail})`)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [tourId, t])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl border shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {t('costBreakdown.title')}
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:opacity-80 text-lg"
            style={{ color: 'var(--text-muted)' }}
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-5">
          {loading && (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>...</div>
          )}

          {error && (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--color-danger)' }}>{error}</div>
          )}

          {data && !data.contract && (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('costBreakdown.noContract')}
            </div>
          )}

          {data?.warnings && data.warnings.length > 0 && (
            <div
              className="rounded-xl p-3 text-sm font-medium flex items-start gap-2"
              style={{ backgroundColor: 'rgba(245,158,11,0.1)', borderLeft: '4px solid var(--color-warning)', color: 'var(--color-warning)' }}
            >
              <span>&#9888;</span>
              <div>
                {data.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            </div>
          )}

          {data && data.contract && (
            <>
              {/* Tour info */}
              <div className="flex items-center justify-between text-sm">
                <div>
                  <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{data.tour_code}</span>
                  <span className="ml-2" style={{ color: 'var(--text-muted)' }}>{data.tour_date}</span>
                </div>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {data.contract.code} — {data.contract.transporter_name}
                </span>
              </div>

              {/* Formula */}
              <div
                className="rounded-xl p-4 text-xs font-mono"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
              >
                {t('costBreakdown.formula')}:
                {/* Une seule vacation (#58) : la formule additionnait le terme fixe
                    ET la vacation, deux noms du même montant — le coût affiché
                    était donc gonflé de moitié. */}
                <div className="mt-1 font-bold" style={{ color: 'var(--text-primary)' }}>
                  ({data.vacation_cost?.daily_cost ?? 0} / {data.vacation_cost?.nb_tours_today ?? 1})
                  {(data.km_term?.cost_per_km ?? 0) > 0 && (
                    <>{' + '}({data.total_km} x {data.km_term?.cost_per_km})</>
                  )}
                  {(data.trailer_term?.cost ?? 0) > 0 && (
                    <>{' + '}({data.trailer_term?.daily_cost} / {data.trailer_term?.nb_tours_today})</>
                  )}
                  {' + '}({data.total_km} x {data.fuel_cost?.fuel_price_per_liter ?? 0} x {data.fuel_cost?.consumption_coefficient ?? 0})
                  {' + '}{t('costBreakdown.kmTaxSum')}
                </div>
              </div>

              {/* 1. Vacation — anciennement scindée en « terme fixe » + « vacation »,
                     additionnés alors qu'il s'agit du même montant (#58). */}
              {(data.vacation_cost?.daily_cost ?? 0) > 0 && (
                <Section
                  title={`1. Vacation`}
                  amount={data.vacation_cost?.share ?? 0}
                >
                  <Row label={t('costBreakdown.vacationDaily')} value={`${data.vacation_cost?.daily_cost ?? 0} €`} />
                  <Row label={t('costBreakdown.nbToursToday')} value={String(data.vacation_cost?.nb_tours_today ?? 1)} />
                  <Row
                    label={t('costBreakdown.share')}
                    value={`${data.vacation_cost?.daily_cost ?? 0} / ${data.vacation_cost?.nb_tours_today ?? 1} = ${data.vacation_cost?.share ?? 0} €`}
                    bold
                  />
                </Section>
              )}

              {/* 1b. Terme km (#59) */}
              {(data.km_term?.cost_per_km ?? 0) > 0 && (
                <Section title="1b. Terme km" amount={data.km_term?.cost ?? 0}>
                  <Row label="Kilomètres" value={String(data.km_term?.total_km ?? 0)} />
                  <Row label="Tarif au km" value={`${data.km_term?.cost_per_km ?? 0} €`} />
                  <Row
                    label={t('costBreakdown.share')}
                    value={`${data.km_term?.total_km ?? 0} x ${data.km_term?.cost_per_km ?? 0} = ${data.km_term?.cost ?? 0} €`}
                    bold
                  />
                </Section>
              )}

              {/* 1c. Terme remorque (#59) — non dû en mode mixte (#41) */}
              {(data.trailer_term?.daily_cost ?? 0) > 0 && (
                <Section title="1c. Terme remorque" amount={data.trailer_term?.cost ?? 0}>
                  <Row label="Montant journalier" value={`${data.trailer_term?.daily_cost ?? 0} €`} />
                  <Row label={t('costBreakdown.nbToursToday')} value={String(data.trailer_term?.nb_tours_today ?? 1)} />
                  {data.trailer_term?.own_trailer ? (
                    <Row label="Remorque" value="CMRO (mixte) — terme non dû" bold />
                  ) : (
                    <Row
                      label={t('costBreakdown.share')}
                      value={`${data.trailer_term?.daily_cost ?? 0} / ${data.trailer_term?.nb_tours_today ?? 1} = ${data.trailer_term?.cost ?? 0} €`}
                      bold
                    />
                  )}
                </Section>
              )}

              {/* 2. Fuel cost */}
              <Section
                title={`2. ${t('costBreakdown.fuelCost')}`}
                amount={data.fuel_cost?.cost ?? 0}
              >
                <Row label={t('costBreakdown.totalKm')} value={`${data.fuel_cost?.total_km ?? 0} km`} />
                <Row label={t('costBreakdown.fuelPrice')} value={`${data.fuel_cost?.fuel_price_per_liter ?? 0} €/L`} />
                <Row label={t('costBreakdown.consumptionCoeff')} value={String(data.fuel_cost?.consumption_coefficient ?? 0)} />
                <Row
                  label={t('costBreakdown.fuelTotal')}
                  value={`${data.fuel_cost?.total_km ?? 0} x ${data.fuel_cost?.fuel_price_per_liter ?? 0} x ${data.fuel_cost?.consumption_coefficient ?? 0} = ${data.fuel_cost?.cost ?? 0} €`}
                  bold
                />
              </Section>

              {/* 3. Km tax */}
              <Section
                title={`3. ${t('costBreakdown.kmTax')}`}
                amount={data.km_tax?.total ?? 0}
              >
                {data.km_tax?.segments && data.km_tax.segments.length > 0 ? (
                  <table className="w-full text-xs mt-2">
                    <thead>
                      <tr style={{ color: 'var(--text-muted)' }}>
                        <th className="text-left pb-1 font-medium whitespace-nowrap">{t('costBreakdown.segment')}</th>
                        <th className="text-right pb-1 font-medium whitespace-nowrap">km</th>
                        <th className="text-right pb-1 font-medium whitespace-nowrap">{t('costBreakdown.segmentTax')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.km_tax.segments.map((seg, idx) => (
                        <tr key={idx} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                          <td className="py-1 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                            <span className="truncate block max-w-[250px]" title={`${seg.origin} → ${seg.destination}`}>
                              {seg.origin.split(':')[1]} → {seg.destination.split(':')[1]}
                            </span>
                          </td>
                          <td className="text-right py-1 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                            {seg.distance_km.toFixed(1)}
                          </td>
                          <td className="text-right py-1 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                            {seg.segment_tax > 0 ? `${seg.segment_tax.toFixed(2)} €` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('costBreakdown.noSegments')}</span>
                )}
              </Section>

              {/* Total */}
              <div
                className="rounded-xl p-4 flex items-center justify-between"
                style={{ backgroundColor: 'rgba(249,115,22,0.08)', borderLeft: '4px solid var(--color-primary)' }}
              >
                <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                  {t('costBreakdown.totalCost')}
                </span>
                <span className="text-xl font-bold" style={{ color: 'var(--color-primary)' }}>
                  {data.total_cost_calculated.toFixed(2)} €
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* Sub-components */

function Section({ title, amount, children }: { title: string; amount: number; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
        <span className="text-sm font-bold" style={{ color: 'var(--color-primary)' }}>
          {amount.toFixed(2)} €
        </span>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className={bold ? 'font-bold' : ''} style={{ color: bold ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {value}
      </span>
    </div>
  )
}
