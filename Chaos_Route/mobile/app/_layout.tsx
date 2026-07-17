/* Layout racine — Device gate + auto-update + mode kiosque / Root layout */

import { useEffect, useState, useRef, useCallback } from 'react'
import {
  View, Text, Modal, TouchableOpacity, ActivityIndicator,
  StyleSheet, BackHandler, TextInput, Alert, Platform,
} from 'react-native'
import { Stack, useRouter, useSegments, type ErrorBoundaryProps } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Application from 'expo-application'
import { useDeviceStore } from '../stores/useDeviceStore'
import { useAuthStore } from '../stores/useAuthStore'
import { COLORS } from '../constants/config'
import { checkForUpdate, downloadAndInstallApk } from '../services/updateChecker'
import { verifyKioskPassword } from '../services/kioskMode'

/* Filet de sécurité : tout crash de rendu JS dans l'arbre de routes affiche un
   message + la version AU LIEU d'un écran blanc, et permet de réessayer. Aide
   aussi au diagnostic terrain (« je ne vois pas la version »). /
   Safety net: any JS render crash shows a message + version instead of a blank
   white screen, and lets the user retry. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const ver = Application.nativeApplicationVersion ?? '?'
  const build = Application.nativeBuildVersion ?? '?'
  return (
    <View style={errStyles.container}>
      <Text style={errStyles.title}>Une erreur est survenue</Text>
      <Text style={errStyles.version}>CMRO Driver v{ver} (build {build})</Text>
      <Text style={errStyles.message}>{error?.message ?? 'Erreur inconnue'}</Text>
      <TouchableOpacity onPress={retry} style={errStyles.btn}>
        <Text style={errStyles.btnText}>Réessayer</Text>
      </TouchableOpacity>
    </View>
  )
}

export default function RootLayout() {
  const router = useRouter()
  const segments = useSegments()
  const { isRegistered, isLoading, loadDevice, pdvId: devicePdvId } = useDeviceStore()
  const authUser = useAuthStore((s) => s.user)
  const loadSession = useAuthStore((s) => s.loadSession)

  // Auto-update state
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updateVersion, setUpdateVersion] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [updateSha256, setUpdateSha256] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [updateError, setUpdateError] = useState('')
  // Garde : ne declenche l'installation automatique qu'une fois par detection /
  // Guard: auto-trigger install only once per detection
  const autoStartedRef = useRef(false)

  // Kiosk mode state
  const [kioskExitAllowed, setKioskExitAllowed] = useState(false)
  const [showKioskModal, setShowKioskModal] = useState(false)
  const [kioskPassword, setKioskPassword] = useState('')
  const [kioskChecking, setKioskChecking] = useState(false)
  const [kioskError, setKioskError] = useState('')
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    loadDevice()
    loadSession()
  }, [loadDevice, loadSession])

  // Verification mise a jour au lancement / Check for update on launch
  useEffect(() => {
    ;(async () => {
      const { updateAvailable: hasUpdate, versionInfo } = await checkForUpdate()
      if (hasUpdate && versionInfo?.download_url) {
        setUpdateAvailable(true)
        setUpdateVersion(versionInfo.version)
        setDownloadUrl(versionInfo.download_url)
        setUpdateSha256(versionInfo.sha256 ?? null)
      }
    })()
  }, [])

  // Mode kiosque — bloquer bouton retour Android / Kiosk mode — block Android back button
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const handler = () => {
      if (kioskExitAllowed) return false // Laisser le systeme gerer
      return true // Bloquer la sortie
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', handler)
    return () => subscription.remove()
  }, [kioskExitAllowed])

  useEffect(() => {
    if (isLoading) return
    const inRegister = segments[0] === 'register'
    const inLogin = segments[0] === 'login'
    const inPdvFlow =
      segments[0] === 'pdv-home' ||
      segments[0] === 'pdv-pickup' ||
      segments[0] === 'printer-settings'
    const isPdvUser = !!authUser?.pdv_id
    // Tablette magasin : appareil enregistre + rattache a un PDV (sans login) /
    // Store tablet: registered device bound to a PDV (no login)
    const isDevicePdv = isRegistered && !!devicePdvId
    const canPdvFlow = isPdvUser || isDevicePdv

    // Utilisateur PDV deja authentifie -> menu PDV (eviter qu'il reste coince sur
    // /register ou /login apres restauration de session) /
    // Already-authenticated PDV user -> PDV menu
    if (isPdvUser && (inRegister || inLogin)) {
      router.replace('/pdv-home')
      return
    }

    // Tablette magasin (device rattache PDV) -> flux PDV directement, sans login /
    // Store tablet (PDV-bound device) -> PDV flow directly, no login
    if (isDevicePdv && !inPdvFlow) {
      router.replace('/pdv-home')
      return
    }

    // Autoriser PDV (JWT) et tablettes magasin (device) a acceder aux ecrans PDV
    // sans enregistrer un device chauffeur / Allow PDV users + store tablets in PDV screens
    if (!isRegistered && !inRegister && !inLogin && !(canPdvFlow && inPdvFlow)) {
      router.replace('/register')
    } else if (isRegistered && inRegister && !isDevicePdv) {
      router.replace('/(tabs)')
    }
  }, [isRegistered, isLoading, segments, router, authUser, devicePdvId])

  const handleUpdate = useCallback(async () => {
    if (!downloadUrl) return
    setDownloading(true)
    setUpdateError('')
    try {
      await downloadAndInstallApk(downloadUrl, updateSha256)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Update failed:', msg)
      // Pas d'Alert (pas de choix oui/non) : l'erreur s'affiche dans la modale
      // bloquante avec un bouton Reessayer. / No yes/no alert: error shown in the
      // blocking modal with a retry button.
      setUpdateError(msg)
    } finally {
      setDownloading(false)
    }
  }, [downloadUrl, updateSha256])

  // Mise a jour NON refusable : des qu'une MAJ est detectee, on lance
  // automatiquement le telechargement + l'installation, sans demander l'accord de
  // l'equipier (une MAJ poussee est obligatoire ; eviter les ecarts de process si
  // quelqu'un refuse). L'equipier est notifie via la modale bloquante. /
  // Non-declinable update: auto-start download+install as soon as an update is
  // detected, without asking the crew member (a pushed update is mandatory).
  useEffect(() => {
    if (updateAvailable && downloadUrl && !autoStartedRef.current) {
      autoStartedRef.current = true
      handleUpdate()
    }
  }, [updateAvailable, downloadUrl, handleUpdate])

  // Triple-tap pour ouvrir la modale kiosque / Triple-tap to open kiosk modal
  const handleKioskTap = useCallback(() => {
    tapCountRef.current++
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current)

    if (tapCountRef.current >= 3) {
      tapCountRef.current = 0
      setKioskPassword('')
      setKioskError('')
      setShowKioskModal(true)
    } else {
      tapTimerRef.current = setTimeout(() => {
        tapCountRef.current = 0
      }, 1000)
    }
  }, [])

  // Verifier mot de passe kiosque / Verify kiosk password
  const handleKioskSubmit = async () => {
    if (!kioskPassword.trim()) return
    setKioskChecking(true)
    setKioskError('')
    const valid = await verifyKioskPassword(kioskPassword)
    setKioskChecking(false)
    if (valid) {
      setKioskExitAllowed(true)
      setShowKioskModal(false)
      Alert.alert('Mode kiosque desactive', 'Vous pouvez maintenant quitter l\'application.')
      // Re-activer apres 60 secondes / Re-enable after 60 seconds
      setTimeout(() => setKioskExitAllowed(false), 60_000)
    } else {
      setKioskError('Mot de passe incorrect')
    }
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.bgPrimary, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: COLORS.primary, fontSize: 20, fontWeight: 'bold' }}>Chargement...</Text>
      </View>
    )
  }

  return (
    <>
      <StatusBar style="light" />

      {/* Modal bloquant mise a jour / Blocking update modal */}
      <Modal visible={updateAvailable} animationType="fade" transparent>
        <View style={updateStyles.overlay}>
          <View style={updateStyles.card}>
            <Text style={updateStyles.title}>Mise a jour obligatoire</Text>
            <Text style={updateStyles.version}>Version {updateVersion}</Text>
            <Text style={updateStyles.desc}>
              Une nouvelle version est installee automatiquement. Validez l'invite
              d'installation d'Android. L'application ne peut pas etre utilisee tant
              que la mise a jour n'est pas terminee.
            </Text>
            {downloading ? (
              <View style={updateStyles.progressRow}>
                <ActivityIndicator size="small" color={COLORS.primary} />
                <Text style={updateStyles.progressText}>Installation en cours...</Text>
              </View>
            ) : (
              <>
                {updateError ? (
                  <Text style={updateStyles.errorText}>{updateError}</Text>
                ) : null}
                <TouchableOpacity onPress={handleUpdate} style={updateStyles.btn}>
                  <Text style={updateStyles.btnText}>Reessayer</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal mot de passe kiosque / Kiosk password modal */}
      <Modal visible={showKioskModal} animationType="fade" transparent>
        <View style={kioskStyles.overlay}>
          <View style={kioskStyles.card}>
            <Text style={kioskStyles.title}>Mode kiosque</Text>
            <Text style={kioskStyles.desc}>Entrez le mot de passe administrateur pour quitter l'application.</Text>
            <TextInput
              style={kioskStyles.input}
              value={kioskPassword}
              onChangeText={setKioskPassword}
              placeholder="Mot de passe"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
              autoFocus
            />
            {kioskError ? <Text style={kioskStyles.error}>{kioskError}</Text> : null}
            <View style={kioskStyles.btnRow}>
              <TouchableOpacity
                onPress={() => setShowKioskModal(false)}
                style={kioskStyles.cancelBtn}
              >
                <Text style={kioskStyles.cancelBtnText}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleKioskSubmit}
                style={kioskStyles.submitBtn}
                disabled={kioskChecking}
              >
                {kioskChecking ? (
                  <ActivityIndicator size="small" color={COLORS.white} />
                ) : (
                  <Text style={kioskStyles.submitBtnText}>Valider</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.bgPrimary },
          headerTintColor: COLORS.textPrimary,
          headerTitleStyle: { fontWeight: 'bold' },
          contentStyle: { backgroundColor: COLORS.bgPrimary },
          // Zone cachee triple-tap dans le header / Hidden triple-tap zone in header
          headerRight: () => (
            <TouchableOpacity
              onPress={handleKioskTap}
              activeOpacity={1}
              style={{ width: 44, height: 44 }}
            />
          ),
        }}
      >
        <Stack.Screen name="register" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="tour/[id]" options={{ title: 'Detail tour' }} />
        <Stack.Screen name="tour/[id]/stop/[stopId]/scan" options={{ title: 'Scanner PDV', presentation: 'modal' }} />
        <Stack.Screen name="tour/[id]/stop/[stopId]/supports" options={{ title: 'Scan supports' }} />
        <Stack.Screen name="tour/[id]/stop/[stopId]/pickups" options={{ title: 'Scanner reprises' }} />
        <Stack.Screen name="declaration" options={{ title: 'Declaration', presentation: 'modal' }} />
        <Stack.Screen name="inspection" options={{ title: 'Inspection vehicule' }} />
        <Stack.Screen name="standalone-pickups" options={{ title: 'Scanner reprises', presentation: 'modal' }} />
        <Stack.Screen name="base-reception" options={{ title: 'Reception base', presentation: 'modal' }} />
        <Stack.Screen name="inventory" options={{ title: 'Inventaire PDV', presentation: 'modal' }} />
        <Stack.Screen name="base-inventory" options={{ title: 'Inventaire base', presentation: 'modal' }} />
        {/* Flow PDV (responsables magasin avec compte JWT) / PDV flow (store managers with JWT) */}
        <Stack.Screen name="pdv-home" options={{ headerShown: false }} />
        <Stack.Screen name="pdv-pickup" options={{ title: 'Declarer contenants' }} />
        <Stack.Screen name="printer-settings" options={{ title: 'Imprimante Bluetooth' }} />
      </Stack>
    </>
  )
}

const errStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgPrimary,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.danger,
    marginBottom: 8,
  },
  version: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginBottom: 20,
  },
  message: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 18,
  },
  btn: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 12,
  },
  btnText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
  },
})

const updateStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 16,
    padding: 28,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.primary,
    marginBottom: 8,
  },
  version: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 16,
  },
  desc: {
    fontSize: 13,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 18,
  },
  btn: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  btnText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '700',
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  progressText: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  errorText: {
    color: COLORS.danger,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 12,
  },
})

const kioskStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 320,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: 8,
    textAlign: 'center',
  },
  desc: {
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginBottom: 16,
  },
  input: {
    backgroundColor: COLORS.bgPrimary,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: COLORS.textPrimary,
    fontSize: 14,
    marginBottom: 8,
  },
  error: {
    color: COLORS.danger,
    fontSize: 12,
    marginBottom: 8,
    textAlign: 'center',
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  submitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
  },
  submitBtnText: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '700',
  },
})
