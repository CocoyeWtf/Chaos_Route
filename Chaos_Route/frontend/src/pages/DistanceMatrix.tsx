/* Page Distancier enrichi / Enriched distance matrix management page */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CrudPage } from '../components/data/CrudPage'
import { ImportDialog } from '../components/data/ImportDialog'
import type { Column } from '../components/data/DataTable'
import type { FieldDef } from '../components/data/FormDialog'
import type { DistanceEntry } from '../types'
import api from '../services/api'

interface CoverageRow {
  base_id: number
  base_code: string
  base_name: string
  has_coordinates: boolean
  pdv_total: number
  pdv_covered: number
  pdv_missing: number
  estimated_rows: number
}

export default function DistanceMatrix() {
  const { t } = useTranslation()
  const [timeImportOpen, setTimeImportOpen] = useState(false)
  const [serverSearch, setServerSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  /* Couverture du distancier base par base (#96) : un trou ne se voyait
     jusqu'ici qu'au moment ou une tournee sortait a 0 km — trop tard. */
  const [coverage, setCoverage] = useState<CoverageRow[] | null>(null)
  const [filling, setFilling] = useState<number | null>(null)
  const [fillResult, setFillResult] = useState<string | null>(null)

  /* Charger le total / Load total count */
  useEffect(() => {
    api.get('/distance-matrix/count/').then((res) => {
      setTotalCount(res.data.count)
    }).catch(() => {})
  }, [])

  const loadCoverage = useCallback(() => {
    api.get<CoverageRow[]>('/distance-matrix/coverage')
      .then((r) => setCoverage(r.data))
      .catch(() => setCoverage(null))
  }, [])

  useEffect(() => { loadCoverage() }, [loadCoverage])

  /* Completer les paires manquantes d'une base (#96). Simulation d'abord : on
     annonce ce qui serait ecrit, on n'ecrase jamais une distance mesuree. */
  const handleFill = useCallback(async (row: CoverageRow, dryRun: boolean) => {
    setFilling(row.base_id)
    setFillResult(null)
    try {
      const { data } = await api.post('/distance-matrix/fill-missing', null, {
        params: { base_id: row.base_id, dry_run: dryRun },
      })
      const copiees = data.copiees_depuis_base_jumelle ?? 0
      const estimees = data.estimees ?? 0
      const impossibles = data.impossibles ?? 0
      const fin = impossibles ? ', ' + impossibles + ' impossible(s) faute de coordonnees' : ''
      setFillResult(
        row.base_code + ' — ' + (dryRun ? 'simulation' : 'applique') + ' : '
        + copiees + ' trajet(s) repris d\u2019une base situee au meme endroit, '
        + estimees + ' estime(s) a vol d\u2019oiseau' + fin + '.',
      )
      if (!dryRun) loadCoverage()
    } catch {
      setFillResult(row.base_code + ' — echec.')
    } finally {
      setFilling(null)
    }
  }, [loadCoverage])

  /* Debounce la recherche serveur / Debounce server search */
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setServerSearch(value)
    }, 400)
  }, [])

  const apiParams: Record<string, unknown> = { limit: 500 }
  if (serverSearch) apiParams.search = serverSearch

  const pointTypeOptions = [
    { value: 'BASE', label: 'Base' },
    { value: 'PDV', label: 'PDV' },
    { value: 'SUPPLIER', label: t('suppliers.title') },
  ]

  const columns: Column<DistanceEntry>[] = [
    {
      key: 'origin_type', label: t('distances.originType'), width: '90px',
      filterable: true,
    },
    {
      key: 'origin_id', label: t('distances.originId'), width: '180px',
      render: (row) => row.origin_label ?? `#${row.origin_id}`,
      filterable: true, filterKey: 'origin_label',
    },
    {
      key: 'destination_type', label: t('distances.destinationType'), width: '90px',
      filterable: true,
    },
    {
      key: 'destination_id', label: t('distances.destinationId'), width: '180px',
      render: (row) => row.destination_label ?? `#${row.destination_id}`,
      filterable: true, filterKey: 'destination_label',
    },
    {
      key: 'distance_km', label: t('distances.distanceKm'), width: '130px',
      render: (row) => (
        <span>
          {row.distance_km} km
          {row.is_estimated && (
            <span className="ml-1 px-1 rounded text-[9px] font-bold align-middle"
              style={{ backgroundColor: 'rgba(245,158,11,0.18)', color: '#f59e0b' }}
              title="Estimation a vol d&apos;oiseau, en attente de la distance reelle (#96)">
              EST.
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'duration_minutes', label: t('distances.durationMin'), width: '100px',
      render: (row) => `${row.duration_minutes} min`,
    },
  ]

  const fields: FieldDef[] = [
    { key: 'origin_type', label: t('distances.originType'), type: 'select', required: true, options: pointTypeOptions },
    { key: 'origin_id', label: t('distances.originId'), type: 'number', required: true, min: 1 },
    { key: 'destination_type', label: t('distances.destinationType'), type: 'select', required: true, options: pointTypeOptions },
    { key: 'destination_id', label: t('distances.destinationId'), type: 'number', required: true, min: 1 },
    { key: 'distance_km', label: t('distances.distanceKm'), type: 'number', required: true, step: 0.01, min: 0 },
    { key: 'duration_minutes', label: t('distances.durationMin'), type: 'number', required: true, min: 0 },
  ]

  return (
    <>
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={() => setTimeImportOpen(true)}
          className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors hover:opacity-80"
          style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
        >
          {t('timeBreakdown.importTimeMatrix')}
        </button>
        {/* Recherche serveur / Server-side search */}
        <input
          type="text"
          placeholder="Rechercher base/PDV..."
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-sm border outline-none focus:ring-1"
          style={{
            backgroundColor: 'var(--bg-tertiary)',
            borderColor: 'var(--border-color)',
            color: 'var(--text-primary)',
            width: '260px',
          }}
        />
        {totalCount != null && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {serverSearch ? 'Resultats filtrés' : `${totalCount.toLocaleString('fr-FR')} entrées au total`}
            {' — affichage limité à 500'}
          </span>
        )}
      </div>
      {/* Couverture du distancier (#96). Une paire absente vaut silencieusement
          0 km et 0 minute dans le calcul : la tournee sort sans carburant ni
          taxe kilometrique. Ce tableau rend le trou visible avant la tournee. */}
      {coverage && coverage.some((c) => c.pdv_missing > 0) && (
        <div className="mb-3 rounded-xl border p-3"
          style={{ backgroundColor: 'var(--bg-secondary)', borderColor: '#f59e0b' }}>
          <p className="text-sm font-semibold mb-1" style={{ color: '#f59e0b' }}>
            Trous dans le distancier
          </p>
          <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            Un trajet absent compte <strong>0 km et 0 minute</strong> : la tournee sort
            sans carburant ni taxe kilometrique, et son cout est faux.
          </p>
          <table className="text-xs w-full">
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th className="text-left py-1">Base</th>
                <th className="text-right py-1">PDV joignables</th>
                <th className="text-right py-1">Manquants</th>
                <th className="text-right py-1">Estimes</th>
                <th className="text-right py-1" />
              </tr>
            </thead>
            <tbody>
              {coverage.map((c) => (
                <tr key={c.base_id} className="border-t" style={{ borderColor: 'var(--border-color)' }}>
                  <td className="py-1" style={{ color: 'var(--text-primary)' }}>
                    {c.base_code} — {c.base_name}
                    {!c.has_coordinates && (
                      <span className="ml-1 text-[10px]" style={{ color: '#ef4444' }}>
                        (sans coordonnees)
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                    {c.pdv_covered} / {c.pdv_total}
                  </td>
                  <td className="py-1 text-right font-bold"
                    style={{ color: c.pdv_missing > 0 ? '#ef4444' : 'var(--text-muted)' }}>
                    {c.pdv_missing}
                  </td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-muted)' }}>
                    {c.estimated_rows || '—'}
                  </td>
                  <td className="py-1 text-right">
                    {c.pdv_missing > 0 && (
                      <>
                        <button onClick={() => handleFill(c, true)} disabled={filling === c.base_id}
                          className="px-2 py-0.5 rounded text-[11px] mr-1"
                          style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                          Simuler
                        </button>
                        <button onClick={() => handleFill(c, false)} disabled={filling === c.base_id}
                          className="px-2 py-0.5 rounded text-[11px] font-semibold"
                          style={{ border: '1px solid #f59e0b', color: '#f59e0b' }}>
                          Completer
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {fillResult && (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-primary)' }}>{fillResult}</p>
          )}
          <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            &laquo;&nbsp;Completer&nbsp;&raquo; reprend d&apos;abord la valeur d&apos;une base situee au meme
            endroit — exact, pas une estimation — puis estime le reste a vol d&apos;oiseau
            (&times;&nbsp;1,3), marque <strong>EST.</strong> Les distances deja saisies ne sont jamais ecrasees.
          </p>
        </div>
      )}

      <CrudPage<DistanceEntry>
        resource="distances"
        title={t('distances.title')}
        endpoint="/distance-matrix"
        columns={columns}
        fields={fields}
        searchKeys={[]}
        createTitle={t('distances.new')}
        editTitle={t('distances.edit')}
        importEntity="distances"
        exportEntity="distances"
        apiParams={apiParams}
      />
      <ImportDialog
        open={timeImportOpen}
        onClose={() => setTimeImportOpen(false)}
        entityType="time-matrix"
        onSuccess={() => { setTimeImportOpen(false); window.location.reload() }}
      />
    </>
  )
}
