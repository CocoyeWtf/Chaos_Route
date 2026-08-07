/* Page CRUD générique / Generic CRUD page component */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { DataTable, type Column } from './DataTable'
import { FormDialog, type FieldDef, type FormDialogSize } from './FormDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { ImportDialog } from './ImportDialog'
import { useApi } from '../../hooks/useApi'
import { useAuthStore } from '../../stores/useAuthStore'
import { create, update, remove, downloadExport } from '../../services/api'
import api from '../../services/api'

interface CrudPageProps<T extends { id: number }> {
  title: string
  endpoint: string
  columns: Column<T>[]
  fields: FieldDef[]
  searchKeys?: (keyof T)[]
  createTitle: string
  editTitle: string
  importEntity?: string
  exportEntity?: string
  apiParams?: Record<string, unknown>
  /** Activer la duplication / Enable row duplication */
  allowDuplicate?: boolean
  /** Clés à exclure lors de la duplication / Keys to exclude when duplicating */
  duplicateExcludeKeys?: string[]
  /** Transformer les données du formulaire avant envoi / Transform form data before submit */
  transformPayload?: (data: Record<string, unknown>) => Record<string, unknown>
  /** Filtrer les données avant affichage / Filter data before display */
  filterData?: (data: T[]) => T[]
  /** Contenu supplémentaire au-dessus du tableau / Extra content above the table */
  toolbarExtra?: React.ReactNode
  /** Transformer les données initiales avant le formulaire / Transform initial data before form */
  transformInitialData?: (data: Record<string, unknown>) => Record<string, unknown>
  /** Contenu supplémentaire dans le formulaire / Extra content inside the form dialog */
  formExtra?: (formData: Record<string, unknown>, initialData?: Record<string, unknown>) => React.ReactNode
  /** Taille du formulaire / Form dialog size */
  formSize?: FormDialogSize
  /** Ressource RBAC pour conditionner create/edit/delete / RBAC resource to gate CUD actions */
  resource?: string
  /** Activer la suppression en masse / Enable bulk delete */
  allowBulkDelete?: boolean
}

export function CrudPage<T extends { id: number }>({
  title,
  endpoint,
  columns,
  fields,
  searchKeys = [],
  createTitle,
  editTitle,
  importEntity,
  exportEntity,
  apiParams,
  allowDuplicate,
  duplicateExcludeKeys = ['id', 'schedules'],
  transformPayload,
  filterData,
  toolbarExtra,
  transformInitialData,
  formExtra,
  formSize,
  resource,
  allowBulkDelete,
}: CrudPageProps<T>) {
  const { t } = useTranslation()
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const canCreate = !resource || hasPermission(resource, 'create')
  const canUpdate = !resource || hasPermission(resource, 'update')
  const canDelete = !resource || hasPermission(resource, 'delete')
  // Import/export sont servis par des endpoints dédiés (/imports, /exports) gardés
  // par la ressource `imports-exports`, PAS par la ressource de la page. Gater les
  // boutons sur la même permission que le back, sinon un rôle voit un bouton qui
  // renvoie 403 (ex. R Cam : volumes:create sans imports-exports:create). /
  // Import & export hit dedicated endpoints gated by `imports-exports`, not the
  // page resource — gate the buttons on the same permission as the backend.
  const canImport = hasPermission('imports-exports', 'create')
  const canExport = hasPermission('imports-exports', 'read')
  const { data, loading, refetch } = useApi<T>(endpoint, apiParams)

  const [formOpen, setFormOpen] = useState(false)
  const [editItem, setEditItem] = useState<Record<string, unknown> | undefined>()
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = () => {
    setEditItem(undefined)
    setFormOpen(true)
  }

  const handleEdit = (row: T) => {
    const raw = row as unknown as Record<string, unknown>
    setEditItem(transformInitialData ? transformInitialData(raw) : raw)
    setFormOpen(true)
  }

  const handleDuplicate = (row: T) => {
    const copy = { ...(row as unknown as Record<string, unknown>) }
    for (const key of duplicateExcludeKeys) {
      delete copy[key]
    }
    // Vider le code pour forcer un nouveau code / Clear code to force a new one
    if ('code' in copy) copy.code = ''
    setEditItem(transformInitialData ? transformInitialData(copy) : copy)
    setFormOpen(true)
  }

  const handleSave = useCallback(async (formData: Record<string, unknown>) => {
    setSaving(true)
    setError(null)
    try {
      const payload = transformPayload ? transformPayload(formData) : formData
      if (editItem?.id) {
        await update<T>(endpoint, editItem.id as number, payload as Partial<T>)
      } else {
        await create<T>(endpoint, payload as Partial<T>)
      }
      setFormOpen(false)
      setEditItem(undefined)
      refetch()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || (err instanceof Error ? err.message : 'Erreur lors de la sauvegarde')
      setError(detail)
    } finally {
      setSaving(false)
    }
  }, [editItem, endpoint, refetch, transformPayload])

  const handleDelete = useCallback(async () => {
    if (deleteId == null) return
    setSaving(true)
    try {
      await remove(endpoint, deleteId)
      setDeleteId(null)
      refetch()
    } finally {
      setSaving(false)
    }
  }, [deleteId, endpoint, refetch])

  const handleBulkDelete = useCallback(async (ids: number[]) => {
    if (ids.length === 0) return
    setSaving(true)
    try {
      await api.delete(`${endpoint}/bulk`, { params: { ids }, paramsSerializer: { indexes: null } })
      refetch()
    } finally {
      setSaving(false)
    }
  }, [endpoint, refetch])

  return (
    <div>
      {error && (
        <div
          className="mb-4 p-3 rounded-lg border text-sm font-medium flex items-center justify-between"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderColor: '#ef4444', color: '#ef4444' }}
        >
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 text-lg leading-none">&times;</button>
        </div>
      )}
      {toolbarExtra}
      <DataTable<T>
        title={title}
        columns={columns}
        data={filterData ? filterData(data) : data}
        loading={loading}
        searchable
        searchKeys={searchKeys}
        onCreate={canCreate ? handleCreate : undefined}
        onEdit={canUpdate ? handleEdit : undefined}
        onDelete={canDelete ? ((row) => setDeleteId(row.id)) : undefined}
        onDuplicate={allowDuplicate && canCreate ? handleDuplicate : undefined}
        onImport={importEntity && canImport ? () => setImportOpen(true) : undefined}
        onExport={exportEntity && canExport ? (format) => downloadExport(exportEntity, format) : undefined}
        onBulkDelete={allowBulkDelete && canDelete ? handleBulkDelete : undefined}
      />

      <FormDialog
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditItem(undefined); setError(null) }}
        onSubmit={handleSave}
        title={editItem?.id ? editTitle : createTitle}
        fields={fields}
        initialData={editItem}
        loading={saving}
        error={formOpen ? error : null}
        renderExtra={formExtra}
        size={formSize}
      />

      <ConfirmDialog
        open={deleteId != null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title={t('common.deleteTitle')}
        message={t('common.deleteConfirm')}
        loading={saving}
      />

      {importEntity && (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          entityType={importEntity}
          onSuccess={refetch}
        />
      )}
    </div>
  )
}
