/* Service impression Bluetooth Classic / Bluetooth Classic print service.

   Wrapper sur react-native-bluetooth-classic (dependance declaree dans
   package.json). Imprimantes thermiques portables parlant Bluetooth Classic SPP
   (pas BLE) : Zebra (ZQ320/521), TSC (Alpha-30R), Brother RJ-4 en emulation ZPL/TSPL.

   L'impression reelle necessite un EAS build (le module natif n'est pas bundle
   dans Expo Go). L'import du module est fait de maniere dynamique (lazy) : un
   garde-fou pour que l'app ne crashe pas dans un environnement ou le module natif
   est absent (Expo Go / preview) — printRaw renvoie alors une erreur explicite.

   Wrapper for react-native-bluetooth-classic (declared dependency in package.json).
   Portable thermal printers speaking Bluetooth Classic SPP (not BLE): Zebra
   (ZQ320/521), TSC (Alpha-30R), Brother RJ-4 in ZPL/TSPL emulation.

   Real printing requires an EAS build (the native module is not bundled in Expo
   Go). The module is imported dynamically (lazy) as a safety net so the app does
   not crash where the native module is absent (Expo Go / preview) — printRaw then
   returns an explicit error.
*/

import { Platform, PermissionsAndroid } from 'react-native'

/** Imprimante Bluetooth detectee / Detected Bluetooth printer */
export interface BluetoothPrinter {
  address: string
  name: string
  bonded: boolean
}

/** Resultat d'une operation d'impression / Print operation result */
export interface PrintResult {
  success: boolean
  error?: string
}

/** Module Bluetooth runtime — null si non installe / Runtime Bluetooth module — null if not installed */
let _module: any = null
let _loadAttempted = false

function _loadModule(): any {
  if (_loadAttempted) return _module
  _loadAttempted = true
  try {
    // Import dynamique pour eviter de casser le bundling si le module n'est pas la /
    // Dynamic import so bundling doesn't break when the module is absent
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-bluetooth-classic')
    _module = mod?.default ?? mod
  } catch {
    _module = null
  }
  return _module
}

/** Le module Bluetooth natif est-il disponible ? / Is the native Bluetooth module available? */
export function isBluetoothModuleAvailable(): boolean {
  return _loadModule() !== null
}

/** Demander les permissions Bluetooth Android 12+ / Request Android 12+ Bluetooth permissions.
 *
 * Sur Android 11 et avant : BLUETOOTH/BLUETOOTH_ADMIN suffisent et sont declarees dans le
 * manifest, pas besoin d'autorisation runtime.
 * Sur Android 12+ : BLUETOOTH_CONNECT et BLUETOOTH_SCAN doivent etre acceptees par l'user.
 */
export async function requestBluetoothPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0
  if (apiLevel < 31) return true
  try {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    ])
    return Object.values(result).every((v) => v === PermissionsAndroid.RESULTS.GRANTED)
  } catch {
    return false
  }
}

/** Lister les imprimantes Bluetooth appairees / List paired Bluetooth printers.
 *
 * Filtre uniquement les devices reconnus comme imprimantes (heuristique sur le nom).
 * Les utilisateurs doivent appairer leur imprimante via les parametres systeme
 * Android avant que l'app la voie ici.
 */
export async function listPairedPrinters(): Promise<BluetoothPrinter[]> {
  const mod = _loadModule()
  if (!mod) {
    throw new Error(
      'Module Bluetooth non installe. Faites un EAS build avec react-native-bluetooth-classic.',
    )
  }
  const enabled = await mod.isBluetoothEnabled()
  if (!enabled) {
    throw new Error('Bluetooth desactive. Activez-le dans les parametres Android.')
  }
  const devices = await mod.getBondedDevices()
  return (devices || []).map((d: any) => ({
    address: d.address,
    name: d.name || d.address,
    bonded: true,
  }))
}

/* ── Connexion reutilisee / Reused connection ─────────────────────────────

   Ticket #86 : « l'impression ne fonctionne que sur le premier encodage ».

   L'implementation precedente etait « connect, write, disconnect » a chaque
   etiquette. En RFCOMM, c'est precisement le scenario qui casse : le socket
   referme n'est pas encore liberee cote pile Bluetooth Android quand la
   connexion suivante est demandee, et la tentative part en
   `java.io.IOException: read failed, socket might closed or timeout,
   read ret: -1` — l'erreur relevee en production sur la Brother RJ-4250WB du
   PDV 01717. Pire : `write()` qui resout ne prouve rien, les octets ne sont que
   remis au socket ; en refermant aussitot, l'etiquette pouvait etre tronquee ou
   jamais imprimee alors que l'app annoncait un succes.

   Donc : une connexion par imprimante, gardee ouverte entre deux etiquettes,
   un temps de drain apres chaque envoi, et une seule reprise automatique quand
   le socket est trouve mort. La deconnexion devient explicite (changement
   d'imprimante, test, mise en veille) au lieu d'etre systematique. /
   Keep one connection per printer instead of reopening it per label — the
   reopen is exactly what fails on Android RFCOMM. */

/** Laisser le temps aux octets de partir avant toute fermeture / Let the bytes
 *  reach the printer before anything closes the socket. */
const DRAIN_MS = 400
/** Pause avant la reprise : en dessous, la pile Bluetooth n'a pas encore
 *  libere le socket et la reconnexion echoue pour la meme raison. */
const RETRY_DELAY_MS = 900

let _open: { address: string; device: any } | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fermer la connexion courante, sans bruit / Close the current connection. */
export async function disconnectPrinter(): Promise<void> {
  const mod = _loadModule()
  const current = _open
  _open = null
  if (!mod || !current) return
  try {
    if (current.device?.disconnect) await current.device.disconnect()
    else if (mod.disconnectFromDevice) await mod.disconnectFromDevice(current.address)
  } catch {
    // Deconnexion best-effort : l'imprimante a pu s'eteindre d'elle-meme.
  }
}

/** Obtenir une connexion utilisable vers cette imprimante / Get a usable link. */
async function _acquire(mod: any, address: string): Promise<any> {
  if (_open && _open.address === address) {
    try {
      // `isConnected` interroge la pile, pas notre memoire : c'est ce qui
      // distingue un socket encore vivant d'un souvenir. / Ask the stack.
      if (await _open.device.isConnected()) return _open.device
    } catch {
      // Socket mort : on repart d'une connexion neuve.
    }
    await disconnectPrinter()
  } else if (_open) {
    // Changement d'imprimante : liberer l'ancienne avant d'ouvrir l'autre.
    await disconnectPrinter()
  }
  const device = await mod.connectToDevice(address, { CONNECTOR_TYPE: 'rfcomm' })
  _open = { address, device }
  return device
}

/** Envoyer un payload RAW a l'imprimante / Send a RAW payload to the printer.
 *
 * La connexion est ouverte au besoin puis CONSERVEE pour les etiquettes
 * suivantes. Une seule reprise en cas de socket mort : au-dela, c'est
 * l'imprimante qui est eteinte, hors de portee ou occupee, et insister ne
 * ferait que retarder le message d'erreur. /
 * Opens the link if needed and keeps it; retries once on a dead socket.
 */
export async function printRaw(address: string, payload: string): Promise<PrintResult> {
  const mod = _loadModule()
  if (!mod) {
    return {
      success: false,
      error: 'Module Bluetooth non installe (EAS build requis).',
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const device = await _acquire(mod, address)
      // ZPL/TSPL doivent etre envoyes en ASCII brut, sans encodage UTF-8 multibyte /
      // ZPL/TSPL must be sent as raw ASCII, not multibyte UTF-8
      await device.write(payload)
      // Le drain n'est pas de la superstition : sans lui, une fermeture ou un
      // envoi immediat peut tronquer l'etiquette en cours. / Not superstition.
      await sleep(DRAIN_MS)
      return { success: true }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // La connexion gardee est suspecte des qu'un envoi echoue : on la jette.
      await disconnectPrinter()
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return {
        success: false,
        error: msg + ' — verifiez que l\'imprimante est allumee, a portee et pas '
          + 'connectee a un autre appareil.',
      }
    }
  }
  // Inatteignable : la boucle sort toujours par un return. / Unreachable.
  return { success: false, error: 'Impression impossible' }
}

/** ZPL minimal de test (etiquette "TEST") / Minimal ZPL test label. */
export const TEST_ZPL =
  '^XA^PW576^LL400^CI28^FO50,50^A0N,60,60^FDTEST^FS' +
  '^FO50,140^A0N,30,30^FDImprimante Bluetooth^FS' +
  '^FO50,200^A0N,28,28^FDChaos Route^FS' +
  '^FO50,260^BY3,3,100^BCN,100,Y,N,N^FDTEST-12345^FS' +
  '^XZ'

/** TSPL minimal de test / Minimal TSPL test label. */
export const TEST_TSPL =
  'SIZE 72 mm, 50 mm\r\nGAP 2 mm, 0 mm\r\nDIRECTION 1\r\nCLS\r\n' +
  'TEXT 50,50,"5",0,1,1,"TEST"\r\n' +
  'TEXT 50,140,"3",0,1,1,"Imprimante Bluetooth"\r\n' +
  'TEXT 50,200,"3",0,1,1,"Chaos Route"\r\n' +
  'BARCODE 50,260,"128",100,1,0,3,3,"TEST-12345"\r\n' +
  'PRINT 1\r\n'
