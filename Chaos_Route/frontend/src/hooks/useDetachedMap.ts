/* Hook BroadcastChannel côté fenêtre principale / BroadcastChannel hook for main window (sender) */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { PDV, PdvPickupSummary } from '../types'
import type { PdvVolumeStatus } from '../components/map/PdvMarker'

const CHANNEL_NAME = 'chaos-route-map'

/* Types de messages / Message types */
type MapMessage =
  | { type: 'MAP_INIT'; payload: MapInitPayload }
  | { type: 'MAP_STATE_SYNC'; payload: MapStateSyncPayload }
  | { type: 'MAP_READY' }
  | { type: 'PDV_CLICK'; payload: PDV }
  | { type: 'PDV_TEMP_CLICK'; payload: { pdv: PDV; temp: string } }
  | { type: 'PDV_CONTEXTMENU'; payload: PDV }
  /* Enregistrer le brouillon depuis la carte détachée (#75) : sur le tableau de
     Villers, la carte occupe tout l'écran et revenir à l'autre fenêtre pour un
     simple clic casse le rythme. / Save the draft from the detached map. */
  | { type: 'SAVE_DRAFT' }
  | { type: 'MAP_CLOSING' }

interface MapInitPayload {
  theme: 'dark' | 'light'
  regionId: number | null
  selectedPdvIds: number[]
  pdvVolumeStatusMap: [number, PdvVolumeStatus][]
  pdvEqpMap: [number, Record<string, number>][]
  routeCoords: [number, number][]
  pickupByPdv: [number, PdvPickupSummary][]
}

interface MapStateSyncPayload {
  selectedPdvIds: number[]
  pdvVolumeStatusMap: [number, PdvVolumeStatus][]
  pdvEqpMap: [number, Record<string, number>][]
  routeCoords: [number, number][]
  pickupByPdv: [number, PdvPickupSummary][]
}

interface UseDetachedMapOptions {
  selectedPdvIds: Set<number>
  pdvVolumeStatusMap: Map<number, PdvVolumeStatus>
  pdvEqpMap: Map<number, Record<string, number>>
  routeCoords: [number, number][]
  pickupByPdv: Map<number, PdvPickupSummary>
  theme: 'dark' | 'light'
  regionId: number | null
  onPdvClick: (pdv: PDV) => void
  onPdvTempClick?: (pdv: PDV, temp: string) => void
  onPdvContextMenu?: (pdv: PDV) => void
  /* Enregistrement du brouillon demandé depuis la carte détachée (#75) */
  onSaveDraft?: () => void
}

export function useDetachedMap({
  selectedPdvIds,
  pdvVolumeStatusMap,
  pdvEqpMap,
  routeCoords,
  pickupByPdv,
  theme,
  regionId,
  onPdvClick,
  onPdvTempClick,
  onPdvContextMenu,
  onSaveDraft,
}: UseDetachedMapOptions) {
  const [isDetached, setIsDetached] = useState(false)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const popupRef = useRef<Window | null>(null)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /* Refs pour garder les valeurs fraîches sans recréer le canal / Refs to keep fresh values without recreating channel */
  const onPdvClickRef = useRef(onPdvClick)
  onPdvClickRef.current = onPdvClick
  const onPdvTempClickRef = useRef(onPdvTempClick)
  onPdvTempClickRef.current = onPdvTempClick
  const onPdvContextMenuRef = useRef(onPdvContextMenu)
  onPdvContextMenuRef.current = onPdvContextMenu
  const onSaveDraftRef = useRef(onSaveDraft)
  useEffect(() => { onSaveDraftRef.current = onSaveDraft }, [onSaveDraft])
  const themeRef = useRef(theme)
  themeRef.current = theme
  const regionIdRef = useRef(regionId)
  regionIdRef.current = regionId

  /* Sérialisation Set/Map → arrays / Serialize Set/Map to arrays */
  const serializeState = useCallback((): MapStateSyncPayload => ({
    selectedPdvIds: Array.from(selectedPdvIds),
    pdvVolumeStatusMap: Array.from(pdvVolumeStatusMap.entries()),
    pdvEqpMap: Array.from(pdvEqpMap.entries()),
    routeCoords,
    pickupByPdv: Array.from(pickupByPdv.entries()),
  }), [selectedPdvIds, pdvVolumeStatusMap, pdvEqpMap, routeCoords, pickupByPdv])

  const serializeRef = useRef(serializeState)
  serializeRef.current = serializeState

  /* Initialisation canal + listeners (une seule fois quand isDetached passe à true) / Init channel + listeners */
  useEffect(() => {
    if (!isDetached) return

    const channel = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = channel

    channel.onmessage = (event: MessageEvent<MapMessage>) => {
      const msg = event.data
      if (msg.type === 'MAP_READY') {
        const initPayload: MapInitPayload = {
          theme: themeRef.current,
          regionId: regionIdRef.current,
          ...serializeRef.current(),
        }
        channel.postMessage({ type: 'MAP_INIT', payload: initPayload })
      } else if (msg.type === 'PDV_CLICK') {
        onPdvClickRef.current(msg.payload)
      } else if (msg.type === 'PDV_TEMP_CLICK') {
        onPdvTempClickRef.current?.(msg.payload.pdv, msg.payload.temp)
      } else if (msg.type === 'PDV_CONTEXTMENU') {
        onPdvContextMenuRef.current?.(msg.payload)
      } else if (msg.type === 'SAVE_DRAFT') {
        onSaveDraftRef.current?.()
      } else if (msg.type === 'MAP_CLOSING') {
        setIsDetached(false)
      }
    }

    /* Polling backup : détecte popup fermée / Backup polling: detect closed popup */
    pollingRef.current = setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        setIsDetached(false)
      }
    }, 1000)

    return () => {
      channel.close()
      channelRef.current = null
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [isDetached])

  /* Synchronise l'état vers la popup / Sync state to popup on changes */
  useEffect(() => {
    if (!isDetached || !channelRef.current) return
    channelRef.current.postMessage({
      type: 'MAP_STATE_SYNC',
      payload: serializeState(),
    } satisfies MapMessage)
  }, [isDetached, serializeState])

  /* Détacher : ouvrir popup / Detach: open popup */
  const detach = useCallback(() => {
    const w = screen.width
    const h = screen.height
    const popup = window.open(
      '/map-detached',
      'chaos-route-map',
      `width=${Math.round(w * 0.6)},height=${Math.round(h * 0.8)},left=0,top=0,menubar=no,toolbar=no,location=no,status=no`,
    )
    if (popup) {
      popupRef.current = popup
      setIsDetached(true)
    }
  }, [])

  /* Rattacher : fermer popup / Attach: close popup */
  const attach = useCallback(() => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close()
    }
    popupRef.current = null
    setIsDetached(false)
  }, [])

  /* Cleanup au unmount / Cleanup on unmount */
  useEffect(() => {
    return () => {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close()
      }
    }
  }, [])

  return { isDetached, detach, attach }
}
