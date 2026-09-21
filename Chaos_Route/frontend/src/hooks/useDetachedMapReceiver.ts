/* Hook BroadcastChannel côté popup / BroadcastChannel hook for popup window (receiver) */

import { useEffect, useRef, useState, useCallback } from 'react'
import type { PDV, PdvPickupSummary } from '../types'
import type { PdvVolumeStatus } from '../components/map/PdvMarker'

const CHANNEL_NAME = 'chaos-route-map'

/* Types de messages (mirroir du sender) / Message types (mirror of sender) */
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

export interface DetachedMapState {
  ready: boolean
  theme: 'dark' | 'light'
  regionId: number | null
  selectedPdvIds: Set<number>
  pdvVolumeStatusMap: Map<number, PdvVolumeStatus>
  pdvEqpMap: Map<number, Record<string, number>>
  routeCoords: [number, number][]
  pickupByPdv: Map<number, PdvPickupSummary>
}

export function useDetachedMapReceiver() {
  const [state, setState] = useState<DetachedMapState>({
    ready: false,
    theme: 'dark',
    regionId: null,
    selectedPdvIds: new Set(),
    pdvVolumeStatusMap: new Map(),
    pdvEqpMap: new Map(),
    routeCoords: [],
    pickupByPdv: new Map(),
  })

  const channelRef = useRef<BroadcastChannel | null>(null)

  /* Désérialise arrays → Set/Map / Deserialize arrays → Set/Map */
  const deserializeSync = useCallback((payload: MapStateSyncPayload) => ({
    selectedPdvIds: new Set(payload.selectedPdvIds),
    pdvVolumeStatusMap: new Map(payload.pdvVolumeStatusMap),
    pdvEqpMap: new Map(payload.pdvEqpMap),
    routeCoords: payload.routeCoords,
    pickupByPdv: new Map(payload.pickupByPdv),
  }), [])

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = channel

    channel.onmessage = (event: MessageEvent<MapMessage>) => {
      const msg = event.data
      if (msg.type === 'MAP_INIT') {
        setState({
          ready: true,
          theme: msg.payload.theme,
          regionId: msg.payload.regionId,
          ...deserializeSync(msg.payload),
        })
      } else if (msg.type === 'MAP_STATE_SYNC') {
        setState((prev) => ({
          ...prev,
          ...deserializeSync(msg.payload),
        }))
      }
    }

    /* Signaler que la popup est prête / Signal popup is ready */
    channel.postMessage({ type: 'MAP_READY' })

    /* Signaler la fermeture / Signal closing */
    const handleBeforeUnload = () => {
      channel.postMessage({ type: 'MAP_CLOSING' })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      channel.close()
      channelRef.current = null
    }
  }, [deserializeSync])

  /* Envoie un clic PDV vers la fenêtre principale / Send PDV click to main window */
  const sendPdvClick = useCallback((pdv: PDV) => {
    channelRef.current?.postMessage({ type: 'PDV_CLICK', payload: pdv })
  }, [])

  /* Envoie un clic température PDV vers la fenêtre principale / Send PDV temp click to main window */
  const sendPdvTempClick = useCallback((pdv: PDV, temp: string) => {
    channelRef.current?.postMessage({ type: 'PDV_TEMP_CLICK', payload: { pdv, temp } })
  }, [])

  /* Envoie un clic droit PDV vers la fenêtre principale / Send PDV context menu to main window */
  const sendPdvContextMenu = useCallback((pdv: PDV) => {
    channelRef.current?.postMessage({ type: 'PDV_CONTEXTMENU', payload: pdv })
  }, [])

  /* Demande l'enregistrement du brouillon à la fenêtre principale (#75).
     C'est elle qui détient le tour en cours : la carte ne fait que le demander. /
     Asks the main window to save the draft: it owns the tour being built. */
  const sendSaveDraft = useCallback(() => {
    channelRef.current?.postMessage({ type: 'SAVE_DRAFT' })
  }, [])

  return { ...state, sendPdvClick, sendPdvTempClick, sendPdvContextMenu, sendSaveDraft }
}
