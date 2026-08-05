/* Historique des tours / Tour history page */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/useAppStore'
import { remove, downloadTourHistory } from '../services/api'
import type { Tour, BaseLogistics, Contract } from '../types'
import { TOUR_TYPE_LABELS } from '../types'
import type { Column } from '../components/data/DataTable'
import { DataTable } from '../components/data/DataTable'
import { CostBreakdown } from '../components/tour/CostBreakdown'
import { GPSTrailModal } from '../components/tour/GPSTrailModal'
import { displayDateTime, formatDate } from '../utils/tourTimeUtils'

export default function TourHistory() {
  const { t } = useTranslation()
  const { selectedRegionId } = useAppStore()
  const [deleting, setDeleting] = useState<number | null>(null)
  const [costTourId, setCostTourId] = useState<number | null>(null)
  const [gpsTour, setGpsTour] = useState<{ id: number; code: string } | null>(null)
  const [exporting, setExporting] = useState(false)

  const params = selectedRegionId ? { region_id: selectedRegionId } : undefined
  const { data: tours, loading, refetch } = useApi<Tour>('/tours', params)
  const { data: bases } = useApi<BaseLogistics>('/bases')
  const { data: contracts } = useApi<Contract>('/contracts')

  const baseMap = new Map(bases.map((b) => [b.id, b]))
  const contractMap = new Map(contracts.map((c) => [c.id, c]))

  const statusColors: Record<string, string> = {
    DRAFT: 'var(--text-muted)',
    VALIDATED: 'var(--color-primary)',
    IN_PROGRESS: 'var(--color-warning)',
    RETURNING: 'var(--color-info, #3b82f6)',
    COMPLETED: 'var(--color-success)',
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      await downloadTourHistory(selectedRegionId)
    } catch (e) {
      console.error('Failed to export tour history', e)
    } finally {
      setExporting(false)
    }
  }

  const handleDelete = async (tour: Tour) => {
    if (!confirm(t('tourHistory.confirmDelete', { code: tour.code }))) return
    setDeleting(tour.id)
    try {
      await remove('/tours', tour.id)
      refetch()
    } catch (e) {
      console.error('Failed to delete tour', e)
    } finally {
      setDeleting(null)
    }
  }

  const columns: Column<Tour>[] = [
    { key: 'code', label: t('common.code'), width: '120px', filterable: true },
    {
      key: 'tour_type' as keyof Tour,
      label: 'Nature',
      width: '110px', filterable: true,
      render: (row) => (row.tour_type && row.tour_type !== 'LIVRAISON' ? TOUR_TYPE_LABELS[row.tour_type] : 'Livraison'),
      filterValue: (row) => (row.tour_type && row.tour_type !== 'LIVRAISON' ? TOUR_TYPE_LABELS[row.tour_type] : 'Livraison'),
    },
    { key: 'date', label: t('common.date'), width: '110px', filterable: true, render: (row) => formatDate(row.date) },
    {
      key: 'base_id',
      label: t('tourHistory.base'),
      width: '140px', filterable: true,
      render: (row) => baseMap.get(row.base_id)?.name ?? `#${row.base_id}`,
      filterValue: (row) => baseMap.get(row.base_id)?.name ?? '',
    },
    {
      key: 'contract_id',
      label: t('tourHistory.vehicle'),
      width: '160px', filterable: true,
      render: (row) => {
        const c = row.contract_id != null ? contractMap.get(row.contract_id) : undefined
        if (!c) return row.contract_id != null ? `#${row.contract_id}` : '—'
        return c.vehicle_code ? `${c.vehicle_code} — ${c.vehicle_name ?? ''}` : c.code
      },
      filterValue: (row) => {
        const c = row.contract_id != null ? contractMap.get(row.contract_id) : undefined
        if (!c) return ''
        return c.vehicle_code ? `${c.vehicle_code} ${c.vehicle_name ?? ''}` : c.code
      },
    },
    {
      key: 'contract_id' as keyof Tour,
      label: t('tourHistory.transporter'),
      width: '140px',
      render: (row) => (row.contract_id != null ? contractMap.get(row.contract_id)?.transporter_name : undefined) ?? '—',
    },
    {
      key: 'id' as keyof Tour,
      label: t('tourPlanning.stops'),
      width: '70px',
      render: (row) => row.stops?.length ?? 0,
    },
    { key: 'total_eqp', label: 'EQC', width: '70px' },
    {
      key: 'total_km',
      label: 'Km',
      width: '80px',
      render: (row) => (row.total_km != null ? `${row.total_km.toFixed(1)}` : '—'),
    },
    {
      key: 'total_cost',
      label: t('tourHistory.cost'),
      width: '90px',
      render: (row) => (row.total_cost != null ? `${row.total_cost.toFixed(2)} €` : '—'),
    },
    {
      key: 'status',
      label: t('common.status'),
      width: '100px', filterable: true,
      filterValue: (row) => t(`tourHistory.status.${row.status}`),
      render: (row) => (
        <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ color: statusColors[row.status] }}>
          {t(`tourHistory.status.${row.status}`)}
        </span>
      ),
    },
    {
      key: 'departure_time',
      label: t('tourHistory.departure'),
      width: '90px',
      render: (row) => row.departure_time ?? '—',
    },
    {
      key: 'priority' as keyof Tour,
      label: t('tourPlanning.priority'),
      width: '70px',
      render: (row) => row.priority ?? '—',
    },
    {
      key: 'return_time',
      label: t('tourHistory.return'),
      width: '90px',
      render: (row) => row.return_time ?? '—',
    },
    {
      key: 'driver_name',
      label: 'Chauffeur',
      width: '110px', filterable: true,
      render: (row) => row.driver_name ?? '—',
    },
    {
      key: 'driver_arrival_time',
      label: 'Arrivée chauffeur',
      width: '110px',
      render: (row) => displayDateTime(row.driver_arrival_time),
    },
    {
      key: 'loading_end_time',
      label: 'Fin chargement',
      width: '110px',
      render: (row) => displayDateTime(row.loading_end_time),
    },
    {
      key: 'departure_signal_time',
      label: 'Top départ',
      width: '110px',
      render: (row) => displayDateTime(row.departure_signal_time),
    },
    {
      key: 'barrier_exit_time',
      label: 'Sortie barrière',
      width: '110px',
      render: (row) => displayDateTime(row.barrier_exit_time),
    },
    {
      key: 'barrier_entry_time',
      label: 'Retour barrière',
      width: '110px',
      render: (row) => displayDateTime(row.barrier_entry_time),
    },
    {
      key: 'id' as keyof Tour,
      label: 'GPS',
      width: '50px',
      render: (row) => (
        <button
          className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
          style={{ color: 'var(--color-info, #3b82f6)', backgroundColor: 'rgba(59,130,246,0.1)' }}
          onClick={(e) => { e.stopPropagation(); setGpsTour({ id: row.id, code: row.code }) }}
          title="Tracé GPS"
        >
          GPS
        </button>
      ),
    },
    {
      key: 'id' as keyof Tour,
      label: '',
      width: '80px',
      render: (row) => {
        const locked = !!row.departure_signal_time
        return (
          <button
            className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
            style={{
              color: locked ? 'var(--text-muted)' : 'var(--color-danger)',
              backgroundColor: locked ? 'var(--bg-tertiary)' : 'rgba(239,68,68,0.1)',
              cursor: locked ? 'not-allowed' : undefined,
            }}
            onClick={(e) => { e.stopPropagation(); if (!locked) handleDelete(row) }}
            disabled={deleting === row.id || locked}
            title={locked ? 'Tour verrouillé (top départ validé)' : undefined}
          >
            {locked ? '🔒' : deleting === row.id ? '...' : t('tourHistory.undoTour')}
          </button>
        )
      },
    },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {t('tourHistory.title')}
        </h2>
        <button
          className="text-sm font-medium px-3 py-2 rounded transition-colors hover:opacity-80 disabled:opacity-50"
          style={{ color: 'white', backgroundColor: 'var(--color-success)' }}
          onClick={handleExport}
          disabled={exporting || loading}
          title="Exporter l'historique des tours en Excel"
        >
          {exporting ? '...' : '⬇ Exporter Excel'}
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</p>
      ) : (
        <DataTable<Tour>
          data={tours}
          columns={columns}
          searchKeys={['code', 'date']}
          onRowClick={(row) => setCostTourId(row.id)}
        />
      )}

      {costTourId && (
        <CostBreakdown tourId={costTourId} onClose={() => setCostTourId(null)} />
      )}

      {gpsTour && (
        <GPSTrailModal tourId={gpsTour.id} tourCode={gpsTour.code} onClose={() => setGpsTour(null)} />
      )}
    </div>
  )
}
