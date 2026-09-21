/* Composant table de données réutilisable / Reusable data table component */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export interface Column<T> {
  key: keyof T | string
  label: string
  sortable?: boolean
  render?: (row: T) => React.ReactNode
  width?: string
  minWidth?: string
  defaultHidden?: boolean
  /** Afficher un input filtre sous l'en-tête / Show a filter input below header */
  filterable?: boolean
  /** Clé alternative pour le filtrage (ex: origin_label au lieu de origin_id) / Alt key for filtering */
  filterKey?: keyof T
  /** Fonction retournant le texte filtrable (pour colonnes avec render) / Returns filterable text for rendered columns */
  filterValue?: (row: T) => string
}

interface DataTableProps<T extends { id: number }> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  onEdit?: (row: T) => void
  onDelete?: (row: T) => void
  onDuplicate?: (row: T) => void
  onCreate?: () => void
  onImport?: () => void
  onExport?: (format: 'csv' | 'xlsx') => void
  onRowClick?: (row: T) => void
  onBulkDelete?: (ids: number[]) => void
  activeRowId?: number | null
  title?: string
  searchable?: boolean
  searchKeys?: (keyof T)[]
}

export function DataTable<T extends { id: number }>({
  columns,
  data,
  loading,
  onEdit,
  onDelete,
  onDuplicate,
  onCreate,
  onImport,
  onExport,
  onRowClick,
  onBulkDelete,
  activeRowId,
  title,
  searchable = true,
  searchKeys = [],
}: DataTableProps<T>) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(0)
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    const hidden = new Set<string>()
    columns.forEach((col) => { if (col.defaultHidden) hidden.add(String(col.key)) })
    return hidden
  })
  const [showColMenu, setShowColMenu] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const colMenuRef = useRef<HTMLDivElement>(null)
  const exportMenuRef = useRef<HTMLDivElement>(null)
  const pageSize = 20

  /* Colonnes visibles / Visible columns */
  const visibleColumns = useMemo(
    () => columns.filter((col) => !hiddenCols.has(String(col.key))),
    [columns, hiddenCols]
  )

  /* Fermer les menus si clic en dehors / Close menus on outside click */
  useEffect(() => {
    if (!showColMenu && !showExportMenu) return
    const handleClick = (e: MouseEvent) => {
      if (showColMenu && colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) {
        setShowColMenu(false)
      }
      if (showExportMenu && exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showColMenu, showExportMenu])

  const toggleColumn = (key: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        /* Empêcher de masquer toutes les colonnes / Prevent hiding all columns */
        if (columns.length - next.size <= 1) return prev
        next.add(key)
      }
      return next
    })
  }

  /* Refs pour le redimensionnement des colonnes / Column resize refs */
  const resizingCol = useRef<string | null>(null)
  const resizeStartX = useRef(0)
  const resizeStartW = useRef(0)

  /* Début redimensionnement / Start resize */
  const handleResizeStart = useCallback((e: React.MouseEvent, colKey: string, thEl: HTMLTableCellElement) => {
    e.preventDefault()
    e.stopPropagation()
    resizingCol.current = colKey
    resizeStartX.current = e.clientX
    resizeStartW.current = thEl.offsetWidth

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - resizeStartX.current
      const newWidth = Math.max(50, resizeStartW.current + delta)
      setColWidths((prev) => ({ ...prev, [colKey]: newWidth }))
    }

    const handleMouseUp = () => {
      resizingCol.current = null
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  /* Colonnes filtrables / Filterable columns */
  const hasColumnFilters = columns.some((c) => c.filterable)

  /* Filtrage / Filtering */
  const filtered = useMemo(() => {
    let result = data

    // Filtres par colonne (ET) / Column filters (AND)
    const activeColFilters = Object.entries(colFilters).filter(([, v]) => v.length > 0)
    if (activeColFilters.length > 0) {
      result = result.filter((row) =>
        activeColFilters.every(([colKey, filterVal]) => {
          const col = columns.find((c) => String(c.key) === colKey)
          const q = filterVal.toLowerCase()
          // filterValue callback (texte rendu) / filterValue callback (rendered text)
          if (col?.filterValue) {
            return col.filterValue(row).toLowerCase().includes(q)
          }
          // Chercher dans filterKey (label) puis dans key (id) / Search in filterKey then key
          const fk = col?.filterKey
          if (fk) {
            const labelVal = row[fk]
            if (labelVal != null && String(labelVal).toLowerCase().includes(q)) return true
          }
          const val = (row as Record<string, unknown>)[colKey]
          return val != null && String(val).toLowerCase().includes(q)
        })
      )
    }

    // Recherche globale / Global search
    if (search && searchKeys.length > 0) {
      const q = search.toLowerCase()
      result = result.filter((row) =>
        searchKeys.some((key) => {
          const val = row[key]
          return val != null && String(val).toLowerCase().includes(q)
        })
      )
    }

    return result
  }, [data, search, searchKeys, colFilters, columns])

  /* Tri / Sorting */
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    return [...filtered].sort((a, b) => {
      const va = (a as Record<string, unknown>)[sortKey]
      const vb = (b as Record<string, unknown>)[sortKey]
      if (va == null) return 1
      if (vb == null) return -1
      const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir])

  /* Pagination */
  const totalPages = Math.ceil(sorted.length / pageSize)
  const paged = sorted.slice(page * pageSize, (page + 1) * pageSize)
  /* Toute la page est cochée → on peut proposer d'étendre au reste (#28). */
  const pageFullySelected = paged.length > 0 && paged.every((r) => selectedIds.has(r.id))

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const getCellValue = (row: T, key: string): React.ReactNode => {
    const val = (row as Record<string, unknown>)[key]
    if (val === true) return '✓'
    if (val === false) return '—'
    if (val == null) return '—'
    return String(val)
  }

  const getColWidth = (col: Column<T>): string | undefined => {
    const key = String(col.key)
    if (colWidths[key]) return `${colWidths[key]}px`
    return col.width
  }

  return (
    <div>
      {/* Barre d'outils / Toolbar */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          {title && (
            <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h2>
          )}
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            ({sorted.length})
          </span>
          {onBulkDelete && selectedIds.size > 0 && (
            <button
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors"
              style={{ backgroundColor: 'var(--color-danger)' }}
              onClick={() => setBulkConfirm(true)}
            >
              Supprimer ({selectedIds.size})
            </button>
          )}
          {/* Étendre la sélection à TOUTES les lignes filtrées (#28). La case
              d'en-tête ne coche que la page affichée — 20 lignes — ce qui
              imposait de supprimer par paquets de 20. On propose explicitement
              l'extension plutôt que de l'appliquer en douce : c'est une
              suppression de masse, elle doit rester un geste conscient. /
              Offer to extend the selection to every filtered row: the header
              checkbox only covers the visible page. */}
          {onBulkDelete && pageFullySelected && sorted.length > selectedIds.size && (
            <button
              className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors"
              style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
              onClick={() => setSelectedIds(new Set(sorted.map((r) => r.id)))}
            >
              Sélectionner les {sorted.length} lignes filtrées
            </button>
          )}
          {onBulkDelete && selectedIds.size > 0 && (
            <button
              className="px-2 py-1.5 rounded-lg text-xs transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onClick={() => setSelectedIds(new Set())}
            >
              Effacer la sélection
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {searchable && (
            <input
              type="text"
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0) }}
              className="px-3 py-1.5 rounded-lg text-sm border outline-none focus:ring-1"
              style={{
                backgroundColor: 'var(--bg-tertiary)',
                borderColor: 'var(--border-color)',
                color: 'var(--text-primary)',
              }}
            />
          )}
          {/* Menu colonnes / Column visibility toggle */}
          <div className="relative" ref={colMenuRef}>
            <button
              onClick={() => setShowColMenu((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              title={t('common.columns')}
            >
              ≡ {t('common.columns')}
            </button>
            {showColMenu && (
              <div
                className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[180px] max-h-[320px] overflow-y-auto"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  borderColor: 'var(--border-color)',
                }}
              >
                {columns.map((col) => {
                  const key = String(col.key)
                  const isVisible = !hiddenCols.has(key)
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm hover:opacity-80"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      <input
                        type="checkbox"
                        checked={isVisible}
                        onChange={() => toggleColumn(key)}
                        className="accent-orange-500"
                      />
                      {col.label}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
          {onImport && (
            <button
              onClick={onImport}
              className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              {t('common.import')}
            </button>
          )}
          {onExport && (
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setShowExportMenu((v) => !v)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
              >
                {t('common.export')} ▼
              </button>
              {showExportMenu && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[140px]"
                  style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
                >
                  <button
                    className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80"
                    style={{ color: 'var(--text-primary)' }}
                    onClick={() => { onExport('csv'); setShowExportMenu(false) }}
                  >
                    {t('common.exportCsv')}
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-sm hover:opacity-80"
                    style={{ color: 'var(--text-primary)' }}
                    onClick={() => { onExport('xlsx'); setShowExportMenu(false) }}
                  >
                    {t('common.exportExcel')}
                  </button>
                </div>
              )}
            </div>
          )}
          {onCreate && (
            <button
              onClick={onCreate}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors"
              style={{ backgroundColor: 'var(--color-primary)' }}
            >
              + {t('common.create')}
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
      >
        <div className="overflow-x-auto">
          <table className="text-sm" style={{ tableLayout: 'auto' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                {onBulkDelete && (
                  <th className="px-2 py-3 text-center" style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      className="accent-orange-500"
                      checked={pageFullySelected}
                      onChange={(e) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) { for (const r of paged) next.add(r.id) }
                          else { for (const r of paged) next.delete(r.id) }
                          return next
                        })
                      }}
                    />
                  </th>
                )}
                {visibleColumns.map((col) => (
                  <th
                    key={String(col.key)}
                    className={`px-4 py-3 text-left font-medium relative whitespace-nowrap ${col.sortable !== false ? 'cursor-pointer select-none hover:opacity-80' : ''}`}
                    style={{ color: 'var(--text-muted)', width: getColWidth(col), minWidth: col.minWidth || col.width || '50px', overflow: 'hidden' }}
                    onClick={() => col.sortable !== false && handleSort(String(col.key))}
                  >
                    <span className="flex items-center gap-1">
                      {col.label}
                      {sortKey === String(col.key) && (
                        <span className="text-xs">{sortDir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </span>
                    {/* Poignée de redimensionnement / Resize handle */}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-orange-500/30 transition-colors"
                      onMouseDown={(e) => {
                        const th = e.currentTarget.parentElement as HTMLTableCellElement
                        handleResizeStart(e, String(col.key), th)
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </th>
                ))}
                {(onEdit || onDelete || onDuplicate) && (
                  <th
                    className="px-4 py-3 text-right font-medium"
                    style={{
                      color: 'var(--text-muted)',
                      width: onDuplicate ? '150px' : '100px',
                      position: 'sticky',
                      right: 0,
                      zIndex: 2,
                      backgroundColor: 'var(--bg-tertiary)',
                      boxShadow: '-4px 0 8px -4px rgba(0,0,0,0.15)',
                    }}
                  >
                    {t('common.actions')}
                  </th>
                )}
              </tr>
              {/* Rangée de filtres par colonne / Column filter row */}
              {hasColumnFilters && (
                <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                  {onBulkDelete && <th className="px-2 pb-2 pt-0" />}
                  {visibleColumns.map((col) => (
                    <th key={`filter-${String(col.key)}`} className="px-2 pb-2 pt-0">
                      {col.filterable ? (
                        <input
                          type="text"
                          value={colFilters[String(col.key)] ?? ''}
                          onChange={(e) => {
                            setColFilters((prev) => ({ ...prev, [String(col.key)]: e.target.value }))
                            setPage(0)
                          }}
                          placeholder="🔍"
                          className="w-full px-2 py-1 rounded text-xs border outline-none focus:ring-1"
                          style={{
                            backgroundColor: 'var(--bg-primary)',
                            borderColor: colFilters[String(col.key)] ? 'var(--color-primary)' : 'var(--border-color)',
                            color: 'var(--text-primary)',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span />
                      )}
                    </th>
                  ))}
                  {(onEdit || onDelete || onDuplicate) && (
                    <th
                      className="px-2 pb-2 pt-0"
                      style={{
                        position: 'sticky',
                        right: 0,
                        zIndex: 2,
                        backgroundColor: 'var(--bg-tertiary)',
                        boxShadow: '-4px 0 8px -4px rgba(0,0,0,0.15)',
                      }}
                    />
                  )}
                </tr>
              )}
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={visibleColumns.length + (onBulkDelete ? 1 : 0) + 1} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    {t('common.loading')}
                  </td>
                </tr>
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length + (onBulkDelete ? 1 : 0) + 1} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                    {t('common.noData')}
                  </td>
                </tr>
              ) : (
                paged.map((row) => {
                  const isActive = activeRowId != null && row.id === activeRowId
                  return (
                    <tr
                      key={row.id}
                      className={`border-t transition-colors ${onRowClick ? 'cursor-pointer' : ''}`}
                      style={{
                        borderColor: 'var(--border-color)',
                        backgroundColor: isActive ? 'rgba(249,115,22,0.08)' : undefined,
                      }}
                      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = 'var(--bg-hover)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = isActive ? 'rgba(249,115,22,0.08)' : 'transparent' }}
                      onClick={() => onRowClick?.(row)}
                    >
                      {onBulkDelete && (
                        <td className="px-2 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="accent-orange-500"
                            checked={selectedIds.has(row.id)}
                            onChange={(e) => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(row.id)
                                else next.delete(row.id)
                                return next
                              })
                            }}
                          />
                        </td>
                      )}
                      {visibleColumns.map((col) => (
                        <td key={String(col.key)} className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                          {col.render ? col.render(row) : getCellValue(row, String(col.key))}
                        </td>
                      ))}
                      {(onEdit || onDelete || onDuplicate) && (
                        <td
                          className="px-4 py-2.5 text-right"
                          style={{
                            position: 'sticky',
                            right: 0,
                            zIndex: 1,
                            backgroundColor: isActive ? 'var(--bg-secondary)' : 'var(--bg-secondary)',
                            boxShadow: '-4px 0 8px -4px rgba(0,0,0,0.15)',
                          }}
                        >
                          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            {onDuplicate && (
                              <button
                                onClick={() => onDuplicate(row)}
                                className="px-2 py-1 rounded text-xs transition-colors"
                                style={{ color: 'var(--text-secondary)' }}
                              >
                                {t('common.duplicate')}
                              </button>
                            )}
                            {onEdit && (
                              <button
                                onClick={() => onEdit(row)}
                                className="px-2 py-1 rounded text-xs transition-colors"
                                style={{ color: 'var(--color-primary)' }}
                              >
                                {t('common.edit')}
                              </button>
                            )}
                            {onDelete && (
                              <button
                                onClick={() => onDelete(row)}
                                className="px-2 py-1 rounded text-xs transition-colors"
                                style={{ color: 'var(--color-danger)' }}
                              >
                                {t('common.delete')}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-4 py-3 border-t"
            style={{ borderColor: 'var(--border-color)' }}
          >
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} / {sorted.length}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-1 rounded text-xs disabled:opacity-30"
                style={{ color: 'var(--text-secondary)' }}
              >
                ←
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 rounded text-xs disabled:opacity-30"
                style={{ color: 'var(--text-secondary)' }}
              >
                →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Dialogue confirmation suppression en masse / Bulk delete confirmation */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="rounded-xl border p-6 shadow-xl max-w-sm w-full" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
            <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Confirmer la suppression</h3>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
              Supprimer <strong>{selectedIds.size}</strong> ligne{selectedIds.size > 1 ? 's' : ''} sélectionnée{selectedIds.size > 1 ? 's' : ''} ?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                onClick={() => setBulkConfirm(false)}
              >
                Annuler
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                style={{ backgroundColor: 'var(--color-danger)' }}
                onClick={() => {
                  onBulkDelete?.(Array.from(selectedIds))
                  setSelectedIds(new Set())
                  setBulkConfirm(false)
                }}
              >
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
