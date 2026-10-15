/* Feuille de route chauffeur / Driver route sheet (printable overlay) */

import { useState, useEffect, useRef } from 'react'
import JsBarcode from 'jsbarcode'
import { useTranslation } from 'react-i18next'
import api from '../../services/api'
import type { WaybillData } from '../../types'

interface DriverRouteSheetProps {
  tourId: number
  onClose: () => void
}

/* Construire libellé reprises / Build pickup label */
function pickupLabel(stop: { pickup_cardboard?: boolean; pickup_containers?: boolean; pickup_returns?: boolean; pickup_consignment?: boolean }): string {
  const parts: string[] = []
  if (stop.pickup_cardboard) parts.push('C')
  if (stop.pickup_containers) parts.push('B')
  if (stop.pickup_returns) parts.push('R')
  if (stop.pickup_consignment) parts.push('K')
  return parts.join('+')
}

export function DriverRouteSheet({ tourId, onClose }: DriverRouteSheetProps) {
  const { t } = useTranslation()
  const [data, setData] = useState<WaybillData | null>(null)
  const [loading, setLoading] = useState(true)
  const barcodeRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    setLoading(true)
    api.get(`/tours/${tourId}/waybill`)
      .then((r) => setData(r.data))
      .catch((e) => console.error('Failed to load route sheet data', e))
      .finally(() => setLoading(false))
  }, [tourId])

  /* Générer code-barre tour / Generate tour barcode */
  useEffect(() => {
    if (barcodeRef.current && data?.tour_code) {
      JsBarcode(barcodeRef.current, data.tour_code, {
        format: 'CODE128',
        width: 1.5,
        height: 40,
        displayValue: false,
        margin: 4,
      })
    }
  }, [data?.tour_code])

  const formatDate = (iso: string) => {
    const d = new Date(iso + 'T00:00:00')
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  const totalEqp = data ? data.stops.reduce((s, st) => s + st.eqp_count, 0) : 0
  const totalWeight = data ? data.stops.reduce((s, st) => s + (st.weight_kg || 0), 0) : 0
  const baseLabel = data?.base ? `${data.base.code} — ${data.base.name}` : ''

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: '#fff' }}>
      {/* Toolbar (masquée impression) / Toolbar (hidden on print) */}
      <div
        className="print-hide flex items-center justify-between px-6 py-3 border-b"
        style={{ borderColor: 'var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}
      >
        <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          {t('driverRoute.title')}
        </h2>
        <div className="flex gap-3">
          <button
            onClick={() => window.print()}
            className="px-4 py-2 rounded-lg text-sm font-semibold"
            style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
          >
            {t('driverRoute.print')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-semibold border"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          >
            {t('driverRoute.close')}
          </button>
        </div>
      </div>

      {/* Contenu imprimable / Printable content */}
      <div className="flex-1 overflow-y-auto print-content" style={{ padding: '10px 16px' }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: '#999', padding: '40px 0' }}>
            {t('common.loading')}
          </p>
        ) : !data ? (
          <p style={{ textAlign: 'center', color: '#999', padding: '40px 0' }}>
            {t('common.noData')}
          </p>
        ) : (
          <div style={{ color: '#000', fontSize: '11px', maxWidth: '1100px', margin: '0 auto' }}>
            {/* Layout principal en 2 colonnes : infos à droite, tableau stops à gauche / 2 column layout */}
            <div style={{ display: 'flex', gap: '16px' }}>

              {/* Colonne gauche : tableau des arrêts / Left column: stop table */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <table style={tblStyle}>
                  <thead>
                    <tr style={{ backgroundColor: '#eee' }}>
                      <th style={{ ...thStyle, width: '30px' }}>#</th>
                      <th style={{ ...thStyle, width: '60px' }}>{t('driverRoute.pdvCode')}</th>
                      <th style={{ ...thStyle, width: '40px' }}>EQC</th>
                      <th style={{ ...thStyle, width: '50px' }}>{t('driverRoute.weight')}</th>
                      <th style={thStyle}>{t('driverRoute.city')}</th>
                      <th style={thStyle}>{t('driverRoute.address')}</th>
                      <th style={{ ...thStyle, width: '45px' }}>{t('driverRoute.arrival')}</th>
                      <th style={{ ...thStyle, width: '45px' }}>{t('driverRoute.departure')}</th>
                      <th style={{ ...thStyle, width: '50px' }}>{t('driverRoute.pickups')}</th>
                      <th style={{ ...thStyle, width: '70px' }}>{t('driverRoute.message')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Ligne départ base / Base departure row */}
                    <tr style={{ backgroundColor: '#f5f5f5' }}>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>D</td>
                      <td style={{ ...tdStyle, fontWeight: 'bold' }} colSpan={3}>{t('driverRoute.baseDeparture')}</td>
                      <td style={tdStyle} colSpan={2}>{baseLabel}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}></td>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>{data.departure_time ?? ''}</td>
                      <td style={tdStyle}></td>
                      <td style={tdStyle}></td>
                    </tr>
                    {data.stops.map((stop, idx) => (
                      <tr key={idx}>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>{idx + 1}</td>
                        <td style={{ ...tdStyle, fontWeight: 'bold' }}>{stop.pdv_code}</td>
                        <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>{stop.eqp_count}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{stop.weight_kg > 0 ? Math.round(stop.weight_kg) : ''}</td>
                        <td style={tdStyle}>{stop.city}</td>
                        <td style={{ ...tdStyle, fontSize: '10px' }}>{stop.address}</td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>{stop.arrival_time ?? ''}</td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>{stop.departure_time ?? ''}</td>
                        <td style={{ ...tdStyle, textAlign: 'center', fontSize: '10px' }}>{pickupLabel(stop)}</td>
                        <td style={tdStyle}></td>
                      </tr>
                    ))}
                    {/* Enlevement fournisseur avant le retour (#74, affiche au #57).
                        Il entrait deja dans les horaires et les kilometres, mais
                        n'etait imprime nulle part : le chauffeur ne savait pas
                        qu'il devait y passer. Il s'intercale a sa vraie place,
                        apres le dernier point de vente et avant le retour. */}
                    {data.final_pickup && (
                      <tr style={{ backgroundColor: '#f3e8ff' }}>
                        <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>E</td>
                        <td style={{ ...tdStyle, fontWeight: 'bold' }} colSpan={3}>
                          ENLÈVEMENT — {data.final_pickup.name}
                        </td>
                        <td style={tdStyle}>{data.final_pickup.city ?? ''}</td>
                        <td style={{ ...tdStyle, fontSize: '10px' }}>{data.final_pickup.address ?? ''}</td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}></td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}></td>
                        <td style={{ ...tdStyle, textAlign: 'center', fontSize: '10px' }}>
                          {data.final_pickup.duration_minutes
                            ? `${data.final_pickup.duration_minutes} min`
                            : ''}
                        </td>
                        <td style={tdStyle}></td>
                      </tr>
                    )}
                    {/* Ligne retour base / Base return row */}
                    <tr style={{ backgroundColor: '#f5f5f5' }}>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>R</td>
                      <td style={{ ...tdStyle, fontWeight: 'bold' }} colSpan={3}>{t('driverRoute.baseReturn')}</td>
                      <td style={tdStyle} colSpan={2}>{baseLabel}</td>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>{data.return_time ?? ''}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}></td>
                      <td style={tdStyle}></td>
                      <td style={tdStyle}></td>
                    </tr>
                    {/* Ligne totaux / Totals row */}
                    <tr style={{ backgroundColor: '#eee', fontWeight: 'bold' }}>
                      <td style={{ ...tdStyle, fontWeight: 'bold' }}></td>
                      <td style={{ ...tdStyle, fontWeight: 'bold' }}>TOTAL</td>
                      <td style={{ ...tdStyle, textAlign: 'center', fontWeight: 'bold' }}>{totalEqp}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 'bold' }}>{totalWeight > 0 ? Math.round(totalWeight) : ''}</td>
                      <td style={tdStyle} colSpan={6}></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Colonne droite : informations tour / Right column: tour info */}
              <div style={{ width: '280px', flexShrink: 0 }}>
                {/* Titre / Title */}
                <div style={{ textAlign: 'center', marginBottom: '10px', borderBottom: '2px solid #000', paddingBottom: '6px' }}>
                  <div style={{ fontSize: '16px', fontWeight: 'bold', letterSpacing: '1px' }}>
                    {t('driverRoute.documentTitle')}
                  </div>
                  <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
                    {formatDate(data.delivery_date ?? data.date)} {data.departure_time ?? ''}
                  </div>
                </div>

                {/* Code-barre tour / Tour barcode */}
                {data.tour_code && (
                  <div style={{ textAlign: 'center', marginBottom: '8px', printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' } as React.CSSProperties}>
                    <svg ref={barcodeRef} />
                    <div style={{ fontSize: '11px', fontWeight: 'bold', letterSpacing: '1px' }}>{data.tour_code}</div>
                  </div>
                )}

                {/* Infos tour / Tour info */}
                <table style={{ ...tblStyle, marginBottom: '8px' }}>
                  <tbody>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.tourCode')}</td>
                      <td style={{ ...valCell, fontWeight: 'bold' }}>{data.tour_code}</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.deliveryDate')}</td>
                      <td style={valCell}>{formatDate(data.delivery_date ?? data.date)}</td>
                    </tr>
                    {data.dispatch_date && (
                      <tr>
                        <td style={labelCell}>Répart.</td>
                        <td style={valCell}>{formatDate(data.dispatch_date)}{data.dispatch_time ? ` ${data.dispatch_time}` : ''}</td>
                      </tr>
                    )}
                    <tr>
                      <td style={labelCell}>{t('driverRoute.driver')}</td>
                      <td style={{ ...valCell, fontWeight: 'bold' }}>{data.driver_name || ''}</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.transporter')}</td>
                      <td style={valCell}>{data.contract?.transporter_name ?? ''}</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>Contrat</td>
                      <td style={valCell}>{data.contract?.code ?? ''}</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.vehicle')}</td>
                      <td style={valCell}>{data.contract?.vehicle_name ?? data.contract?.vehicle_code ?? ''}</td>
                    </tr>
                    {data.dock_door_number && (
                      <tr>
                        <td style={labelCell}>Quai</td>
                        <td style={valCell}>{data.dock_door_number}</td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* Champs à remplir / Fields to fill in */}
                <table style={{ ...tblStyle, marginBottom: '8px' }}>
                  <tbody>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.departureBase')}</td>
                      <td style={{ ...valCell, minWidth: '80px' }}>___H___</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.returnBase')}</td>
                      <td style={valCell}>___H___</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.kmDeparture')}</td>
                      <td style={valCell}>___________</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.kmReturn')}</td>
                      <td style={valCell}>___________</td>
                    </tr>
                    <tr>
                      <td style={labelCell}>{t('driverRoute.kmTotal')}</td>
                      <td style={valCell}>___________</td>
                    </tr>
                  </tbody>
                </table>

                {/* Base info */}
                {data.base && (
                  <table style={{ ...tblStyle, marginBottom: '8px' }}>
                    <tbody>
                      <tr>
                        <td style={labelCell}>{t('driverRoute.base')}</td>
                        <td style={valCell}>{data.base.code} — {data.base.name}</td>
                      </tr>
                    </tbody>
                  </table>
                )}

                {/* Remarques / Remarks */}
                {data.remarks && (
                  <table style={{ ...tblStyle, marginBottom: '8px' }}>
                    <tbody>
                      <tr>
                        <td style={labelCell}>{t('driverRoute.remarks')}</td>
                        <td style={valCell}>{data.remarks}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* Styles inline / Inline styles */
const tblStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  border: '1px solid #000',
}

const thStyle: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: '10px',
  fontWeight: 600,
  textAlign: 'left',
  borderBottom: '1px solid #000',
  border: '1px solid #000',
  color: '#000',
}

const tdStyle: React.CSSProperties = {
  padding: '3px 6px',
  fontSize: '11px',
  border: '1px solid #000',
  color: '#000',
}

const labelCell: React.CSSProperties = {
  padding: '3px 6px',
  fontSize: '10px',
  fontWeight: 'bold',
  border: '1px solid #000',
  backgroundColor: '#eee',
  color: '#000',
  whiteSpace: 'nowrap',
}

const valCell: React.CSSProperties = {
  padding: '3px 6px',
  fontSize: '11px',
  border: '1px solid #000',
  color: '#000',
}
