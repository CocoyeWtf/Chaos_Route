/* Position fraiche disponible instantanement au moment d'un scan /
   Fresh position available instantly at scan time.

   Pourquoi un watcher plutot qu'un appel par scan : un scan doit rester
   instantane. `getCurrentPositionAsync` prend 1 a 10 s au premier fix — le
   chauffeur aurait deja scanne trois supports. Et `getLastKnownPositionAsync`
   seul rend un point potentiellement vieux de plusieurs heures, pris a des
   kilometres de la : pire qu'une absence de position, parce qu'on y croit.
   On abonne donc l'ecran au GPS pendant toute la session de scan et chaque
   scan lit en memoire le dernier point, avec son age. /
   A watcher keeps a fresh fix in memory so each scan reads it with zero
   latency, and a stale fix is dropped rather than trusted. */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Location from 'expo-location'

/* Au-dela, le point ne dit plus ou on a scanne / Beyond this, a fix no longer
   says where the scan happened. */
const MAX_FIX_AGE_MS = 120_000  // 2 minutes

export interface ScanFix {
  latitude: number
  longitude: number
  accuracy: number | null
}

export type ScanLocationStatus = 'starting' | 'ok' | 'denied' | 'unavailable'

export function useScanLocation() {
  const fixRef = useRef<{ fix: ScanFix; at: number } | null>(null)
  const [status, setStatus] = useState<ScanLocationStatus>('starting')

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null
    let cancelled = false

    ;(async () => {
      try {
        const { status: perm } = await Location.requestForegroundPermissionsAsync()
        if (cancelled) return
        if (perm !== 'granted') {
          setStatus('denied')
          return
        }

        // Amorcage : le dernier point connu evite de partir aveugle le temps
        // que le premier fix arrive. / Prime with the last known fix.
        try {
          const last = await Location.getLastKnownPositionAsync({ maxAge: MAX_FIX_AGE_MS })
          if (last && !cancelled) {
            fixRef.current = {
              fix: {
                latitude: last.coords.latitude,
                longitude: last.coords.longitude,
                accuracy: last.coords.accuracy,
              },
              at: last.timestamp,
            }
            setStatus('ok')
          }
        } catch {
          // Pas de dernier point : le watcher prendra le relais
        }

        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 5_000, distanceInterval: 5 },
          (loc) => {
            fixRef.current = {
              fix: {
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                accuracy: loc.coords.accuracy,
              },
              at: loc.timestamp,
            }
            setStatus('ok')
          },
        )
      } catch (e) {
        console.warn('Scan location watcher failed:', e)
        if (!cancelled) setStatus('unavailable')
      }
    })()

    return () => {
      cancelled = true
      sub?.remove()
    }
  }, [])

  /* Point courant, ou null s'il est trop vieux pour etre honnete /
     Current fix, or null when too stale to be honest. */
  const getFix = useCallback((): ScanFix | null => {
    const current = fixRef.current
    if (!current) return null
    if (Date.now() - current.at > MAX_FIX_AGE_MS) return null
    return current.fix
  }, [])

  return { getFix, status }
}
