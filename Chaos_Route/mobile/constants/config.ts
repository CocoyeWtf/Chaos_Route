/* Configuration de l'app mobile / Mobile app configuration */

// URL du serveur API (a changer en production) / API server URL (change for production)
export const API_BASE_URL = 'https://chaosroute.chaosmanager.tech/api'

// Intervalles GPS / GPS intervals
export const GPS_INTERVAL_MS = 180_000  // 3 minutes
export const GPS_DISTANCE_MIN_M = 50     // 50 metres minimum
// Duree maximale d'une session de suivi. Le suivi s'arrete normalement a la
// cloture de la tournee ; ce plafond n'existe que pour le cas ou la cloture
// n'arrive jamais (tournee oubliee, app fermee toute la nuit). La notice RGPD
// promet l'absence de suivi hors heures de travail : sans ce garde-fou, la
// promesse ne tiendrait pas. / Backstop for a tour that is never closed.
export const GPS_MAX_SESSION_MS = 14 * 60 * 60 * 1000  // 14 h

// Couleurs theme sombre / Dark theme colors (coherent with web)
export const COLORS = {
  primary: '#f97316',       // orange
  danger: '#ef4444',        // rouge
  success: '#22c55e',       // vert
  bgPrimary: '#0a0a0a',
  bgSecondary: '#1a1a1a',
  bgTertiary: '#2a2a2a',
  textPrimary: '#e5e5e5',
  textSecondary: '#a3a3a3',
  textMuted: '#737373',
  border: '#333333',
  white: '#ffffff',
}

// Statuts couleurs / Status colors
export const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#737373',
  VALIDATED: '#f97316',
  IN_PROGRESS: '#3b82f6',
  RETURNING: '#3b82f6',
  COMPLETED: '#22c55e',
  PENDING: '#737373',
  ARRIVED: '#f97316',
  DELIVERED: '#22c55e',
  SKIPPED: '#ef4444',
}
