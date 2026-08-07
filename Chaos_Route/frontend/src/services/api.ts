/* Client API / API client for Chaos RouteManager backend */

import axios from 'axios'
import { useAuthStore } from '../stores/useAuthStore'
import { recordNetworkError } from './supportContext'

/* STIME A4 : authentification par cookies HttpOnly (posés par le backend).
   Aucun jeton n'est lisible ou stocké côté JS — withCredentials transmet les
   cookies sur chaque requête même origine. */
const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

/* Intercepteur réponse : refresh silencieux sur 401 (cookie refresh_token) /
   Response interceptor: silent cookie-based refresh on 401 */
let isRefreshing = false
let failedQueue: { resolve: () => void; reject: (err: unknown) => void }[] = []

const processQueue = (error: unknown, ok: boolean) => {
  failedQueue.forEach((p) => {
    if (ok) p.resolve()
    else p.reject(error)
  })
  failedQueue = []
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    // Dashcam : tracer l'échec réseau pour le diagnostic des tickets /
    // Dashcam: record the network failure for ticket diagnosis
    try {
      const cfg = error.config || {}
      recordNetworkError(cfg.method || 'get', cfg.url || '', error.response?.status ?? 'réseau')
    } catch { /* ignore */ }

    if (error.response?.status === 401 && !originalRequest._retry) {
      const { logout } = useAuthStore.getState()

      // Échec sur une route auth → session réellement morte → login
      if (originalRequest.url?.includes('/auth/')) {
        logout()
        window.location.href = '/login'
        return Promise.reject(error)
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({
            resolve: () => resolve(api(originalRequest)),
            reject,
          })
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        // Le cookie HttpOnly refresh_token est envoyé automatiquement ;
        // le backend fait tourner les jetons et repose les cookies.
        await axios.post('/api/auth/refresh', {}, { withCredentials: true })
        // Rafraîchir les permissions depuis le backend / Refresh permissions
        try {
          const { data: meData } = await axios.get('/api/auth/me', { withCredentials: true })
          useAuthStore.getState().setUser(meData)
        } catch { /* non-bloquant — on continue avec les anciennes permissions */ }
        processQueue(null, true)
        return api(originalRequest)
      } catch (refreshError) {
        processQueue(refreshError, false)
        logout()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    return Promise.reject(error)
  },
)

/* Déconnexion complète : révocation serveur des jetons + nettoyage local /
   Full logout: server-side token revocation + local cleanup */
export async function logoutEverywhere(): Promise<void> {
  try {
    await api.post('/auth/logout')
  } catch { /* même en cas d'échec réseau, on nettoie localement */ }
  useAuthStore.getState().logout()
}

/* Ajouter trailing slash pour correspondre aux routes FastAPI list/create /
/* Add trailing slash to match FastAPI list/create routes */
function withSlash(url: string): string {
  return url.endsWith('/') ? url : url + '/'
}

/* Fonctions CRUD génériques / Generic CRUD functions */
export async function fetchAll<T>(endpoint: string, params?: Record<string, unknown>): Promise<T[]> {
  const { data } = await api.get<T[]>(withSlash(endpoint), { params })
  return data
}

export async function fetchOne<T>(endpoint: string, id: number): Promise<T> {
  const { data } = await api.get<T>(`${endpoint}/${id}`)
  return data
}

export async function create<T>(endpoint: string, payload: Partial<T>): Promise<T> {
  const { data } = await api.post<T>(withSlash(endpoint), payload)
  return data
}

export async function update<T>(endpoint: string, id: number, payload: Partial<T>): Promise<T> {
  const { data } = await api.put<T>(`${endpoint}/${id}`, payload)
  return data
}

export async function remove(endpoint: string, id: number): Promise<void> {
  await api.delete(`${endpoint}/${id}`)
}

/* Télécharger un export CSV ou XLSX / Download a CSV or XLSX export */
export async function downloadExport(entity: string, format: 'csv' | 'xlsx' = 'xlsx'): Promise<void> {
  const response = await api.get(`/exports/${entity}`, {
    params: { format },
    responseType: 'blob',
  })
  const blob = new Blob([response.data])
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${entity}.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/* Télécharger l'export Excel de l'historique des tours (ticket #17) /
   Download the tour-history Excel export. */
export async function downloadTourHistory(regionId?: number | null): Promise<void> {
  const response = await api.get('/exports/tour-history', {
    params: regionId ? { region_id: regionId } : undefined,
    responseType: 'blob',
  })
  const today = new Date().toISOString().slice(0, 10)
  const blob = new Blob([response.data])
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `historique-tours_${today}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/* Télécharger l'export planning postier (feuille « Tours » / Tournées ERT) /
   Download the dispatcher planning export (ERT tours layout). */
export async function downloadPostierPlanning(date: string, baseId: number): Promise<void> {
  const response = await api.get('/exports/postier-planning', {
    params: { date, base_id: baseId },
    responseType: 'blob',
  })
  const blob = new Blob([response.data])
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `planning-postier_${date}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

/* Fetch wrapper avec gestion token automatique / Fetch wrapper with auto token handling.
   Utilise l'instance axios avec intercepteurs / Uses the axios instance with interceptors. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch(url: string, init?: RequestInit): Promise<any> {
  const method = init?.method?.toUpperCase() || 'GET'
  const headers: Record<string, string> = {}
  if (init?.headers) {
    const h = init.headers as Record<string, string>
    Object.keys(h).forEach((k) => { headers[k] = h[k] })
  }
  const config: Record<string, unknown> = { headers }
  if (init?.body) {
    if (typeof init.body === 'string') {
      config.data = JSON.parse(init.body)
    } else {
      config.data = init.body
    }
  }
  const res = method === 'POST' ? await api.post(url, config.data, { headers })
    : method === 'PUT' ? await api.put(url, config.data, { headers })
    : method === 'DELETE' ? await api.delete(url, { headers })
    : await api.get(url, { headers, params: undefined })
  return res.data
}

export default api
