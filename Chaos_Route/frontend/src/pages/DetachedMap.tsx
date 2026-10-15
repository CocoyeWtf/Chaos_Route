/* Page popup carte détachée / Detached map popup page */

import { useEffect } from 'react'
import { useDetachedMapReceiver } from '../hooks/useDetachedMapReceiver'
import { useAppStore } from '../stores/useAppStore'
import { MapView } from '../components/map/MapView'
import { FILL_COLORS, FILL_LABELS, fillLevel } from '../types'

export default function DetachedMap() {
  const { ready, theme, regionId, selectedPdvIds, pdvVolumeStatusMap, pdvEqpMap, routeCoords, pickupByPdv, tourState, sendPdvClick, sendPdvTempClick, sendPdvContextMenu, sendSaveDraft, sendVehicleType } =
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
      {/* Barre du tour en cours (#75). Gaetan : « lorsque nous poussons sur le
          bouton, cela valide le tour mais nous devons à nouveau changer de
          fenêtre pour choisir le moyen de transport. Le bouton n'a donc plus
          d'intérêt. » Le choix du gabarit et le coefficient de remplissage sont
          donc posés ici, à côté du bouton d'enregistrement. */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 px-3 py-2 rounded-xl shadow-lg"
        style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', zIndex: 1100 }}>
        {tourState && (
          <>
            <select
              value={tourState.vehicleType ?? ''}
              onChange={(e) => e.target.value && sendVehicleType(e.target.value)}
              className="px-2 py-1.5 rounded-lg border text-sm font-semibold"
              style={{
                backgroundColor: 'var(--bg-primary)',
                borderColor: 'var(--border-color)',
                color: tourState.vehicleType ? 'var(--color-primary)' : 'var(--text-muted)',
              }}
              title="Moyen de transport du tour en cours"
            >
              {!tourState.vehicleType && <option value="">Moyen de transport…</option>}
              {tourState.options.map((o) => {
                const refus = tourState.blocked.find(([vt]) => vt === o.value)?.[1]
                return (
                  <option key={o.value} value={o.value} disabled={!!refus} title={refus}>
                    {o.label} ({o.value === tourState.vehicleType ? tourState.capacityEqp : o.capacity} EQC)
                    {refus ? ' — refusé par un PDV du tour' : ''}
                  </option>
                )
              })}
            </select>

            {/* Coefficient de remplissage, barème de Gaetan (#75) */}
            {tourState.capacityEqp > 0 && tourState.stopsCount > 0 && (() => {
              const pct = Math.round((tourState.totalEqp / tourState.capacityEqp) * 100)
              const niveau = fillLevel(pct)
              return (
                <span className="px-2 py-1 rounded-lg text-sm font-bold" title={FILL_LABELS[niveau]}
                  style={{ backgroundColor: `${FILL_COLORS[niveau]}22`, color: FILL_COLORS[niveau] }}>
                  {pct} %
                </span>
              )
            })()}
          </>
        )}

        <button
          onClick={sendSaveDraft}
          className="px-4 py-2 rounded-lg text-sm font-semibold text-white"
          style={{ backgroundColor: 'var(--color-primary)' }}
          title="Enregistrer le brouillon du tour en cours"
        >
          Enregistrer le brouillon
        </button>
      </div>
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
