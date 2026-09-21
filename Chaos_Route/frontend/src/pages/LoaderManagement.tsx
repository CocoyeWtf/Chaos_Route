/* Page Chargeurs / Loader management page */

import { useTranslation } from 'react-i18next'
import { CrudPage } from '../components/data/CrudPage'
import type { Column } from '../components/data/DataTable'
import type { FieldDef } from '../components/data/FormDialog'
import { useApi } from '../hooks/useApi'
import type { Loader, BaseLogistics } from '../types'

export default function LoaderManagement() {
  const { t } = useTranslation()
  const { data: bases } = useApi<BaseLogistics>('/bases')

  const columns: Column<Loader>[] = [
    { key: 'code', label: t('common.code'), width: '120px', filterable: true },
    { key: 'name', label: t('common.name'), filterable: true },
    {
      key: 'base_id', label: 'Base', width: '180px', filterable: true,
      render: (row) => bases.find((b) => b.id === row.base_id)?.name || '—',
      filterValue: (row) => bases.find((b) => b.id === row.base_id)?.name || '',
    },
    {
      /* Seconde base facultative (#63) : un chargeur de Gosselies SEC charge
         aussi pour Gosselies MEA, sans qu'on ait à créer une seconde fiche. */
      key: 'secondary_base_id' as keyof Loader, label: 'Seconde base', width: '180px', filterable: true,
      render: (row) => row.secondary_base_id
        ? (bases.find((b) => b.id === row.secondary_base_id)?.name || '—')
        : '—',
      filterValue: (row) => row.secondary_base_id
        ? (bases.find((b) => b.id === row.secondary_base_id)?.name || '')
        : '',
    },
  ]

  const fields: FieldDef[] = [
    { key: 'code', label: t('common.code'), type: 'text', required: true },
    { key: 'name', label: t('common.name'), type: 'text', required: true },
    {
      key: 'base_id', label: 'Base', type: 'select', required: true,
      options: bases.map((b) => ({ value: String(b.id), label: `${b.code} — ${b.name}` })),
    },
    {
      key: 'secondary_base_id', label: 'Seconde base (facultatif)', type: 'select',
      options: [{ value: '', label: '— Aucune —' },
        ...bases.map((b) => ({ value: String(b.id), label: `${b.code} — ${b.name}` }))],
    },
  ]

  return (
    <CrudPage<Loader>
      resource="loaders"
      title="Chargeurs"
      endpoint="/loaders"
      columns={columns}
      fields={fields}
      searchKeys={['code', 'name']}
      createTitle="Nouveau chargeur"
      editTitle="Modifier chargeur"
      transformPayload={(d) => ({
        ...d,
        base_id: Number(d.base_id),
        /* Chaîne vide = aucune seconde base : on envoie null et non 0, sinon le
           serveur chercherait une base inexistante. / Empty means none. */
        secondary_base_id: d.secondary_base_id ? Number(d.secondary_base_id) : null,
      })}
    />
  )
}
