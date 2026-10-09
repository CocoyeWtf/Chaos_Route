/* Note d'information geolocalisation (RGPD art. 13 + L.1222-4).

   Ce n'est PAS un ecran de consentement. Le registre CNIL (traitement n°2)
   fonde la geolocalisation des chauffeurs sur l'interet legitime (art. 6.1.f),
   et le consentement n'est de toute facon pas une base valable entre employeur
   et salarie : le lien de subordination le prive de son caractere libre. Ce
   qu'on doit prouver, c'est que chaque chauffeur a ete INFORME — d'ou l'accuse
   de lecture horodate, versionne, journalise cote serveur.

   Il n'y a donc pas de bouton « Je refuse » : un interrupteur en libre-service
   aurait suffi a rendre un vehicule invisible, et aurait contredit la base
   legale declaree. Le droit d'opposition (art. 21) s'exerce aupres du
   responsable de traitement, au cas par cas. /
   Information notice, not a consent screen: geolocation rests on legitimate
   interest, so we record an acknowledgement, not a choice. */

import { useEffect, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import api from '../services/api'
import { COLORS } from '../constants/config'

export default function GpsNoticeScreen() {
  const router = useRouter()
  const [notice, setNotice] = useState<{ version: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get('/gdpr/privacy-notice/gps')
      .then(({ data }) => setNotice(data))
      .catch(() => setNotice({
        version: 'hors-ligne',
        text: "Pendant vos tournées, l'application transmet la position du véhicule "
          + "pour le suivi opérationnel, la preuve de passage, la traçabilité des "
          + "supports scannés et la sécurité. Base légale : intérêt légitime de "
          + "l'entreprise (art. 6.1.f du RGPD) ; vous en êtes informé au titre de "
          + "l'article L.1222-4 du Code du travail. Aucun suivi hors tournée. "
          + "Positions conservées 60 jours. Pour exercer vos droits (accès, "
          + "rectification, opposition), adressez-vous à votre responsable ou au "
          + "délégué à la protection des données.",
      }))
  }, [])

  const acknowledge = async () => {
    setSaving(true)
    try {
      await api.post('/gdpr/consent/device', {
        consent_type: 'gps_information',
        granted: true,                       // = notice lue, pas un consentement
        info_version: notice?.version,
      })
      router.back()
    } catch {
      Alert.alert('Erreur', "Accusé de lecture non enregistré (réseau ?). Réessayez.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Suivi GPS des tournées</Text>
      <Text style={styles.subtitle}>Note d'information</Text>
      <ScrollView style={styles.noticeBox}>
        {notice
          ? <Text style={styles.noticeText}>{notice.text}</Text>
          : <ActivityIndicator color={COLORS.primary} />}
      </ScrollView>
      <TouchableOpacity
        style={[styles.button, saving && { opacity: 0.5 }]}
        onPress={acknowledge}
        disabled={saving || !notice}
      >
        <Text style={styles.buttonText}>J'ai lu et compris</Text>
      </TouchableOpacity>
      <Text style={styles.rights}>
        Pour exercer vos droits (accès, rectification, opposition), adressez-vous
        à votre responsable ou au délégué à la protection des données.
      </Text>
      {notice && <Text style={styles.version}>Notice v{notice.version}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bgPrimary, padding: 20, paddingTop: 48 },
  title: { fontSize: 20, fontWeight: 'bold', color: COLORS.textPrimary },
  subtitle: { fontSize: 13, color: COLORS.textMuted, marginBottom: 16 },
  noticeBox: {
    flex: 1, backgroundColor: COLORS.bgSecondary, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.border, padding: 16, marginBottom: 16,
  },
  noticeText: { fontSize: 14, lineHeight: 21, color: COLORS.textPrimary },
  button: {
    borderRadius: 10, paddingVertical: 14, alignItems: 'center',
    marginBottom: 12, backgroundColor: COLORS.primary,
  },
  buttonText: { color: COLORS.white, fontSize: 15, fontWeight: '700' },
  rights: { fontSize: 12, lineHeight: 17, color: COLORS.textMuted, marginBottom: 8 },
  version: { fontSize: 11, color: COLORS.textMuted, textAlign: 'center' },
})
