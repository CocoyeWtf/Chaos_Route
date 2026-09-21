/* Page Volumes / Volume management page */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CrudPage } from '../components/data/CrudPage'
import type { Column } from '../components/data/DataTable'
import type { FieldDef } from '../components/data/FormDialog'
import { useApi } from '../hooks/useApi'
import type { Volume, PDV, BaseLogistics } from '../types'
import { formatDate, displayDateTime } from '../utils/tourTimeUtils'

export default function VolumeManagement() {
  const { t } = useTranslation()
  const [hideAssigned, setHideAssigned] = useState(true)
  const { data: pdvs } = useApi<PDV>('/pdvs')
  const { data: bases } = useApi<BaseLogistics>('/bases')

  const tempClassOptions = [
    { value: 'SEC', label: t('vehicles.sec') },
    { value: 'FRAIS', label: t('vehicles.frais') },
    { value: 'GEL', label: t('vehicles.gel') },
  ]

  const columns: Column<Volume>[] = [
    { key: 'date', label: t('common.date'), width: '110px', filterable: true, render: (row) => formatDate(row.date), filterValue: (row) => formatDate(row.date) },
    {
      key: 'pdv_id', label: t('volumes.pdv'), filterable: true,
      render: (row) => pdvs.find((p) => p.id === row.pdv_id)?.name || String(row.pdv_id),
      filterValue: (row) => pdvs.find((p) => p.id === row.pdv_id)?.name || '',
    },
    {
      key: 'eqp_count', label: t('volumes.eqpCount'), width: '90px',
      render: (row) => (Number(row.eqp_count) || 0).toFixed(2),
    },
    {
      key: 'weight_kg', label: t('volumes.weightKg'), width: '100px',
      render: (row) => row.weight_kg != null ? Number(row.weight_kg).toFixed(2) : '—',
    },
    { key: 'temperature_class', label: t('volumes.temperatureClass'), width: '100px', filterable: true },
    {
      /* Reste à quai (#68) : ces volumes reviennent d'une tournée où ils ne sont
         pas partis ; la colonne est filtrable pour les retrouver d'un coup. */
      key: 'is_raq' as keyof Volume, label: 'RAQ', width: '90px', filterable: true,
      render: (row) => row.is_raq ? (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-bold"
          style={{ backgroundColor: 'rgba(234,179,8,0.18)', color: 'var(--color-warning)' }}
          title={row.raq_from_tour_code ? `Resté à quai — tournée ${row.raq_from_tour_code}` : 'Resté à quai'}
        >
          RAQ
        </span>
      ) : '—',
      filterValue: (row) => row.is_raq ? 'RAQ' : '',
    },
    {
      key: 'base_origin_id', label: t('volumes.baseOrigin'), width: '140px', filterable: true,
      render: (row) => bases.find((b) => b.id === row.base_origin_id)?.name || '—',
      filterValue: (row) => bases.find((b) => b.id === row.base_origin_id)?.name || '',
    },
    {
      key: 'dispatch_date' as keyof Volume, label: t('volumes.dispatchDate'), width: '140px', filterable: true,
      render: (row) => row.dispatch_date ? `${formatDate(row.dispatch_date)}${row.dispatch_time ? ` ${row.dispatch_time}` : ''}` : '—',
      filterValue: (row) => row.dispatch_date ? `${formatDate(row.dispatch_date)}${row.dispatch_time ? ` ${row.dispatch_time}` : ''}` : '',
    },
    {
      key: 'preparation_start' as keyof Volume, label: 'Début prépa', width: '130px',
      render: (row) => displayDateTime(row.preparation_start),
    },
    {
      key: 'preparation_end' as keyof Volume, label: 'Fin prépa', width: '130px',
      render: (row) => displayDateTime(row.preparation_end),
    },
    {
      key: 'tour_id' as keyof Volume, label: 'Tour', width: '100px', filterable: true,
      filterValue: (row) => row.tour_id ? t('tourPlanning.assigned') : '',
      render: (row) => row.tour_id ? (
        <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(249,115,22,0.15)', color: 'var(--color-primary)' }}>
          ✓ {t('tourPlanning.assigned')}
        </span>
      ) : (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
      ),
    },
  ]

  const fields: FieldDef[] = [
    { key: 'date', label: t('common.date'), type: 'date', required: true },
    {
      key: 'pdv_id', label: t('volumes.pdv'), type: 'select', required: true,
      options: pdvs.map((p) => ({ value: String(p.id), label: `${p.code} — ${p.name}` })),
    },
    { key: 'eqp_count', label: t('volumes.eqpCount'), type: 'number', required: true, min: 0.01, step: 0.01 },
    { key: 'weight_kg', label: t('volumes.weightKg'), type: 'number', step: 0.01 },
    { key: 'temperature_class', label: t('volumes.temperatureClass'), type: 'select', required: true, options: tempClassOptions },
    {
      key: 'base_origin_id', label: t('volumes.baseOrigin'), type: 'select', required: true,
      options: bases.map((b) => ({ value: String(b.id), label: `${b.code} — ${b.name}` })),
    },
    { key: 'dispatch_datetime', label: 'Date et heure de répartition', type: 'datetime-local', required: true },
    { key: 'preparation_start', label: 'Date et heure début de préparation', type: 'datetime-local' },
    { key: 'preparation_end', label: 'Date et heure fin de préparation', type: 'datetime-local' },
  ]

  return (
    <CrudPage<Volume>
      resource="volumes"
      title={t('volumes.title')}
      endpoint="/volumes"
      columns={columns}
      fields={fields}
      searchKeys={[]}
      createTitle={t('volumes.new')}
      editTitle={t('volumes.edit')}
      importEntity="volumes"
      exportEntity="volumes"
      transformInitialData={(data) => ({
        ...data,
        dispatch_datetime: data.dispatch_date
          ? `${data.dispatch_date}${data.dispatch_time ? `T${data.dispatch_time}` : ''}`
          : '',
      })}
      transformPayload={(d) => {
        const dt = d.dispatch_datetime as string | null
        const dispatch_date = dt ? dt.split('T')[0] : null
        const dispatch_time = dt && dt.includes('T') ? dt.split('T')[1] : null
        const prep_start = d.preparation_start as string | null
        const prep_end = d.preparation_end as string | null

        if (prep_start && dt && prep_start < dt) {
          throw new Error('La date/heure de début de préparation ne peut pas être avant la répartition')
        }
        if (prep_end && prep_start && prep_end < prep_start) {
          throw new Error('La date/heure de fin de préparation ne peut pas être avant le début de préparation')
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { dispatch_datetime, ...rest } = d
        return {
          ...rest,
          dispatch_date,
          dispatch_time,
          pdv_id: Number(d.pdv_id),
          base_origin_id: Number(d.base_origin_id),
        }
      }}
      allowBulkDelete
      filterData={(data) => hideAssigned ? data.filter(v => !v.tour_id) : data}
      toolbarExtra={
        <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
          <input
            type="checkbox"
            checked={hideAssigned}
            onChange={(e) => setHideAssigned(e.target.checked)}
            className="accent-orange-500 w-4 h-4"
          />
          Masquer les volumes assignés
        </label>
      }
    />
  )
}
