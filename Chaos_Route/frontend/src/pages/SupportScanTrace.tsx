/* Tracabilite des scans supports / Support scan traceability.

   Repond a une seule question : OU a-t-on scanne QUEL support, QUAND, par
   quel CHAUFFEUR et pour quel TRANSPORTEUR. Deux vues sur la meme donnee —
   une liste exportable et une carte. / Where each support was scanned, when,
   by which driver, under which carrier. */

import { Fragment, useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useApi } from '../hooks/useApi'
import { DataTable } from '../components/data/DataTable'
import type { Column } from '../components/data/DataTable'
import type { Carrier, SupportScanTrace } from '../types'
import 'leaflet/dist/leaflet.css'

/* Au-dela de ce rayon, le scan n'a pas ete fait au PDV : c'est le seuil qui
   transforme la carte en controle. 300 m couvre un grand parking et l'erreur
   GPS courante en ville. / Beyond this radius the scan did not happen at the
   PDV — 300 m covers a large car park plus typical urban GPS error. */
const FAR_FROM_PDV_M = 300

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* Par defaut on n'ouvre QUE la journee : une semaine de scans, c'est des
   dizaines de milliers de lignes a charger pour rien. L'utilisateur elargit
   la plage quand il cherche un support precis. / Default to today only — a
   week of scans is tens of thousands of rows; widen on demand. */

/* Date et heure locales lisibles / Readable local date + time */
function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: iso.substring(0, 10), time: iso.substring(11, 19) }
  return {
    date: d.toLocaleDateString('fr-FR'),
    time: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }
}

function formatDistance(m: number | null | undefined): string {
  if (m == null) return '—'
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

/* Recentrer la carte sur les points affiches / Fit map to displayed points */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (points.length === 0) return
    if (points.length === 1) {
      map.setView(points[0], 15)
      return
    }
    const bounds = L.latLngBounds(points.map(([lat, lng]) => L.latLng(lat, lng)))
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
  }, [map, points])
  return null
}

export default function SupportScanTrace() {
  const [dateFrom, setDateFrom] = useState(today)
  const [dateTo, setDateTo] = useState(today)
  const [carrierId, setCarrierId] = useState('')
  const [driver, setDriver] = useState('')
  const [barcode, setBarcode] = useState('')
  const [onlyGeolocated, setOnlyGeolocated] = useState(false)
  const [view, setView] = useState<'list' | 'map'>('list')
  const [selected, setSelected] = useState<SupportScanTrace | null>(null)

  const [filters, setFilters] = useState<Record<string, unknown>>({
    date_from: today(),
    date_to: today(),
  })

  const { data: scans, loading } = useApi<SupportScanTrace>('/tracking/support-scans', filters)
  const { data: carriers } = useApi<Carrier>('/carriers')

  const applyFilters = () => {
    const params: Record<string, unknown> = {}
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    if (carrierId) params.carrier_id = Number(carrierId)
    if (driver.trim()) params.driver = driver.trim()
    if (barcode.trim()) params.barcode = barcode.trim()
    if (onlyGeolocated) params.only_geolocated = true
    setFilters(params)
  }

  const stats = useMemo(() => {
    const total = scans.length
    const located = scans.filter((s) => s.latitude != null && s.longitude != null).length
    const far = scans.filter((s) => s.distance_to_pdv_m != null && s.distance_to_pdv_m > FAR_FROM_PDV_M).length
    const wrongPdv = scans.filter((s) => !s.expected_at_stop).length
    return { total, located, far, wrongPdv }
  }, [scans])

  const geolocated = useMemo(
    () => scans.filter((s) => s.latitude != null && s.longitude != null),
    [scans],
  )

  const mapPoints = useMemo<[number, number][]>(
    () => geolocated.map((s) => [s.latitude!, s.longitude!]),
    [geolocated],
  )

  const exportCsv = () => {
    const header = [
      'Code-barres', 'Date', 'Heure', 'Latitude', 'Longitude', 'Precision (m)',
      'Distance PDV (m)', 'PDV', 'Nom PDV', 'Ville', 'Attendu ici', 'PDV attendu',
      'Chauffeur', 'Transporteur', 'Contrat', 'Tournee', 'Date livraison', 'Base', 'Appareil',
    ]
    const rows = scans.map((s) => {
      const { date, time } = formatDateTime(s.timestamp)
      return [
        s.barcode, date, time,
        s.latitude ?? '', s.longitude ?? '', s.accuracy != null ? Math.round(s.accuracy) : '',
        s.distance_to_pdv_m != null ? Math.round(s.distance_to_pdv_m) : '',
        s.pdv_code ?? '', s.pdv_name ?? '', s.pdv_city ?? '',
        s.expected_at_stop ? 'oui' : 'NON', s.expected_pdv_code ?? '',
        s.driver_name ?? '', s.carrier_name ?? '', s.contract_code ?? '',
        s.tour_code ?? '', s.delivery_date ?? '', s.base_name ?? '', s.device_name ?? '',
      ]
    })
    const csv = [header, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';'))
      .join('\n')
    // BOM UTF-8 : sans lui Excel FR casse les accents / UTF-8 BOM for Excel
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `scans_supports_${dateFrom}_${dateTo}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const columns: Column<SupportScanTrace>[] = [
    {
      key: 'timestamp', label: 'Date / heure', width: '150px',
      render: (row) => {
        const { date, time } = formatDateTime(row.timestamp)
        return (
          <span>
            {date} <span style={{ color: 'var(--text-muted)' }}>{time}</span>
          </span>
        )
      },
    },
    { key: 'barcode', label: 'Support', width: '140px', filterable: true },
    {
      key: 'pdv_code', label: 'PDV', width: '190px', filterable: true,
      render: (row) => (
        <span title={`${row.pdv_name || ''}${row.pdv_city ? ` — ${row.pdv_city}` : ''}`}>
          {row.pdv_code || '—'}
          {row.pdv_name ? <span style={{ color: 'var(--text-muted)' }}> {row.pdv_name}</span> : null}
        </span>
      ),
      filterValue: (row) => row.pdv_code || '',
    },
    {
      key: 'latitude', label: 'Position', width: '160px',
      render: (row) => {
        if (row.latitude == null || row.longitude == null) {
          return <span style={{ color: '#ef4444' }}>non localise</span>
        }
        return (
          <span title={`${row.latitude}, ${row.longitude}`}>
            {row.latitude.toFixed(5)}, {row.longitude.toFixed(5)}
            {row.accuracy != null ? (
              <span style={{ color: 'var(--text-muted)' }}> ±{Math.round(row.accuracy)}m</span>
            ) : null}
          </span>
        )
      },
    },
    {
      key: 'distance_to_pdv_m', label: 'Ecart PDV', width: '100px',
      render: (row) => {
        if (row.distance_to_pdv_m == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>
        const far = row.distance_to_pdv_m > FAR_FROM_PDV_M
        return (
          <span style={{ color: far ? '#f59e0b' : 'var(--text-secondary)', fontWeight: far ? 600 : 400 }}>
            {formatDistance(row.distance_to_pdv_m)}
          </span>
        )
      },
    },
    {
      key: 'driver_name', label: 'Chauffeur', width: '150px', filterable: true,
      render: (row) => row.driver_name || '—',
      filterValue: (row) => row.driver_name || '',
    },
    {
      key: 'carrier_name', label: 'Transporteur', width: '170px', filterable: true,
      render: (row) => row.carrier_name || <span style={{ color: 'var(--text-muted)' }}>en propre</span>,
      // Une tournee sans contrat est faite en propre : libelle explicite dans
      // le filtre plutot qu'une case vide. / No contract = own fleet.
      filterValue: (row) => row.carrier_name || 'En propre',
    },
    {
      key: 'tour_code', label: 'Tournee', width: '120px', filterable: true,
      render: (row) => row.tour_code || '—',
      filterValue: (row) => row.tour_code || '',
    },
    {
      key: 'expected_at_stop', label: 'Conforme', width: '110px', filterable: true,
      render: (row) => row.expected_at_stop
        ? <span style={{ color: '#22c55e' }}>oui</span>
        : (
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: '#ef444420', color: '#ef4444' }}
            title={row.expected_pdv_code ? `Attendu au PDV ${row.expected_pdv_code}` : 'Hors manifeste'}
          >
            mauvais PDV
          </span>
        ),
      filterValue: (row) => (row.expected_at_stop ? 'Conforme' : 'Mauvais PDV'),
    },
  ]

  const inputStyle = {
    backgroundColor: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
  }

  return (
    <div className="p-6 flex flex-col" style={{ height: '100%' }}>
      <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        Tracabilite des scans supports
      </h1>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        Ou chaque support a ete scanne, quand, par quel chauffeur et pour quel transporteur.
      </p>

      {/* Filtres */}
      <div className="flex gap-3 mb-4 items-end flex-wrap">
        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Du</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded px-3 py-1.5 text-sm" style={inputStyle} />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Au</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded px-3 py-1.5 text-sm" style={inputStyle} />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Transporteur</label>
          <select value={carrierId} onChange={(e) => setCarrierId(e.target.value)}
            className="rounded px-3 py-1.5 text-sm" style={inputStyle}>
            <option value="">Tous</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Chauffeur</label>
          <input type="text" value={driver} onChange={(e) => setDriver(e.target.value)}
            placeholder="Nom..." className="rounded px-3 py-1.5 text-sm" style={inputStyle} />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Code-barres</label>
          <input type="text" value={barcode} onChange={(e) => setBarcode(e.target.value)}
            placeholder="Support..." className="rounded px-3 py-1.5 text-sm" style={inputStyle} />
        </div>
        <label className="flex items-center gap-2 text-sm pb-1.5" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={onlyGeolocated} onChange={(e) => setOnlyGeolocated(e.target.checked)} />
          Geolocalises seulement
        </label>
        <button onClick={applyFilters} className="px-4 py-1.5 rounded text-sm font-medium"
          style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}>
          Filtrer
        </button>
        <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border-color)' }}>
          {(['list', 'map'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className="px-3 py-1.5 text-sm"
              style={{
                backgroundColor: view === v ? 'var(--color-primary)' : 'var(--bg-tertiary)',
                color: view === v ? '#fff' : 'var(--text-secondary)',
              }}>
              {v === 'list' ? 'Liste' : 'Carte'}
            </button>
          ))}
        </div>
      </div>

      {/* Indicateurs */}
      <div className="flex gap-6 mb-3 text-sm flex-wrap" style={{ color: 'var(--text-secondary)' }}>
        <span><strong>{stats.total}</strong> scans</span>
        <span>
          <strong>{stats.located}</strong> geolocalises
          {stats.total > 0 && (
            <span style={{ color: stats.located < stats.total ? '#f59e0b' : '#22c55e' }}>
              {' '}({Math.round((stats.located / stats.total) * 100)} %)
            </span>
          )}
        </span>
        <span style={{ color: stats.far > 0 ? '#f59e0b' : undefined }}>
          <strong>{stats.far}</strong> a plus de {FAR_FROM_PDV_M} m du PDV
        </span>
        <span style={{ color: stats.wrongPdv > 0 ? '#ef4444' : undefined }}>
          <strong>{stats.wrongPdv}</strong> au mauvais PDV
        </span>
      </div>

      {view === 'list' ? (
        <DataTable
          columns={columns}
          data={scans}
          loading={loading}
          searchable
          searchKeys={['barcode', 'pdv_code', 'pdv_name', 'driver_name', 'carrier_name', 'tour_code']}
          onExport={exportCsv}
          onRowClick={(row) => setSelected(row)}
        />
      ) : (
        <div className="flex-1 relative rounded overflow-hidden" style={{ minHeight: '400px' }}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center z-[500]"
              style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
              <span style={{ color: '#fff' }}>Chargement...</span>
            </div>
          )}
          <MapContainer center={[50.5, 4.35]} zoom={8} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            />
            <FitBounds points={mapPoints} />
            {geolocated.map((s) => {
              const far = s.distance_to_pdv_m != null && s.distance_to_pdv_m > FAR_FROM_PDV_M
              const color = !s.expected_at_stop ? '#ef4444' : far ? '#f59e0b' : '#22c55e'
              const { date, time } = formatDateTime(s.timestamp)
              return (
                <Fragment key={s.id}>
                  {/* Trait scan -> PDV : rend l'ecart lisible d'un coup d'oeil */}
                  {far && s.pdv_latitude != null && s.pdv_longitude != null && (
                    <Polyline
                      positions={[[s.latitude!, s.longitude!], [s.pdv_latitude, s.pdv_longitude]]}
                      pathOptions={{ color: '#f59e0b', weight: 1, dashArray: '4 4' }}
                    />
                  )}
                  <CircleMarker
                    center={[s.latitude!, s.longitude!]}
                    radius={6}
                    pathOptions={{ color, fillColor: color, fillOpacity: 0.75, weight: 1 }}
                  >
                    <Tooltip direction="top" offset={[0, -6]}>
                      <div style={{ fontSize: '11px', lineHeight: 1.4 }}>
                        <strong>{s.barcode}</strong><br />
                        {date} {time}<br />
                        {s.pdv_code || '—'} {s.pdv_name || ''}
                      </div>
                    </Tooltip>
                    <Popup>
                      <div style={{ minWidth: '230px', fontSize: '12px', lineHeight: 1.5 }}>
                        <div style={{ fontWeight: 700, fontSize: '13px' }}>{s.barcode}</div>
                        <div>{date} a {time}</div>
                        <div>PDV : {s.pdv_code || '—'} {s.pdv_name || ''}</div>
                        <div>Chauffeur : {s.driver_name || '—'}</div>
                        <div>Transporteur : {s.carrier_name || 'en propre'}</div>
                        <div>Tournee : {s.tour_code || '—'}</div>
                        <div>
                          Ecart PDV : {formatDistance(s.distance_to_pdv_m)}
                          {s.accuracy != null ? ` (precision ±${Math.round(s.accuracy)} m)` : ''}
                        </div>
                        {!s.expected_at_stop && (
                          <div style={{ color: '#ef4444', fontWeight: 600 }}>
                            Attendu au PDV {s.expected_pdv_code || '(hors manifeste)'}
                          </div>
                        )}
                      </div>
                    </Popup>
                  </CircleMarker>
                </Fragment>
              )
            })}
          </MapContainer>
        </div>
      )}

      {/* Detail */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative w-full max-w-md overflow-y-auto p-6"
            style={{ backgroundColor: 'var(--bg-primary)' }}
            onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setSelected(null)} className="absolute top-4 right-4 text-lg"
              style={{ color: 'var(--text-muted)' }}>x</button>

            <h2 className="text-lg font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
              Support {selected.barcode}
            </h2>

            <div className="space-y-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <p>Date : {formatDateTime(selected.timestamp).date} a {formatDateTime(selected.timestamp).time}</p>
              <p>Chauffeur : {selected.driver_name || '—'}</p>
              <p>Transporteur : {selected.carrier_name || 'en propre'}
                {selected.contract_code ? ` (contrat ${selected.contract_code})` : ''}</p>
              <p>Tournee : {selected.tour_code || '—'}
                {selected.delivery_date ? ` du ${selected.delivery_date}` : ''}</p>
              <p>Base : {selected.base_name || '—'}</p>
              <p>PDV : {selected.pdv_code || '—'} {selected.pdv_name || ''}
                {selected.pdv_city ? ` (${selected.pdv_city})` : ''}</p>
              <p>Appareil : {selected.device_name || `#${selected.device_id ?? '—'}`}</p>
              {selected.latitude != null && selected.longitude != null ? (
                <>
                  <p>
                    Position : {selected.latitude.toFixed(6)}, {selected.longitude.toFixed(6)}
                    {selected.accuracy != null ? ` (±${Math.round(selected.accuracy)} m)` : ''}
                  </p>
                  <p>Ecart au PDV : {formatDistance(selected.distance_to_pdv_m)}</p>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${selected.latitude}&mlon=${selected.longitude}#map=18/${selected.latitude}/${selected.longitude}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: 'var(--color-primary)' }}
                  >
                    Ouvrir dans OpenStreetMap
                  </a>
                </>
              ) : (
                <p style={{ color: '#ef4444' }}>
                  Position non enregistree (GPS indisponible ou suivi refuse sur cet appareil)
                </p>
              )}
              {!selected.expected_at_stop && (
                <p style={{ color: '#ef4444', fontWeight: 600 }}>
                  Scanne au mauvais PDV — attendu {selected.expected_pdv_code || 'hors manifeste'}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
