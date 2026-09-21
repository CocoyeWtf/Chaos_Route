/* Ecran d'accueil pour les responsables PDV / PDV manager home screen.

   Affiche le menu PDV uniquement aux utilisateurs ayant pdv_id non-null.
   Si arrive ici sans pdv_id valide -> redirection automatique vers /login.
*/

import { useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { useAuthStore } from '../stores/useAuthStore'
import { useDeviceStore } from '../stores/useDeviceStore'
import { COLORS } from '../constants/config'
import { getLocalVersion, getLocalBuild } from '../services/updateChecker'

export default function PdvHomeScreen() {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const devicePdvId = useDeviceStore((s) => s.pdvId)
  const deviceName = useDeviceStore((s) => s.friendlyName)
  // Accès PDV : utilisateur JWT (pdv_id) OU tablette magasin (device rattaché)
  const hasPdvAccess = !!user?.pdv_id || !!devicePdvId

  useEffect(() => {
    if (!hasPdvAccess) {
      router.replace('/login')
    }
  }, [hasPdvAccess, router])

  const handleLogout = () => {
    Alert.alert(
      'Deconnexion',
      'Voulez-vous vraiment vous deconnecter ?',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Deconnecter',
          style: 'destructive',
          onPress: () => {
            logout()
            router.replace('/login')
          },
        },
      ],
    )
  }

  if (!hasPdvAccess) {
    return null
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>CMRO</Text>
        <Text style={styles.subtitle}>Espace point de vente</Text>
        <Text style={styles.userInfo}>
          {user?.username ?? deviceName ?? 'Tablette magasin'}
        </Text>
      </View>

      <View style={styles.menu}>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => router.push('/pdv-pickup')}
        >
          <Text style={styles.primaryBtnTitle}>Declarer contenants</Text>
          <Text style={styles.primaryBtnSubtitle}>
            Saisie en cour + impression etiquettes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => router.push('/printer-settings')}
        >
          <Text style={styles.secondaryBtnTitle}>Imprimante Bluetooth</Text>
          <Text style={styles.secondaryBtnSubtitle}>
            Configurer l'imprimante portable
          </Text>
        </TouchableOpacity>
      </View>

      {/* Déconnexion uniquement en mode compte (JWT). Tablette magasin : pas de login. */}
      {user?.pdv_id && (
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
          <Text style={styles.logoutText}>Se deconnecter</Text>
        </TouchableOpacity>
      )}

      {/* Version ET build installes (#14). Le nom de version ne bouge pas entre
          deux builds : sans le build, impossible de dire au telephone ce qui
          tourne reellement sur la tablette. / Version AND build: the version
          name does not change between builds. */}
      <Text style={styles.buildText}>
        v{getLocalVersion()} (build {getLocalBuild()})
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgPrimary,
    padding: 24,
    paddingTop: 60,
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  title: {
    fontSize: 40,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textMuted,
    marginTop: 4,
  },
  userInfo: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 16,
  },
  menu: {
    flex: 1,
    gap: 16,
  },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    padding: 24,
  },
  primaryBtnTitle: {
    color: COLORS.white,
    fontSize: 20,
    fontWeight: '800',
  },
  primaryBtnSubtitle: {
    color: COLORS.white,
    fontSize: 13,
    opacity: 0.9,
    marginTop: 6,
  },
  secondaryBtn: {
    backgroundColor: COLORS.bgSecondary,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 20,
  },
  secondaryBtnTitle: {
    color: COLORS.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryBtnSubtitle: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  logoutBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  logoutText: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  buildText: {
    color: COLORS.textMuted,
    fontSize: 11,
    textAlign: 'center',
    paddingBottom: 10,
    opacity: 0.7,
  },
})
