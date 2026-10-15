/* Synthèse par transporteur / Transporter summary page */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import * as XLSX from 'xlsx'
import api from '../services/api'
import { useApi } from '../hooks/useApi'
import { TourDetailSheet } from '../components/tour/TourDetailSheet'
import type { TourDetailData } from '../components/tour/TourDetailSheet'
import type { BaseLogistics } from '../types'
import { formatDate } from '../utils/tourTimeUtils'

/* ---- Types réponse API / API response types ---- */

interface SummaryStop {
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
}

interface SurchargeItem {
  id: number; amount: number; motif: string; surcharge_type_label?: string
}

interface SummaryCostBreakdown {
  vacation_share: number
  fuel_cost: number
  km_tax_total: number
  surcharges_total: number
  total_calculated: number
}

interface SummaryTimeBreakdown {
  travel_minutes: number
  dock_minutes: number
  unload_minutes: number
  total_minutes: number
}

interface SummaryTour {
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
  cost_breakdown: SummaryCostBreakdown
  time_breakdown?: SummaryTimeBreakdown
  surcharges?: SurchargeItem[]
  surcharges_total?: number
  pending_surcharges_count?: number
  stops: SummaryStop[]
}

interface Subtotal {
  nb_tours: number
  total_km: number
  total_eqp: number
  total_duration_minutes: number
  vacation_cost_total: number
  fuel_cost_total: number
  km_tax_total: number
  surcharges_total: number
  total_cost: number
}

interface ContractGroup {
  contract_id: number
  contract_code: string
  vehicle_code?: string
  vehicle_name?: string
  tours: SummaryTour[]
  subtotal: Subtotal
}

interface TransporterGroup {
  transporter_name: string
  carrier_id?: number
  carrier_code?: string
  contracts: ContractGroup[]
  grand_total: Subtotal & { nb_contracts: number }
}

interface SummaryResponse {
  period: { date_from: string; date_to: string }
  transporters: TransporterGroup[]
  warnings?: string[]
}

/* ---- Helpers ---- */

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h${String(m).padStart(2, '0')}`
}

function todayStr(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

function firstOfMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/* ---- Component ---- */

export default function TransporterSummary() {
  const { t } = useTranslation()
  const { data: bases } = useApi<BaseLogistics>('/bases')

  const [dateFrom, setDateFrom] = useState(firstOfMonth)
  const [dateTo, setDateTo] = useState(todayStr)
  const [baseId, setBaseId] = useState<string>('')
  const [billingCompany, setBillingCompany] = useState<string>('')
  const [transporterFilter, setTransporterFilter] = useState('')
  const [data, setData] = useState<SummaryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* Sections repliables / Collapsible sections */
  const [openTransporters, setOpenTransporters] = useState<Set<string>>(new Set())
  const [openContracts, setOpenContracts] = useState<Set<string>>(new Set())

  /* Fiche détaillée / Detail sheet */
  const [detailTour, setDetailTour] = useState<TourDetailData | null>(null)

  /* Vue : synthèse (existant) ou tableur CMRO / View: summary or CMRO spreadsheet */
  const [viewMode, setViewMode] = useState<'synthese' | 'cmro'>('synthese')
  const [cmro, setCmro] = useState<{ columns: string[]; fields: string[]; rows: Record<string, unknown>[] } | null>(null)
  const [cmroLoading, setCmroLoading] = useState(false)

  const toggleTransporter = (name: string) => {
    setOpenTransporters((prev) => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const toggleContract = (key: string) => {
    setOpenContracts((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  /* Charger les données / Load data */
  const handleLoad = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string> = { date_from: dateFrom, date_to: dateTo }
      if (baseId) params.base_id = baseId
      if (billingCompany) params.billing_company = billingCompany
      if (transporterFilter.trim()) params.transporter_name = transporterFilter.trim()
      const { data: res } = await api.get<SummaryResponse>('/tours/transporter-summary', { params })
      setData(res)
      // Ouvrir tous les transporteurs par défaut / Open all transporters by default
      setOpenTransporters(new Set(res.transporters.map((t) => t.transporter_name)))
      setOpenContracts(new Set(
        res.transporters.flatMap((tr) => tr.contracts.map((c) => `${tr.transporter_name}::${c.contract_id}`))
      ))
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(err?.response?.data?.detail || err?.message || 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, baseId, billingCompany, transporterFilter])

  /* Charger / exporter l'extraction CMRO / Load + export CMRO extraction */
  const cmroParams = useCallback(() => {
    const params: Record<string, string> = { date_from: dateFrom, date_to: dateTo }
    if (baseId) params.base_id = baseId
    if (billingCompany) params.billing_company = billingCompany
    if (transporterFilter.trim()) params.transporter_name = transporterFilter.trim()
    return params
  }, [dateFrom, dateTo, baseId, billingCompany, transporterFilter])

  const loadCmro = useCallback(async () => {
    setCmroLoading(true)
    setError(null)
    try {
      const { data: res } = await api.get('/tours/cmro-extraction', { params: cmroParams() })
      setCmro(res)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      setError(err?.response?.data?.detail || err?.message || 'Unknown error')
    } finally {
      setCmroLoading(false)
    }
  }, [cmroParams])

  const exportCmro = useCallback(async () => {
    const resp = await api.get('/tours/cmro-extraction/export', { params: cmroParams(), responseType: 'blob' })
    const url = window.URL.createObjectURL(new Blob([resp.data]))
    const link = document.createElement('a')
    link.href = url
    link.download = `extraction_CMRO_${dateFrom}_${dateTo}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  }, [cmroParams, dateFrom, dateTo])

  /* Ouvrir fiche détaillée / Open detail sheet */
  const openDetail = (tour: SummaryTour, contractGroup: ContractGroup, transporterName: string) => {
    setDetailTour({
      ...tour,
      contract_code: contractGroup.contract_code,
      transporter_name: transporterName,
      vehicle_code: contractGroup.vehicle_code,
      vehicle_name: contractGroup.vehicle_name,
    })
  }

  /* Export Excel */
  const handleExportExcel = () => {
    if (!data) return
    const rows: Record<string, unknown>[] = []

    for (const tr of data.transporters) {
      for (const cg of tr.contracts) {
        for (const tour of cg.tours) {
          rows.push({
            [t('transporterSummary.transporter')]: tr.transporter_name,
            [t('transporterSummary.contract')]: cg.contract_code,
            [t('transporterSummary.vehicle')]: cg.vehicle_code || '',
            [t('transporterSummary.date')]: formatDate(tour.date),
            [t('transporterSummary.tourCode')]: tour.tour_code,
            [t('transporterSummary.base')]: `${tour.base_code} ${tour.base_name}`,
            [t('transporterSummary.departure')]: tour.departure_time || '',
            [t('transporterSummary.return')]: tour.return_time || '',
            [t('transporterSummary.duration')]: formatDuration(tour.total_duration_minutes),
            [t('transporterSummary.km')]: tour.total_km,
            [t('transporterSummary.eqp')]: tour.total_eqp,
            [t('transporterSummary.vacationShare')]: tour.cost_breakdown.vacation_share,
            [t('transporterSummary.fuelCost')]: tour.cost_breakdown.fuel_cost,
            [t('transporterSummary.kmTax')]: tour.cost_breakdown.km_tax_total,
            'Surcharges': tour.surcharges_total || 0,
            [t('transporterSummary.totalCost')]: tour.total_cost,
          })
        }
        // Ligne sous-total contrat / Contract subtotal row
        rows.push({
          [t('transporterSummary.transporter')]: '',
          [t('transporterSummary.contract')]: `${t('transporterSummary.subtotalContract')} ${cg.contract_code}`,
          [t('transporterSummary.vehicle')]: '',
          [t('transporterSummary.date')]: '',
          [t('transporterSummary.tourCode')]: `${cg.subtotal.nb_tours} ${t('transporterSummary.nbTours')}`,
          [t('transporterSummary.base')]: '',
          [t('transporterSummary.departure')]: '',
          [t('transporterSummary.return')]: '',
          [t('transporterSummary.duration')]: formatDuration(cg.subtotal.total_duration_minutes),
          [t('transporterSummary.km')]: cg.subtotal.total_km,
          [t('transporterSummary.eqp')]: cg.subtotal.total_eqp,
          [t('transporterSummary.vacationShare')]: cg.subtotal.vacation_cost_total,
          [t('transporterSummary.fuelCost')]: cg.subtotal.fuel_cost_total,
          [t('transporterSummary.kmTax')]: cg.subtotal.km_tax_total,
          'Surcharges': cg.subtotal.surcharges_total || 0,
          [t('transporterSummary.totalCost')]: cg.subtotal.total_cost,
        })
      }
      // Ligne total transporteur / Transporter total row
      rows.push({
        [t('transporterSummary.transporter')]: `${t('transporterSummary.grandTotalTransporter')} ${tr.transporter_name}`,
        [t('transporterSummary.contract')]: `${tr.grand_total.nb_contracts} ${t('transporterSummary.nbContracts')}`,
        [t('transporterSummary.vehicle')]: '',
        [t('transporterSummary.date')]: '',
        [t('transporterSummary.tourCode')]: `${tr.grand_total.nb_tours} ${t('transporterSummary.nbTours')}`,
        [t('transporterSummary.base')]: '',
        [t('transporterSummary.departure')]: '',
        [t('transporterSummary.return')]: '',
        [t('transporterSummary.duration')]: formatDuration(tr.grand_total.total_duration_minutes),
        [t('transporterSummary.km')]: tr.grand_total.total_km,
        [t('transporterSummary.eqp')]: tr.grand_total.total_eqp,
        [t('transporterSummary.vacationShare')]: tr.grand_total.vacation_cost_total,
        [t('transporterSummary.fuelCost')]: tr.grand_total.fuel_cost_total,
        [t('transporterSummary.kmTax')]: tr.grand_total.km_tax_total,
        'Surcharges': tr.grand_total.surcharges_total || 0,
        [t('transporterSummary.totalCost')]: tr.grand_total.total_cost,
      })
      // Ligne vide de séparation / Separator row
      rows.push({})
    }

    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, t('transporterSummary.sheetName'))
    XLSX.writeFile(wb, `${t('transporterSummary.sheetName')}_${dateFrom}_${dateTo}.xlsx`)
  }

  /* Si fiche tour ouverte, afficher l'overlay / If tour detail open, show overlay */
  if (detailTour) {
    return (
      <TourDetailSheet
        tour={detailTour}
        onClose={() => setDetailTour(null)}
        onSurchargesChanged={handleLoad}
      />
    )
  }

  return (
    <div>
      {/* Titre / Title */}
      <h2 className="text-2xl font-bold mb-4 print-hide" style={{ color: 'var(--text-primary)' }}>
        {t('transporterSummary.title')}
      </h2>

      {/* Bascule de vue / View toggle */}
      <div className="print-hide flex gap-2 mb-4">
        {([['synthese', 'Vue synthèse'], ['cmro', 'Tableur (CMRO)']] as const).map(([m, label]) => (
          <button
            key={m}
            onClick={() => { setViewMode(m); if (m === 'cmro' && !cmro) loadCmro() }}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold border transition-all"
            style={{
              backgroundColor: viewMode === m ? 'var(--color-primary)' : 'var(--bg-tertiary)',
              borderColor: viewMode === m ? 'var(--color-primary)' : 'var(--border-color)',
              color: viewMode === m ? '#fff' : 'var(--text-secondary)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Barre de filtres (masquée à l'impression) / Filter bar (hidden on print) */}
      <div
        className="print-hide flex flex-wrap items-end gap-3 mb-6 p-4 rounded-xl border"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
      >
        <div className="flex flex-col">
          <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.dateFrom')}</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.dateTo')}</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.base')}</label>
          <select
            value={baseId}
            onChange={(e) => setBaseId(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          >
            <option value="">{t('transporterSummary.allBases')}</option>
            {bases.map((b) => (
              <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Société facturante</label>
          <select
            value={billingCompany}
            onChange={(e) => setBillingCompany(e.target.value)}
            className="px-3 py-1.5 rounded-lg border text-sm"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          >
            <option value="">Toutes</option>
            {[...new Set(bases.map((b) => b.billing_company).filter((c): c is string => !!c))].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.transporter')}</label>
          <input
            type="text"
            value={transporterFilter}
            onChange={(e) => setTransporterFilter(e.target.value)}
            placeholder={t('transporterSummary.transporterPlaceholder')}
            className="px-3 py-1.5 rounded-lg border text-sm w-52"
            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
        </div>
        <button
          onClick={() => (viewMode === 'cmro' ? loadCmro() : handleLoad())}
          disabled={loading || cmroLoading}
          className="px-5 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
          style={{ backgroundColor: 'var(--color-primary)', color: 'white' }}
        >
          {(loading || cmroLoading) ? '...' : t('transporterSummary.load')}
        </button>
        {viewMode === 'cmro' && cmro && cmro.rows.length > 0 && (
          <button
            onClick={exportCmro}
            className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
            style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
          >
            Exporter CMRO (Excel)
          </button>
        )}
        {data && data.transporters.length > 0 && (
          <>
            <button
              onClick={() => window.print()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
            >
              {t('transporterSummary.print')}
            </button>
            <button
              onClick={handleExportExcel}
              className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
            >
              {t('transporterSummary.exportExcel')}
            </button>
          </>
        )}
      </div>

      {/* En-tête période pour impression / Period header for print */}
      {data && (
        <div className="hidden print:block mb-4">
          <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {t('transporterSummary.title')} — {t('transporterSummary.period')} : {data.period.date_from} → {data.period.date_to}
          </h2>
        </div>
      )}

      {error && (
        <div className="text-sm p-3 rounded-lg mb-4" style={{ color: 'var(--color-danger)', backgroundColor: 'rgba(239,68,68,0.1)' }}>
          {error}
        </div>
      )}

      {data?.warnings && data.warnings.length > 0 && (
        <div
          className="text-sm p-3 rounded-lg mb-4 flex items-start gap-2 print:hidden"
          style={{ color: 'var(--color-warning)', backgroundColor: 'rgba(245,158,11,0.1)' }}
        >
          <span>&#9888;</span>
          <div>{data.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
        </div>
      )}

      {data && data.transporters.length === 0 && (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.noData')}</p>
      )}

      {/* Vue tableur CMRO / CMRO spreadsheet view */}
      {viewMode === 'cmro' && cmro && (
        cmro.rows.length === 0
          ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('transporterSummary.noData')}</p>
          : (
            <div className="overflow-auto border rounded-lg" style={{ borderColor: 'var(--border-color)', maxHeight: '72vh' }}>
              <table className="text-xs" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {cmro.columns.map((c, i) => (
                      <th
                        key={i}
                        className="px-2 py-1 sticky top-0 whitespace-nowrap text-left font-semibold"
                        style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', borderRight: '1px solid var(--border-color)' }}
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cmro.rows.map((row, ri) => (
                    <tr key={ri} style={{ borderTop: '1px solid var(--border-color)' }}>
                      {cmro.fields.map((f, ci) => (
                        <td
                          key={ci}
                          className="px-2 py-1 whitespace-nowrap"
                          style={{ color: 'var(--text-secondary)', borderRight: '1px solid var(--border-color)' }}
                        >
                          {String(row[f] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {/* Corps : transporteurs > contrats > tours / Body: transporters > contracts > tours */}
      {viewMode === 'synthese' && data && data.transporters.map((tr) => {
        const isOpenT = openTransporters.has(tr.transporter_name)
        return (
          <div key={tr.transporter_name} className="mb-4">
            {/* Header transporteur / Transporter header */}
            <button
              onClick={() => toggleTransporter(tr.transporter_name)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-t-xl text-left transition-colors hover:opacity-90"
              style={{ backgroundColor: 'var(--color-primary)', color: 'white' }}
            >
              <span className="font-bold text-sm">
                {isOpenT ? '▼' : '▶'} {tr.transporter_name}
                <span className="ml-3 font-normal text-xs opacity-80">
                  {tr.grand_total.nb_contracts} {t('transporterSummary.nbContracts')} · {tr.grand_total.nb_tours} {t('transporterSummary.nbTours')}
                </span>
              </span>
              <span className="font-bold text-sm">{tr.grand_total.total_cost.toFixed(2)} &euro;</span>
            </button>

            {isOpenT && (
              <div className="border border-t-0 rounded-b-xl" style={{ borderColor: 'var(--border-color)' }}>
                {tr.contracts.map((cg) => {
                  const contractKey = `${tr.transporter_name}::${cg.contract_id}`
                  const isOpenC = openContracts.has(contractKey)
                  return (
                    <div key={cg.contract_id}>
                      {/* Header contrat / Contract header */}
                      <button
                        onClick={() => toggleContract(contractKey)}
                        className="w-full flex items-center justify-between px-4 py-2 text-left text-sm transition-colors hover:opacity-80 border-t"
                        style={{ backgroundColor: 'var(--bg-tertiary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                      >
                        <span>
                          {isOpenC ? '▾' : '▸'}{' '}
                          <span className="font-semibold">{cg.contract_code}</span>
                          {cg.vehicle_code && (
                            <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                              {cg.vehicle_code} — {cg.vehicle_name || ''}
                            </span>
                          )}
                          <span className="ml-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {cg.subtotal.nb_tours} {t('transporterSummary.nbTours')}
                          </span>
                        </span>
                        <span className="font-semibold">{cg.subtotal.total_cost.toFixed(2)} &euro;</span>
                      </button>

                      {isOpenC && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr style={{ color: 'var(--text-muted)' }}>
                                <th className="text-left px-3 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.date')}</th>
                                <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.tourCode')}</th>
                                <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.base')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.departure')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.return')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.duration')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.km')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.eqp')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.vacationShare')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.fuelCost')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.kmTax')}</th>
                                <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">Surcharges</th>
                                <th className="text-right px-3 py-1.5 font-medium whitespace-nowrap">{t('transporterSummary.totalCost')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {cg.tours.map((tour) => (
                                <tr
                                  key={tour.tour_id}
                                  className="border-t cursor-pointer transition-colors hover:opacity-80"
                                  style={{ borderColor: 'var(--border-color)' }}
                                  onClick={() => openDetail(tour, cg, tr.transporter_name)}
                                >
                                  <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{formatDate(tour.date)}</td>
                                  <td className="px-2 py-1.5 font-mono whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.tour_code}</td>
                                  <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{tour.base_code}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.departure_time || '—'}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.return_time || '—'}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{formatDuration(tour.total_duration_minutes)}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{tour.total_km.toFixed(1)}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.total_eqp}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{tour.cost_breakdown.vacation_share.toFixed(2)}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{tour.cost_breakdown.fuel_cost.toFixed(2)}</td>
                                  <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{tour.cost_breakdown.km_tax_total.toFixed(2)}</td>
                                  <td
                                    className="px-2 py-1.5 text-right whitespace-nowrap"
                                    title={
                                      tour.surcharges && tour.surcharges.length > 0
                                        ? tour.surcharges.map((s) => `${s.surcharge_type_label || s.motif}: ${s.amount.toFixed(2)} €`).join('\n')
                                        : undefined
                                    }
                                  >
                                    {(tour.surcharges_total || 0) > 0 && (
                                      <span style={{ color: 'var(--color-danger)' }}>{(tour.surcharges_total || 0).toFixed(2)}</span>
                                    )}
                                    {(tour.pending_surcharges_count || 0) > 0 && (
                                      <span
                                        className="inline-block ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold"
                                        style={{ backgroundColor: 'rgba(249,115,22,0.15)', color: '#f97316' }}
                                        title={`${tour.pending_surcharges_count} en attente de validation`}
                                      >
                                        {tour.pending_surcharges_count}
                                      </span>
                                    )}
                                    {!(tour.surcharges_total || 0) && !(tour.pending_surcharges_count || 0) && (
                                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{tour.total_cost.toFixed(2)}</td>
                                </tr>
                              ))}
                              {/* Ligne sous-total contrat / Contract subtotal row */}
                              <tr
                                className="border-t"
                                style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-tertiary)' }}
                              >
                                <td colSpan={5} className="px-3 py-2 font-bold text-xs whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                                  {t('transporterSummary.subtotalContract')} {cg.contract_code} ({cg.subtotal.nb_tours} {t('transporterSummary.nbTours')})
                                </td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{formatDuration(cg.subtotal.total_duration_minutes)}</td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{cg.subtotal.total_km.toFixed(1)}</td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{cg.subtotal.total_eqp}</td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{cg.subtotal.vacation_cost_total.toFixed(2)}</td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{cg.subtotal.fuel_cost_total.toFixed(2)}</td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{cg.subtotal.km_tax_total.toFixed(2)}</td>
                                <td className="px-2 py-2 text-right font-bold whitespace-nowrap" style={{ color: (cg.subtotal.surcharges_total || 0) > 0 ? 'var(--color-danger)' : 'var(--text-primary)' }}>
                                  {(cg.subtotal.surcharges_total || 0) > 0 ? (cg.subtotal.surcharges_total || 0).toFixed(2) : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-bold whitespace-nowrap" style={{ color: 'var(--color-primary)' }}>{cg.subtotal.total_cost.toFixed(2)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Ligne grand total transporteur / Transporter grand total row */}
                <div
                  className="flex items-center justify-between px-4 py-2 text-xs font-bold border-t"
                  style={{ backgroundColor: 'rgba(249,115,22,0.08)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                >
                  <span>
                    {t('transporterSummary.grandTotalTransporter')} {tr.transporter_name} — {tr.grand_total.nb_tours} {t('transporterSummary.nbTours')} · {tr.grand_total.total_km.toFixed(1)} km · {tr.grand_total.total_eqp} EQC
                  </span>
                  <span className="text-base" style={{ color: 'var(--color-primary)' }}>
                    {tr.grand_total.total_cost.toFixed(2)} &euro;
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
