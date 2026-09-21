/* Page popup carte détachée / Detached map popup page */

import { useEffect } from 'react'
import { useDetachedMapReceiver } from '../hooks/useDetachedMapReceiver'
import { useAppStore } from '../stores/useAppStore'
import { MapView } from '../components/map/MapView'

export default function DetachedMap() {
  const { ready, theme, regionId, selectedPdvIds, pdvVolumeStatusMap, pdvEqpMap, routeCoords, pickupByPdv, sendPdvClick, sendPdvTempClick, sendPdvContextMenu, sendSaveDraft } =
    useDetachedMapReceiver()

  const { setSelectedRegion } = useAppStore()

  /* Appliquer le thème reçu / Apply received theme */
  useEffect(() => {
    if (!ready) return
    document.documentElement.classList.toggle('light', theme === 'light')
    document.title = 'Chaos Route — Carte'
  }, [ready, theme])

  /* Synchroniser la région pour les appels API de MapView / Sync region for MapView API calls */
  useEffect(() => {
    if (!ready || regionId === null) return
    setSelectedRegion(regionId)
  }, [ready, regionId, setSelectedRegion])

  if (!ready) {
    return (
      <div
        className="flex items-center justify-center h-screen"
        style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-muted)' }}
      >
        <div className="text-center space-y-2">
          <div className="text-lg font-semibold">Connexion...</div>
          <div className="text-sm">En attente de la fenêtre principale</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Enregistrer le brouillon sans quitter la carte (#75). Le bouton est
          posé au-dessus de la carte, en bas à droite pour ne pas masquer la
          légende, et l'enregistrement est exécuté par la fenêtre principale,
          seule à connaître le tour en cours. /
          Save the draft without leaving the map: the main window does the work. */}
      <button
        onClick={sendSaveDraft}
        className="absolute bottom-4 right-4 px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-lg"
        style={{ backgroundColor: 'var(--color-primary)', zIndex: 1100 }}
        title="Enregistrer le brouillon du tour en cours"
      >
        Enregistrer le brouillon
      </button>
      <MapView
        onPdvClick={sendPdvClick}
        onPdvTempClick={sendPdvTempClick}
        onPdvContextMenu={sendPdvContextMenu}
        selectedPdvIds={selectedPdvIds}
        pdvVolumeStatusMap={pdvVolumeStatusMap}
        pdvEqpMap={pdvEqpMap}
        pickupByPdv={pickupByPdv}
        routeCoords={routeCoords}
        height="100%"
      />
    </div>
  )
}
