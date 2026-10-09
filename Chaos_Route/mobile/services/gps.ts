/* Service GPS de tournee / Tour GPS tracking service.

   Le suivi appartient a la TOURNEE, pas a un ecran. Il demarre quand une
   tournee est prise en charge et ne s'arrete qu'a sa cloture reelle — pas
   quand le chauffeur revient a la liste des tournees, pas quand il va scanner
   des supports, pas quand Android recycle le contexte JS.

   Historique du bug : l'ecran de detail arretait le suivi a son demontage
   (`return () => stopGPSTracking()`). Un simple retour arriere figeait donc le
   marqueur du chauffeur sur la carte d'exploitation, et la journee se
   terminait avec une carte pleine de points immobiles. En prime, la file
   d'attente et l'identifiant de tournee vivaient uniquement en memoire : apres
   un redemarrage de l'app — ou dans le contexte headless de la tache de fond —
   `currentTourId` etait nul et les positions accumulees partaient a la
   poubelle sans un mot. /
   Tracking belongs to the tour, not to a screen: the detail screen used to
   stop it on unmount, and both the queue and the tour id lived in memory only.

   L'etat de suivi est donc persiste :
     - session (tournee + debut) dans SecureStore, minuscule ;
     - file d'attente des positions dans un fichier, car SecureStore n'est pas
       dimensionne pour quelques centaines de points.
*/

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import * as SecureStore from 'expo-secure-store'
import * as FileSystem from 'expo-file-system/legacy'
import api from './api'
import { GPS_DISTANCE_MIN_M, GPS_INTERVAL_MS, GPS_MAX_SESSION_MS } from '../constants/config'

const GPS_TASK_NAME = 'cmro-gps-tracking'
const SESSION_KEY = 'gps_session'
const QUEUE_FILE = `${FileSystem.documentDirectory}gps_queue.json`

/* Le serveur refuse les lots de plus de 100 positions (GPSBatchCreate). Sans
   decoupage, une file d'attente accumulee hors ligne partait en un seul POST
   et se faisait rejeter en 422 — puis rejeter a nouveau a chaque tentative. /
   The server caps a batch at 100 positions; send in chunks or an offline
   backlog is rejected forever. */
const BATCH_SIZE = 100

interface QueuedPosition {
  tourId: number
  latitude: number
  longitude: number
  accuracy: number | null
  speed: number | null
  timestamp: string
}

interface GPSSession {
  tourId: number
  startedAt: number
}

let pendingPositions: QueuedPosition[] = []
let queueLoaded = false
let session: GPSSession | null = null
let sessionLoaded = false
let foregroundInterval: ReturnType<typeof setInterval> | null = null

/* ─── Session persistee / Persisted session ─────────────────────────────── */

async function loadSession(): Promise<GPSSession | null> {
  if (sessionLoaded) return session
  sessionLoaded = true
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY)
    session = raw ? (JSON.parse(raw) as GPSSession) : null
  } catch {
    session = null
  }
  return session
}

async function saveSession(next: GPSSession): Promise<void> {
  session = next
  sessionLoaded = true
  try {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next))
  } catch (e) {
    console.warn('GPS session persist failed:', e)
  }
}

async function clearSession(): Promise<void> {
  session = null
  sessionLoaded = true
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY)
  } catch {
    // rien a faire : au pire la session sera consideree expiree
  }
}

/* Tournee suivie actuellement, ou null si aucune / expiree. */
async function activeTourId(): Promise<number | null> {
  const current = await loadSession()
  if (!current) return null
  if (Date.now() - current.startedAt > GPS_MAX_SESSION_MS) {
    console.warn('GPS session expired — stopping tracking')
    await stopGPSTracking()
    return null
  }
  return current.tourId
}

/* ─── File d'attente persistee / Persisted queue ────────────────────────── */

async function loadQueue(): Promise<void> {
  if (queueLoaded) return
  queueLoaded = true
  try {
    const info = await FileSystem.getInfoAsync(QUEUE_FILE)
    if (!info.exists) return
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(QUEUE_FILE))
    if (Array.isArray(parsed)) pendingPositions = parsed as QueuedPosition[]
  } catch {
    // Fichier absent ou corrompu : on repart d'une file vide plutot que de
    // bloquer le suivi. / Missing or corrupt file: start empty.
    pendingPositions = []
  }
}

async function persistQueue(): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(QUEUE_FILE, JSON.stringify(pendingPositions))
  } catch (e) {
    console.warn('GPS queue persist failed:', e)
  }
}

async function enqueue(position: QueuedPosition): Promise<void> {
  await loadQueue()
  pendingPositions.push(position)
  await persistQueue()
}

/* Vider la file vers le serveur, par lots, en conservant l'ordre.
   Chaque position porte sa tournee : une position en attente reste envoyable
   meme apres la cloture de la tournee qui l'a produite. / Each position
   carries its tour, so a backlog survives the tour that produced it. */
async function flushPositions(): Promise<void> {
  await loadQueue()
  if (pendingPositions.length === 0) return

  while (pendingPositions.length > 0) {
    const tourId = pendingPositions[0].tourId
    const batch: QueuedPosition[] = []
    for (const p of pendingPositions) {
      if (p.tourId !== tourId || batch.length >= BATCH_SIZE) break
      batch.push(p)
    }
    try {
      await api.post('/driver/gps', {
        tour_id: tourId,
        positions: batch.map(({ tourId: _omit, ...rest }) => rest),
      })
      pendingPositions = pendingPositions.slice(batch.length)
    } catch {
      // Reseau indisponible : on garde le reste pour le prochain passage.
      break
    }
  }
  await persistQueue()
}

/* ─── Capture / Capture ─────────────────────────────────────────────────── */

function toQueued(tourId: number, loc: Location.LocationObject): QueuedPosition {
  return {
    tourId,
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracy: loc.coords.accuracy,
    speed: loc.coords.speed,
    timestamp: new Date(loc.timestamp).toISOString(),
  }
}

// Tache de fond : survit a la fermeture de l'UI (service de premier plan
// Android). / Background task: survives the UI being closed.
TaskManager.defineTask(GPS_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('GPS task error:', error)
    return
  }
  if (!data) return
  const tourId = await activeTourId()
  if (!tourId) return
  const { locations } = data as { locations: Location.LocationObject[] }
  for (const loc of locations) {
    await enqueue(toQueued(tourId, loc))
  }
  await flushPositions()
})

/* Fallback foreground : polling toutes les 30 s quand la permission
   d'arriere-plan n'a pas ete accordee. / Foreground fallback. */
function startForegroundPolling() {
  if (foregroundInterval) return
  foregroundInterval = setInterval(async () => {
    const tourId = await activeTourId()
    if (!tourId) return
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
      await enqueue(toQueued(tourId, loc))
      await flushPositions()
    } catch (e) {
      console.warn('Foreground GPS poll failed:', e)
    }
  }, 30_000)
}

function stopForegroundPolling() {
  if (foregroundInterval) {
    clearInterval(foregroundInterval)
    foregroundInterval = null
  }
}

async function isTracking(): Promise<boolean> {
  if (foregroundInterval) return true
  try {
    return await TaskManager.isTaskRegisteredAsync(GPS_TASK_NAME)
  } catch {
    return false
  }
}

/* Signaler au serveur que la localisation est coupee / Report location is off.

   Une app ne peut pas empecher un chauffeur de refuser la permission — seul un
   MDM le peut. Elle peut en revanche le DIRE, ce qui transforme une
   disparition silencieuse en alerte nominative cote exploitation. /
   An app can't prevent denial, but it can report it. */
async function reportGPSUnavailable(tourId: number, status: 'denied' | 'unavailable', detail?: string) {
  try {
    await api.post('/driver/gps-status', { tour_id: tourId, status, detail })
  } catch (e) {
    // Hors ligne : le detecteur de silence cote serveur prendra le relais.
    console.warn('GPS status report failed:', e)
  }
}

/* ─── API publique / Public API ─────────────────────────────────────────── */

/* Demarrer le suivi d'une tournee. Idempotent : rappeler avec la meme tournee
   ne reinitialise ni la session ni la file d'attente, ce qui permet a chaque
   ecran de l'appeler sans precaution. / Idempotent: safe to call from any
   screen, repeatedly. */
export async function startGPSTracking(tourId: number): Promise<boolean> {
  const existing = await loadSession()
  // Heure de debut a conserver : uniquement celle d'une session portant sur la
  // MEME tournee. Reprendre celle d'une tournee precedente ferait expirer la
  // nouvelle avant l'heure. / Keep the start time only for the same tour.
  let startedAt = existing?.tourId === tourId ? existing.startedAt : undefined

  if (existing && existing.tourId !== tourId) {
    // Changement de tournee : on solde la precedente proprement.
    await stopGPSTracking()
    startedAt = undefined
  } else if (existing && (await isTracking())) {
    return true
  }

  const { status: fg } = await Location.requestForegroundPermissionsAsync()
  if (fg !== 'granted') {
    await reportGPSUnavailable(tourId, 'denied')
    return false
  }

  // Permission accordee mais localisation desactivee au niveau du systeme :
  // meme resultat pratique, cause differente. / Location services off at OS level.
  try {
    if (!(await Location.hasServicesEnabledAsync())) {
      await reportGPSUnavailable(tourId, 'unavailable', 'Localisation desactivee sur le telephone')
    }
  } catch {
    // hasServicesEnabledAsync indisponible : on n'en fait pas un echec
  }

  // Conserver l'heure de debut d'une session deja ouverte, sinon le garde-fou
  // de duree maximale serait repousse a chaque navigation. / Keep the original
  // start time, or the max-duration cap would never trigger.
  await saveSession({ tourId, startedAt: startedAt ?? Date.now() })

  // Position initiale immediate / Immediate initial fix
  try {
    const initial = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    await enqueue(toQueued(tourId, initial))
  } catch (e) {
    console.warn('Initial GPS position failed:', e)
  }
  await flushPositions()

  // Tenter le suivi en arriere-plan / Try background tracking
  try {
    const { status: bg } = await Location.requestBackgroundPermissionsAsync()
    if (bg === 'granted') {
      if (!(await TaskManager.isTaskRegisteredAsync(GPS_TASK_NAME))) {
        await Location.startLocationUpdatesAsync(GPS_TASK_NAME, {
          accuracy: Location.Accuracy.High,
          timeInterval: GPS_INTERVAL_MS,
          distanceInterval: GPS_DISTANCE_MIN_M,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Suivi de tournee en cours',
            notificationBody: 'CMRO suit votre position GPS',
            notificationColor: '#f97316',
          },
        })
      }
      return true
    }
  } catch (e) {
    console.warn('Background GPS not available, using foreground fallback:', e)
  }

  startForegroundPolling()
  return true
}

/* Reprendre un suivi interrompu par une fermeture de l'app.

   Appele au lancement : sans cela, tuer l'application suffisait a mettre fin
   au suivi d'une tournee pourtant toujours en cours. / Called at launch: an
   app kill used to silently end tracking for a tour still under way. */
export async function resumeGPSTrackingIfNeeded(): Promise<number | null> {
  const tourId = await activeTourId()   // coupe aussi si la session a expire
  if (!tourId) {
    // Une file d'attente peut survivre a la tournee qui l'a produite.
    await flushPositions()
    return null
  }

  await flushPositions()

  // La tournee a-t-elle ete cloturee pendant que l'app etait fermee ?
  try {
    const { data } = await api.get<{ status?: string }>(`/driver/tour/${tourId}`)
    if (data?.status === 'COMPLETED') {
      await stopGPSTracking()
      return null
    }
  } catch {
    // Hors ligne : on continue de suivre, le garde-fou de duree fera le reste.
  }

  if (!(await isTracking())) {
    await startGPSTracking(tourId)
  }
  return tourId
}

/* Arreter le suivi. A n'appeler qu'a la cloture reelle de la tournee (ou par
   le garde-fou de duree) — surtout pas au demontage d'un ecran. /
   Call only on actual tour closure, never on screen unmount. */
export async function stopGPSTracking(): Promise<void> {
  stopForegroundPolling()

  try {
    if (await TaskManager.isTaskRegisteredAsync(GPS_TASK_NAME)) {
      await Location.stopLocationUpdatesAsync(GPS_TASK_NAME)
    }
  } catch (e) {
    console.warn('Stop background GPS failed:', e)
  }

  await flushPositions()
  await clearSession()
}

/* Tournee actuellement suivie, pour affichage / Currently tracked tour, for UI. */
export async function getTrackedTourId(): Promise<number | null> {
  return activeTourId()
}
