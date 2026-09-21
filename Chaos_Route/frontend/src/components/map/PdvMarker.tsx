/* Marqueur PDV sur la carte — taille adaptative au zoom / PDV marker on map — zoom-adaptive size */

import { useMemo } from 'react'
import { Marker, Tooltip, Popup } from 'react-leaflet'
import L from 'leaflet'
import type { PDV, PdvPickupSummary, TemperatureClass } from '../../types'
import { TEMPERATURE_COLORS } from '../../types'

/* Statut volume du PDV / PDV volume status */
/* « raq » = le point de vente a de la marchandise restée à quai, non encore
   replanifiée (#68). C'est un cas particulier de « unassigned » : le volume est
   disponible, mais il vient d'une tournée où il n'est pas parti — l'AT doit le
   voir au premier coup d'œil pour le replacer en priorité. /
   "raq" is a special case of "unassigned": available, but left over from a tour. */
export type PdvVolumeStatus = 'none' | 'unassigned' | 'raq' | 'assigned'

/* Labels courts par type de reprise / Short labels per pickup type */
const PICKUP_TYPE_SHORT: Record<string, string> = {
  CONTAINER: 'Contenants',
  CARDBOARD: 'Cartons',
  MERCHANDISE: 'Marchandise',
  CONSIGNMENT: 'Consignes',
}

/* Ordre d'affichage des classes de température / Temperature class display order */
const TEMP_ORDER: TemperatureClass[] = ['FRAIS', 'GEL', 'SEC']

/* Facteur d'échelle selon le zoom / Scale factor based on zoom level */
function zoomScale(zoom: number): number {
  return Math.max(1, 1 + (zoom - 10) * 0.12)
}

/* Cache global d'icônes pastille / Global dot icon cache */
const iconCache = new Map<string, L.DivIcon>()

function makeIcon(color: string, size: number, borderWidth: number, hasPickup: boolean = false): L.DivIcon {
  const key = `${color}-${size}-${borderWidth}-${hasPickup}`
  const cached = iconCache.get(key)
  if (cached) return cached

  const bw = Math.round(borderWidth)
  const badgeSize = Math.round(size * 0.4)
  const badge = hasPickup
    ? `<div style="position:absolute;top:-3px;right:-3px;background:#f59e0b;width:${badgeSize}px;height:${badgeSize}px;border-radius:50%;border:1.5px solid #fff"></div>`
    : ''

  const icon = L.divIcon({
    className: '',
    html: `<div style="position:relative;display:inline-block"><div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:${bw}px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>${badge}</div>`,
    iconSize: [size + (hasPickup ? 4 : 0), size + (hasPickup ? 4 : 0)],
    iconAnchor: [(size + (hasPickup ? 4 : 0)) / 2, (size + (hasPickup ? 4 : 0)) / 2],
  })

  iconCache.set(key, icon)
  return icon
}

/* Cache d'icônes label / Label icon cache */
const labelIconCache = new Map<string, L.DivIcon>()

function makeLabelIcon(color: string, code: string, eqp: number, hasPickup: boolean = false, scale: number = 1): L.DivIcon {
  const key = `label-${color}-${code}-${eqp}-${hasPickup}-${scale.toFixed(2)}`
  const cached = labelIconCache.get(key)
  if (cached) return cached

  const fontSize1 = Math.round(10 * scale)
  const fontSize2 = Math.round(9 * scale)
  const padV = Math.round(2 * scale)
  const padH = Math.round(5 * scale)
  const badgeSize = Math.round(8 * scale)
  const badge = hasPickup
    ? `<div style="position:absolute;top:-4px;right:-4px;background:#f59e0b;width:${badgeSize}px;height:${badgeSize}px;border-radius:50%;border:1.5px solid #fff"></div>`
    : ''

  const icon = L.divIcon({
    className: '',
    html: `<div style="position:relative;transform:translate(-50%,-50%);display:inline-block;">
      <div style="background:${color};color:#fff;padding:${padV}px ${padH}px;border-radius:4px;font-family:system-ui,sans-serif;text-align:center;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.5);line-height:1.2;border:1.5px solid rgba(255,255,255,.6);">
        <div style="font-size:${fontSize1}px;font-weight:700;">${code}</div>
        <div style="font-size:${fontSize2}px;opacity:.9;">${eqp} eqc</div>
      </div>${badge}
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

  labelIconCache.set(key, icon)
  return icon
}

/* Label multi-température : en-tête PDV + carrés colorés par classe / Multi-temp label: PDV header + colored squares per class */
function makeMultiTempLabelIcon(
  code: string,
  eqpByTemp: Record<string, number>,
  hasPickup: boolean = false,
  scale: number = 1,
): L.DivIcon {
  const entries = TEMP_ORDER
    .filter((tc) => eqpByTemp[tc] != null && eqpByTemp[tc] > 0)
    .map((tc) => ({ tc, count: eqpByTemp[tc] }))

  const tempKey = entries.map((e) => `${e.tc}:${e.count}`).join(',')
  const key = `mlabel-${code}-${tempKey}-${hasPickup}-${scale.toFixed(2)}`
  const cached = labelIconCache.get(key)
  if (cached) return cached

  const fontSize1 = Math.round(10 * scale)
  const fontSize2 = Math.round(10 * scale)
  const padV = Math.round(2 * scale)
  const padH = Math.round(5 * scale)
  const badgeSize = Math.round(8 * scale)
  const badge = hasPickup
    ? `<div style="position:absolute;top:-4px;right:-4px;background:#f59e0b;width:${badgeSize}px;height:${badgeSize}px;border-radius:50%;border:1.5px solid #fff"></div>`
    : ''

  const squaresHtml = entries
    .map(
      (e) =>
        `<div data-temp="${e.tc}" style="flex:1;background:${TEMPERATURE_COLORS[e.tc as TemperatureClass]};color:#fff;font-size:${fontSize2}px;font-weight:700;text-align:center;padding:${padV}px ${padH}px;cursor:pointer;">${e.count}</div>`,
    )
    .join('')

  const icon = L.divIcon({
    className: '',
    html: `<div style="position:relative;transform:translate(-50%,-50%);display:inline-block;">
      <div style="border-radius:4px;font-family:system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.5);overflow:hidden;border:1.5px solid rgba(255,255,255,.6);">
        <div style="background:#374151;color:#fff;padding:${padV}px ${padH}px;text-align:center;font-size:${fontSize1}px;font-weight:700;line-height:1.2;">${code}</div>
        <div style="display:flex;">${squaresHtml}</div>
      </div>${badge}
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

  labelIconCache.set(key, icon)
  return icon
}

interface PdvMarkerProps {
  pdv: PDV
  onClick?: (pdv: PDV) => void
  onTempClick?: (pdv: PDV, temp: string) => void
  onContextMenu?: (pdv: PDV) => void
  selected?: boolean
  volumeStatus?: PdvVolumeStatus
  pickupSummary?: PdvPickupSummary
  showLabel?: boolean
  eqpByTemp?: Record<string, number>
  zoomLevel?: number
}

export function PdvMarker({ pdv, onClick, onTempClick, onContextMenu, selected, volumeStatus = 'none', pickupSummary, showLabel, eqpByTemp, zoomLevel = 10 }: PdvMarkerProps) {
  const eqpCount = eqpByTemp ? Object.values(eqpByTemp).reduce((a, b) => a + b, 0) : undefined
  if (!pdv.latitude || !pdv.longitude) return null

  const hasPickup = !!(pickupSummary && pickupSummary.pending_count > 0)

  /* Couleur label selon température unique / Label color based on single temperature */
  const tempKeys = eqpByTemp ? Object.keys(eqpByTemp) as TemperatureClass[] : []
  const labelColor = selected
    ? '#f97316'
    : tempKeys.length === 1
      ? TEMPERATURE_COLORS[tempKeys[0]]
      : volumeStatus === 'raq' ? '#eab308'
        : volumeStatus === 'unassigned' ? '#ef4444' : '#22c55e'

  /* Clé stable pour le breakdown multi-temp / Stable key for multi-temp breakdown */
  const tempBreakdownKey = eqpByTemp
    ? TEMP_ORDER.filter((tc) => eqpByTemp[tc]).map((tc) => `${tc}:${eqpByTemp[tc]}`).join(',')
    : ''

  const icon = useMemo(() => {
    const s = zoomScale(zoomLevel)
    /* Mode label / Label mode */
    const aPlanifier = volumeStatus === 'unassigned' || volumeStatus === 'raq'
    if (showLabel && eqpCount != null && eqpCount > 0 && aPlanifier) {
      /* Multi-température : en-tête PDV + carrés colorés / Multi-temp: PDV header + colored squares */
      if (tempKeys.length > 1 && eqpByTemp) {
        return makeMultiTempLabelIcon(pdv.code, eqpByTemp, hasPickup, s)
      }
      /* Mono-température : pill colorée / Single temp: colored pill */
      return makeLabelIcon(labelColor, pdv.code, eqpCount, hasPickup, s)
    }
    /* Mode pastille classique — taille scalée / Classic dot mode — scaled size */
    if (selected) return makeIcon('#f97316', Math.round(24 * s), Math.round(3 * s), hasPickup)
    if (volumeStatus === 'raq') return makeIcon('#eab308', Math.round(18 * s), Math.round(2 * s), hasPickup)
    if (volumeStatus === 'unassigned') return makeIcon('#ef4444', Math.round(18 * s), Math.round(2 * s), hasPickup)
    if (volumeStatus === 'assigned') return makeIcon('#22c55e', Math.round(18 * s), Math.round(2 * s), hasPickup)
    return makeIcon('#9ca3af', Math.round(14 * s), Math.round(2 * s), hasPickup)
  }, [selected, volumeStatus, hasPickup, showLabel, eqpCount, pdv.code, zoomLevel, labelColor, tempBreakdownKey])

  return (
    <Marker
      position={[pdv.latitude, pdv.longitude]}
      icon={icon}
      eventHandlers={{
        ...(onClick ? { click: (e: L.LeafletMouseEvent) => {
          /* Clic sur carré température → ajouter uniquement cette température /
             Click on temp square → add only that temperature */
          const target = e.originalEvent.target as HTMLElement
          const temp = target?.getAttribute?.('data-temp')
          if (temp && onTempClick) {
            onTempClick(pdv, temp)
          } else {
            onClick(pdv)
          }
        } } : {}),
        ...(onContextMenu ? { contextmenu: (e: L.LeafletMouseEvent) => { e.originalEvent.preventDefault(); onContextMenu(pdv) } } : {}),
      }}
    >
      <Tooltip>
        <div style={{ fontSize: '12px' }}>
          <strong>{pdv.code}</strong> — {pdv.name}<br />
          {pdv.city && <span>{pdv.city}<br /></span>}
          <span style={{ color: '#888' }}>{pdv.type}</span>
          {pdv.has_sas_sec && <span> | SAS Sec: {pdv.sas_sec_capacity_eqc ?? '—'} EQC</span>}
          {pdv.has_sas_frais && <span> | SAS Frais: {pdv.sas_frais_capacity_eqc ?? '—'} EQC</span>}
          {pdv.has_sas_gel && <span> | SAS Gel: {pdv.sas_gel_capacity_eqc ?? '—'} EQC</span>}
          {eqpByTemp && Object.keys(eqpByTemp).length > 0 && (
            <div style={{ marginTop: 2 }}>
              {(['FRAIS', 'GEL', 'SEC'] as TemperatureClass[])
                .filter((tc) => eqpByTemp[tc])
                .map((tc) => (
                  <div key={tc} style={{ fontWeight: 600, color: TEMPERATURE_COLORS[tc] }}>
                    {eqpByTemp[tc]} EQC {tc === 'FRAIS' ? 'Frais' : tc === 'GEL' ? 'Gel' : 'Sec'}
                  </div>
                ))}
            </div>
          )}
          {hasPickup && (
            <div style={{ marginTop: 4, color: '#f59e0b', fontWeight: 600 }}>
              Reprises: {pickupSummary!.requests.map(r => PICKUP_TYPE_SHORT[r.pickup_type]).filter(Boolean).join(', ')}
              {' '}({pickupSummary!.pending_count} étiq.)
            </div>
          )}
        </div>
      </Tooltip>
      {hasPickup && (
        <Popup>
          <div style={{ fontSize: 12, minWidth: 180 }}>
            <strong>{pdv.code}</strong> — {pdv.name}
            <div style={{ margin: '6px 0', borderTop: '1px solid #ddd' }} />
            <div style={{ fontWeight: 600, color: '#f59e0b', marginBottom: 4 }}>
              Reprises en attente ({pickupSummary!.pending_count} étiq.)
            </div>
            {Object.entries(
              pickupSummary!.requests.reduce((acc, r) => {
                acc[r.pickup_type] = (acc[r.pickup_type] || 0) + r.quantity
                return acc
              }, {} as Record<string, number>)
            ).map(([type, qty]) => (
              <div key={type}>{PICKUP_TYPE_SHORT[type] || type}: {qty}</div>
            ))}
            {onClick && (
              <button
                onClick={(e) => { e.stopPropagation(); onClick(pdv) }}
                style={{
                  marginTop: 8,
                  width: '100%',
                  padding: '4px 8px',
                  backgroundColor: '#f97316',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                + Ajouter au tour
              </button>
            )}
          </div>
        </Popup>
      )}
    </Marker>
  )
}
