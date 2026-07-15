/* Service de mise a jour automatique / Auto-update service
 *
 * Utilise expo-application pour lire la version native (jamais undefined).
 * Compare par build_number (entier) — ne declenche que si le serveur a un numero SUPERIEUR.
 * Cela evite la boucle quand la version string ne correspond pas.
 */

// SDK 54 : l'API classique (cacheDirectory, downloadAsync…) est sous /legacy /
// SDK 54: the classic file API moved under /legacy
import * as FileSystem from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import * as Application from 'expo-application'
import { Platform } from 'react-native'
import { sha256 } from 'js-sha256'
import { API_BASE_URL } from '../constants/config'

/** Version native compilee — jamais undefined sur appareil */
const LOCAL_VERSION = Application.nativeApplicationVersion ?? '0.0.0'
const LOCAL_BUILD = Number(Application.nativeBuildVersion ?? '0')

interface VersionInfo {
  version: string
  build_number: number
  download_url: string | null
  sha256: string | null
  force_update: boolean
}

export function getLocalVersion(): string {
  return LOCAL_VERSION
}

export function getLocalBuild(): number {
  return LOCAL_BUILD
}

export async function checkForUpdate(): Promise<{
  updateAvailable: boolean
  versionInfo: VersionInfo | null
}> {
  if (Platform.OS !== 'android') return { updateAvailable: false, versionInfo: null }

  try {
    const baseUrl = API_BASE_URL.replace(/\/api\/?$/, '')
    const response = await fetch(`${baseUrl}/app/version`)
    if (!response.ok) return { updateAvailable: false, versionInfo: null }

    const info: VersionInfo = await response.json()

    // Comparer par build_number (entier) — uniquement si serveur > local
    const serverBuild = info.build_number ?? 0
    const needsUpdate = info.force_update && serverBuild > LOCAL_BUILD

    console.log(
      `[AutoUpdate] local=${LOCAL_VERSION} build=${LOCAL_BUILD} | server=${info.version} build=${serverBuild} | needsUpdate=${needsUpdate}`
    )

    if (needsUpdate && info.download_url) {
      return { updateAvailable: true, versionInfo: info }
    }

    return { updateAvailable: false, versionInfo: info }
  } catch (e) {
    console.warn('[AutoUpdate] check failed:', e)
    return { updateAvailable: false, versionInfo: null }
  }
}

/** Table de correspondance base64 -> valeur / base64 lookup table */
const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const _B64_LOOKUP = new Uint8Array(256)
for (let i = 0; i < _B64.length; i++) _B64_LOOKUP[_B64.charCodeAt(i)] = i

/** Decoder une chaine base64 en octets bruts / Decode a base64 string to raw bytes */
function base64ToBytes(b64: string): Uint8Array {
  const len = b64.length
  let padding = 0
  if (len >= 1 && b64[len - 1] === '=') padding++
  if (len >= 2 && b64[len - 2] === '=') padding++
  const byteLen = (len / 4) * 3 - padding
  const bytes = new Uint8Array(byteLen)
  let p = 0
  for (let i = 0; i < len; i += 4) {
    const e1 = _B64_LOOKUP[b64.charCodeAt(i)]
    const e2 = _B64_LOOKUP[b64.charCodeAt(i + 1)]
    const e3 = _B64_LOOKUP[b64.charCodeAt(i + 2)]
    const e4 = _B64_LOOKUP[b64.charCodeAt(i + 3)]
    bytes[p++] = (e1 << 2) | (e2 >> 4)
    if (b64[i + 2] !== '=') bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2)
    if (b64[i + 3] !== '=') bytes[p++] = ((e3 & 3) << 6) | e4
  }
  return bytes
}

/** SHA-256 d'un fichier local, calcule par blocs (memoire bornee) /
 * File SHA-256 computed in chunks (bounded memory) — safe for large APKs. */
async function computeFileSha256(fileUri: string): Promise<string> {
  // 3 Mio = multiple de 3 octets → chaque bloc base64 est autonome (pas de padding interne)
  const CHUNK = 3 * 1024 * 1024
  const info = await FileSystem.getInfoAsync(fileUri)
  const total = info.exists ? ((info as { size?: number }).size ?? 0) : 0
  if (total <= 0) throw new Error('Fichier vide ou introuvable pour verification')

  const hasher = sha256.create()
  let pos = 0
  while (pos < total) {
    const length = Math.min(CHUNK, total - pos)
    const b64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      position: pos,
      length,
    })
    hasher.update(base64ToBytes(b64))
    pos += length
  }
  return hasher.hex()
}

export async function downloadAndInstallApk(
  downloadUrl: string,
  expectedSha256?: string | null,
): Promise<void> {
  if (Platform.OS !== 'android') return

  const fileUri = FileSystem.cacheDirectory + 'cmro-driver-update.apk'

  // Nettoyer l'ancien cache / Clean old cached APK
  const fileInfo = await FileSystem.getInfoAsync(fileUri)
  if (fileInfo.exists) await FileSystem.deleteAsync(fileUri, { idempotent: true })

  // Telecharger / Download
  const downloadResult = await FileSystem.downloadAsync(downloadUrl, fileUri)

  if (downloadResult.status !== 200) {
    throw new Error(`Telechargement echoue (status ${downloadResult.status})`)
  }

  // Verification d'integrite : l'APK telecharge doit correspondre a l'empreinte
  // officielle annoncee par le serveur, sinon on refuse d'installer (anti-alteration). /
  // Integrity check: the downloaded APK must match the server's official SHA-256,
  // otherwise we refuse to install (anti-tampering).
  if (expectedSha256) {
    const actual = await computeFileSha256(fileUri)
    if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
      await FileSystem.deleteAsync(fileUri, { idempotent: true })
      console.error(`[AutoUpdate] SHA-256 mismatch: attendu=${expectedSha256} obtenu=${actual}`)
      throw new Error(
        "Mise a jour refusee : l'empreinte de securite de l'APK ne correspond pas. "
        + 'Contactez votre administrateur.',
      )
    }
    console.log('[AutoUpdate] Integrite APK verifiee (SHA-256 OK)')
  } else {
    console.warn('[AutoUpdate] Aucune empreinte SHA-256 fournie par le serveur — installation sans verification')
  }

  // Lancer l'installeur Android / Launch Android installer
  const contentUri = await FileSystem.getContentUriAsync(fileUri)
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1 | 0x10000000,  // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
    type: 'application/vnd.android.package-archive',
  })
}
