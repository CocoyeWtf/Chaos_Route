/* Client API mobile / Mobile API client

Deux modes d'auth :
- Device auth (X-Device-ID) : pour les endpoints chauffeur (/driver/*)
- JWT Bearer : pour les endpoints admin (settings, auth)
*/

import axios from 'axios'
import { Platform } from 'react-native'
import * as Application from 'expo-application'
import { useAuthStore } from '../stores/useAuthStore'
import { useDeviceStore } from '../stores/useDeviceStore'
import { API_BASE_URL } from '../constants/config'

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
})

/* Intercepteur requete : ajouter X-Device-ID + Bearer si dispo / Request interceptor */
api.interceptors.request.use((config) => {
  // Toujours envoyer le device ID si disponible
  const deviceId = useDeviceStore.getState().deviceId
  if (deviceId) {
    config.headers['X-Device-ID'] = deviceId
  }

  // Ajouter le JWT Bearer si disponible (pour les endpoints admin)
  const token = useAuthStore.getState().accessToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  // Tracabilite — version app + build + OS / Traceability — app version, build, OS.
  // Ticket #14 : on remonte la version NATIVE de l'APK installe (et non
  // `Constants.expoConfig.version`, qui decrit le bundle JS embarque), et
  // surtout le BUILD. Les builds 11 a 14 portent tous le meme nom de version
  // « 1.9.3 » : sans le build, le registre affichait 1.9.3 quoi qu'il arrive et
  // personne — client compris — ne pouvait savoir si une tablette etait a jour.
  // We now report the native app version and, above all, the build number.
  config.headers['X-App-Version'] = Application.nativeApplicationVersion || '0.0.0'
  config.headers['X-App-Build'] = String(Application.nativeBuildVersion ?? '')
  config.headers['X-OS-Version'] = `${Platform.OS} ${Platform.Version}`

  return config
})

/* Intercepteur reponse : refresh token sur 401 pour les endpoints auth / Response interceptor */
let isRefreshing = false
let failedQueue: { resolve: (token: string) => void; reject: (err: unknown) => void }[] = []

const processQueue = (error: unknown, token: string | null) => {
  failedQueue.forEach((p) => {
    if (token) p.resolve(token)
    else p.reject(error)
  })
  failedQueue = []
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
    const url = originalRequest?.url || ''

    // Refresh token uniquement pour les endpoints auth (pas driver)
    if (error.response?.status === 401 && !originalRequest._retry && url.includes('/auth/')) {
      const { refreshToken, setTokens, logout } = useAuthStore.getState()

      if (!refreshToken) {
        logout()
        return Promise.reject(error)
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`
              resolve(api(originalRequest))
            },
            reject,
          })
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        const { data } = await axios.post(`${API_BASE_URL}/auth/refresh`, {
          refresh_token: refreshToken,
        })
        setTokens(data.access_token, data.refresh_token)
        processQueue(null, data.access_token)
        originalRequest.headers.Authorization = `Bearer ${data.access_token}`
        return api(originalRequest)
      } catch (refreshError) {
        processQueue(refreshError, null)
        logout()
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    // NB : on NE fait PLUS de reset() automatique sur un 401 "Unknown device".
    // Un aléa réseau / redémarrage serveur effaçait toute la registration et
    // forçait une réinstallation. La registration est désormais conservée ; la
    // déconnexion / ré-enregistrement doit être une action volontaire. /
    // No more auto-reset on a background 401 — it was wiping the registration and
    // forcing a reinstall. Registration is kept; re-enroll must be deliberate.

    return Promise.reject(error)
  },
)

export default api
