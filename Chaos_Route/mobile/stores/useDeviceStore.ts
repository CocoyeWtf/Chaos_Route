/* Store enregistrement appareil / Device registration store (Zustand + SecureStore) */

import { create } from 'zustand'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import api from '../services/api'

interface DeviceState {
  deviceId: string | null        // UUID unique du telephone
  registrationCode: string | null // Code d'enregistrement serveur
  friendlyName: string | null    // Nom de l'appareil (depuis le serveur)
  baseName: string | null        // Nom de la base logistique
  pdvId: number | null           // PDV rattache (tablette magasin sans login) / Bound PDV
  allowedFeatures: string[]      // Fonctionnalites autorisees / Allowed features
  controlMode: boolean           // Mode controle actif (photo obligatoire) / Control mode active
  isRegistered: boolean
  isLoading: boolean
  hasFeature: (feature: string) => boolean
  loadDevice: () => Promise<void>
  register: (deviceId: string, registrationCode: string) => Promise<void>
  fetchDeviceInfo: () => Promise<void>
  fetchPdvBinding: () => Promise<void>
  reset: () => Promise<void>
}

const ALL_FEATURES = ['tours', 'pickups', 'base_reception', 'inventory', 'declarations', 'inspections']

export const useDeviceStore = create<DeviceState>((set, get) => ({
  deviceId: null,
  registrationCode: null,
  friendlyName: null,
  baseName: null,
  pdvId: null,
  allowedFeatures: ALL_FEATURES,
  controlMode: false,
  isRegistered: false,
  isLoading: true,

  hasFeature: (feature: string) => {
    return get().allowedFeatures.includes(feature)
  },

  loadDevice: async () => {
    try {
      const deviceId = await SecureStore.getItemAsync('device_id')
      const registrationCode = await SecureStore.getItemAsync('registration_code')
      const friendlyName = await SecureStore.getItemAsync('friendly_name')
      const baseName = await SecureStore.getItemAsync('base_name')
      // Charger les features depuis le cache local avant le fetch / Load cached features before fetch
      let allowedFeatures = ALL_FEATURES
      let controlMode = false
      try {
        const cached = await SecureStore.getItemAsync('allowed_features')
        if (cached) allowedFeatures = JSON.parse(cached)
        const cachedCtrl = await SecureStore.getItemAsync('control_mode')
        if (cachedCtrl) controlMode = cachedCtrl === 'true'
      } catch { /* ignore */ }
      let pdvId: number | null = null
      try {
        const cachedPdv = await SecureStore.getItemAsync('pdv_id')
        if (cachedPdv) pdvId = parseInt(cachedPdv, 10)
      } catch { /* ignore */ }
      const isRegistered = !!deviceId && !!registrationCode
      set({
        deviceId,
        registrationCode,
        friendlyName,
        baseName,
        pdvId,
        allowedFeatures,
        controlMode,
        isRegistered,
      })
      // IMPORTANT : on résout le rattachement PDV (serveur, fallback cache) AVANT
      // de lever isLoading, pour que la NAVIGATION au démarrage parte déjà avec le
      // bon pdv_id et route directement vers /pdv-home (sinon course → écran noir
      // sur le flux chauffeur). / Resolve the PDV binding BEFORE clearing isLoading
      // so startup navigation uses the right pdv_id (no race → no black screen).
      if (isRegistered) {
        await get().fetchDeviceInfo()
      }
    } catch {
      /* ignore — isLoading levé dans le finally */
    } finally {
      set({ isLoading: false })
    }
  },

  register: async (deviceId: string, registrationCode: string) => {
    await SecureStore.setItemAsync('device_id', deviceId)
    await SecureStore.setItemAsync('registration_code', registrationCode)
    set({ deviceId, registrationCode, isRegistered: true })
  },

  fetchDeviceInfo: async () => {
    // Le rattachement PDV est resolu SEPAREMENT (#14) : il etait imbrique dans le
    // try de /driver/device-info, donc un echec de cet appel — endpoint chauffeur,
    // sur une tablette magasin — laissait pdv_id jamais renseigne, et la tablette
    // repartait sur le flux chauffeur. /
    // Resolve the PDV binding independently: it used to sit inside the driver
    // endpoint's try block, so any failure there left pdv_id unset.
    await get().fetchPdvBinding()
    try {
      const { data } = await api.get('/driver/device-info')
      const friendlyName = data.friendly_name || null
      const baseName = data.base_name || null
      const allowedFeatures: string[] = Array.isArray(data.allowed_features) ? data.allowed_features : ALL_FEATURES
      const controlMode: boolean = !!data.control_mode
      // Persister localement / Persist locally
      if (friendlyName) await SecureStore.setItemAsync('friendly_name', friendlyName)
      else await SecureStore.deleteItemAsync('friendly_name')
      if (baseName) await SecureStore.setItemAsync('base_name', baseName)
      else await SecureStore.deleteItemAsync('base_name')
      await SecureStore.setItemAsync('allowed_features', JSON.stringify(allowedFeatures))
      await SecureStore.setItemAsync('control_mode', String(controlMode))
      set({ friendlyName, baseName, allowedFeatures, controlMode })
    } catch {
      // Charger depuis le cache local / Load from local cache
      try {
        const cached = await SecureStore.getItemAsync('allowed_features')
        if (cached) set({ allowedFeatures: JSON.parse(cached) })
      } catch { /* ignore */ }
    }
  },

  /* Rattachement PDV (tablette magasin) via /devices/me.
     PERSISTANCE : on ne DÉLIE jamais la tablette sur un aléa. On ne met à jour le
     pdv_id QUE si le serveur renvoie une valeur ; un null/échec transitoire
     conserve le PDV déjà en cache (sinon écran noir au redémarrage + réinstall).
     Never unbind on a transient null/failure — keep the cached PDV. */
  fetchPdvBinding: async () => {
    try {
      const { data: me } = await api.get('/devices/me')
      const pdvId: number | null = me?.pdv_id ?? null
      if (pdvId != null) {
        await SecureStore.setItemAsync('pdv_id', String(pdvId))
        set({ pdvId })
      }
    } catch { /* ignore — on garde le rattachement PDV en cache */ }
  },

  reset: async () => {
    await SecureStore.deleteItemAsync('device_id')
    await SecureStore.deleteItemAsync('registration_code')
    await SecureStore.deleteItemAsync('friendly_name')
    await SecureStore.deleteItemAsync('base_name')
    await SecureStore.deleteItemAsync('allowed_features')
    await SecureStore.deleteItemAsync('control_mode')
    await SecureStore.deleteItemAsync('pdv_id')
    set({ deviceId: null, registrationCode: null, friendlyName: null, baseName: null, pdvId: null, allowedFeatures: ALL_FEATURES, controlMode: false, isRegistered: false })
  },
}))

/** Generer ou recuperer l'identifiant unique du telephone / Generate or get unique device UUID */
export async function getOrCreateDeviceUUID(): Promise<string> {
  const existing = await SecureStore.getItemAsync('device_id')
  if (existing) return existing

  // Persister immédiatement pour garantir un UUID stable même si l'enregistrement
  // n'aboutit pas. / Persist immediately so the UUID is stable across restarts.
  const uuid = Crypto.randomUUID()
  await SecureStore.setItemAsync('device_id', uuid)
  return uuid
}
