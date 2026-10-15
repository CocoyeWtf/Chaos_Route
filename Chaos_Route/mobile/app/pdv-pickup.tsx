/* Declaration de contenants PDV avec impression mobile / PDV containers declaration with mobile printing.

   Workflow :
   1. Le responsable PDV se balade dans la cour avec sa tablette
   2. Selectionne un type de reprise, puis touche le support a encoder :
      une fenetre s'ouvre avec sa photo et tout ce qu'il y a a saisir (#105).
      Avant, il fallait toucher le support en haut puis redescendre tout en
      bas de l'ecran pour la quantite, la date et les notes.
   3. Soumet -> POST /pickup-requests/ (cree la demande + N etiquettes)
   4. Recupere les chaines ZPL/TSPL via /render-labels?protocol=XXX
   5. Imprime chaque etiquette en RAW sur l'imprimante Bluetooth portable
   6. Logge l'evenement (succes/echec) via /print-events pour audit
*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Modal, Image,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import api from '../services/api'
import { API_BASE_URL, COLORS } from '../constants/config'
import { supportMatchesPickupType } from '../constants/supportRules'
import { useAuthStore } from '../stores/useAuthStore'
import { useDeviceStore } from '../stores/useDeviceStore'
import { usePrinterStore } from '../stores/usePrinterStore'
import { printRaw } from '../services/bluetoothPrint'

type PickupType = 'CONTAINER' | 'CARDBOARD' | 'MERCHANDISE' | 'CONSIGNMENT'

const PICKUP_TYPE_OPTIONS: { value: PickupType; label: string }[] = [
  { value: 'CONTAINER', label: 'Contenants / Palettes' },
  { value: 'CARDBOARD', label: 'Balles carton' },
  { value: 'CONSIGNMENT', label: 'Casiers consignes' },
  // « Retour marchandise » retiré : solution pas encore développée, les PDV ne
  // doivent pas y avoir accès. / Removed: feature not developed yet.
]

interface SupportType {
  id: number
  code: string
  name: string
  unit_quantity: number
  unit_label?: string | null
  is_combi?: boolean
  content_item_label?: string | null
  image_path?: string | null
  /* Masque par le back-office pour CE magasin (#105). Le serveur le marque au
     lieu de le retirer : la palette support obligatoire des balles (#12) se
     choisit parmi les codes PA, et un PDV qui masque ses palettes doit quand
     meme pouvoir declarer une balle. / Hidden for this store, flagged not removed. */
  hidden?: boolean
}

/* L'endpoint est public (sert les <img> du web) : pas de jeton a joindre. */
function supportImageUrl(id: number): string {
  return `${API_BASE_URL}/support-types/${id}/image`
}

interface RenderedLabel {
  label_id: number
  label_code: string
  sequence_number: number
  payload: string
}

function tomorrowIso(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

export default function PdvPickupScreen() {
  const router = useRouter()
  const user = useAuthStore((s) => s.user)
  const devicePdvId = useDeviceStore((s) => s.pdvId)
  const printer = usePrinterStore((s) => s.printer)
  const loadPrinter = usePrinterStore((s) => s.load)

  // Mode tablette magasin (auth appareil) si pas de session JWT PDV / Store-tablet mode
  const deviceMode = !user?.pdv_id && !!devicePdvId
  const pdvId = user?.pdv_id ?? devicePdvId ?? null
  const EP = {
    formData: deviceMode ? '/pickup-requests/device/form-data/' : '/pickup-requests/form-data/',
    create: deviceMode ? '/pickup-requests/device' : '/pickup-requests/',
    render: (id: number, proto: string) =>
      deviceMode
        ? `/pickup-requests/device/${id}/render-labels?protocol=${proto}`
        : `/pickup-requests/${id}/render-labels?protocol=${proto}`,
    printEvents: deviceMode ? '/pickup-requests/device/print-events' : '/pickup-requests/print-events',
  }

  const [supportTypes, setSupportTypes] = useState<SupportType[]>([])
  const [loadingForm, setLoadingForm] = useState(true)

  const [pickupType, setPickupType] = useState<PickupType | ''>('')
  const [supportTypeId, setSupportTypeId] = useState<number | null>(null)
  const [palletSupportTypeId, setPalletSupportTypeId] = useState<number | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [availabilityDate, setAvailabilityDate] = useState(tomorrowIso())
  const [withContent, setWithContent] = useState(false)
  const [notes, setNotes] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState<string>('')
  /* Fenetre d'encodage ouverte sur un support (#105) / Encoding sheet open. */
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(() => {
    loadPrinter()
  }, [loadPrinter])

  useEffect(() => {
    let cancelled = false
    setLoadingForm(true)
    api.get(EP.formData)
      .then(({ data }) => {
        if (!cancelled) {
          setSupportTypes(data.support_types || [])
        }
      })
      .catch(() => {
        if (!cancelled) {
          Alert.alert('Erreur', 'Impossible de charger les types de support')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingForm(false)
      })
    return () => { cancelled = true }
  }, [EP.formData])

  // Liste filtree par type de reprise (#15) / Filtered by pickup type.
  // L'ancienne table de prefixes ignorait « PL » : les 20 casiers consignes
  // etaient impossibles a encoder, et les SF 40040/40104/40204 (des contenants)
  // etaient ranges dans les consignes. La regle est desormais partagee et
  // calquee sur le serveur. / The old prefix table omitted "PL".
  const filteredSupports = useMemo(() => {
    if (!pickupType) return []
    return supportTypes.filter(
      (st) => !st.hidden && supportMatchesPickupType(st.code, pickupType),
    )
  }, [supportTypes, pickupType])

  const selectedSupport = supportTypes.find((st) => st.id === supportTypeId) || null
  const isCombi = !!selectedSupport?.is_combi
  const needsSupport = pickupType !== '' && pickupType !== 'MERCHANDISE'
  const showWithContent = pickupType === 'CONSIGNMENT' && !!selectedSupport?.content_item_label
  // Ticket #12 : palette support obligatoire pour les balles / Pallet mandatory for bales
  const showPalletSelect = pickupType === 'CARDBOARD'
  /* Le masquage par PDV (#105) s'applique ici aussi, mais avec un repli : si le
     magasin a masque TOUTES ses palettes, on lui represente la liste complete
     plutot que de lui interdire la declaration de balles, qui en exige une. /
     Per-PDV hiding also applies here, with a fallback to the full list. */
  const palletTypes = useMemo(() => {
    const all = supportTypes.filter((st) => st.code.startsWith('PA'))
    const visible = all.filter((st) => !st.hidden)
    return visible.length > 0 ? visible : all
  }, [supportTypes])

  const reset = useCallback(() => {
    setSheetOpen(false)
    setPickupType('')
    setSupportTypeId(null)
    setPalletSupportTypeId(null)
    setQuantity('1')
    setWithContent(false)
    setNotes('')
    setAvailabilityDate(tomorrowIso())
  }, [])

  /* Ouvrir la fenetre sur un support. Les champs repartent a blanc a chaque
     ouverture : apres une declaration de 12 palettes, enchainer sur 12 balles
     par inadvertance serait trop facile. / Fields reset on each opening. */
  const openSupport = useCallback((id: number) => {
    setSupportTypeId(id)
    setPalletSupportTypeId(null)
    setQuantity('1')
    setWithContent(false)
    setNotes('')
    setAvailabilityDate(tomorrowIso())
    setSheetOpen(true)
  }, [])

  const closeSheet = useCallback(() => {
    if (submitting) return  // ne pas fermer sous l'impression en cours
    setSheetOpen(false)
    setSupportTypeId(null)
  }, [submitting])

  const submitAndPrint = useCallback(async () => {
    const qty = parseInt(quantity, 10)
    if (!pdvId) {
      Alert.alert('Erreur', 'Aucun magasin rattaché (compte PDV ou tablette magasin requis)')
      return
    }
    if (!pickupType) {
      Alert.alert('Manque info', 'Choisissez un type de reprise')
      return
    }
    if (needsSupport && !supportTypeId) {
      Alert.alert('Manque info', 'Choisissez un type de support')
      return
    }
    if (showPalletSelect && !palletSupportTypeId) {
      Alert.alert('Manque info', 'Palette support obligatoire pour les balles (ex : PA 22020 — Pal Loc 80*120)')
      return
    }
    if (!qty || qty < 1) {
      Alert.alert('Quantite invalide', 'Saisissez au moins 1')
      return
    }
    if (!printer) {
      Alert.alert(
        'Imprimante non configuree',
        'Configurez d\'abord une imprimante Bluetooth pour imprimer les etiquettes.',
        [
          { text: 'Plus tard', style: 'cancel' },
          { text: 'Configurer', onPress: () => router.push('/printer-settings') },
        ],
      )
      return
    }

    setSubmitting(true)
    setProgress('Creation de la demande...')
    try {
      // 1. Creer la demande / Create the request
      const createRes = await api.post(EP.create, {
        pdv_id: pdvId,
        support_type_id: supportTypeId,
        quantity: qty,
        availability_date: availabilityDate,
        pickup_type: pickupType,
        with_content: showWithContent ? withContent : false,
        pallet_support_type_id: showPalletSelect ? palletSupportTypeId : null,
        notes: notes || null,
      })
      const requestId = createRes.data.id

      // 2. Rendre les etiquettes / Render labels
      setProgress('Generation des etiquettes...')
      const renderRes = await api.post(EP.render(requestId, printer.protocol))
      const labels = (renderRes.data.labels || []) as RenderedLabel[]

      if (labels.length === 0) {
        Alert.alert('Demande creee', 'Aucune etiquette a imprimer.')
        reset()
        return
      }

      // 3. Imprimer chaque etiquette en sequence / Print each label sequentially
      const printedLabelIds: number[] = []
      const failedLabelIds: number[] = []
      let lastError: string | undefined

      for (let i = 0; i < labels.length; i++) {
        const lb = labels[i]
        setProgress(`Impression ${i + 1}/${labels.length}...`)
        const result = await printRaw(printer.address, lb.payload)
        if (result.success) {
          printedLabelIds.push(lb.label_id)
        } else {
          failedLabelIds.push(lb.label_id)
          lastError = result.error
          // En cas d'echec, on arrete pour eviter d'engorger les echecs successifs /
          // On failure, stop to avoid cascading failures
          break
        }
      }

      // 4. Logger l'audit / Log audit
      setProgress('Enregistrement de l\'historique...')
      if (printedLabelIds.length > 0) {
        await api.post(EP.printEvents, {
          label_ids: printedLabelIds,
          protocol: printer.protocol,
          source: 'MOBILE_PDV',
          printer_name: printer.name,
          printer_address: printer.address,
          success: true,
        }).catch(() => { /* best-effort audit */ })
      }
      if (failedLabelIds.length > 0) {
        await api.post(EP.printEvents, {
          label_ids: failedLabelIds,
          protocol: printer.protocol,
          source: 'MOBILE_PDV',
          printer_name: printer.name,
          printer_address: printer.address,
          success: false,
          error_detail: lastError || 'Echec impression',
        }).catch(() => { /* best-effort */ })
      }

      // 5. Resume / Summary
      if (failedLabelIds.length === 0) {
        // « Envoyee » et non « imprimee » : l'app sait que les octets sont
        // partis, elle ne voit pas sortir l'etiquette. Annoncer l'impression
        // etait precisement le reproche du #86. / "Sent", not "printed".
        Alert.alert(
          'Impression lancee',
          `${printedLabelIds.length} etiquette(s) envoyee(s) a ${printer.name}.`
          + '\n\nSi une etiquette ne sort pas, relancez l\'impression depuis le web.',
        )
        reset()
      } else {
        Alert.alert(
          'Impression partielle',
          `${printedLabelIds.length} imprimee(s), ${failedLabelIds.length} en echec.\n\nErreur : ${lastError || 'inconnue'}\n\nLa demande est creee. Vous pouvez reessayer l'impression depuis le web.`,
        )
      }
    } catch (e: unknown) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || (e as { message?: string })?.message
        || 'Erreur lors de la creation'
      Alert.alert('Erreur', detail)
    } finally {
      setSubmitting(false)
      setProgress('')
    }
  }, [
    pdvId, deviceMode, pickupType, supportTypeId, quantity, availabilityDate,
    withContent, showWithContent, notes, printer, needsSupport, reset, router,
    showPalletSelect, palletSupportTypeId,
  ])

  if (loadingForm) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      /* Android : on s'appuie sur adjustResize (softwareKeyboardLayoutMode: resize)
         → pas de behavior pour éviter une double gestion. iOS : padding. */
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {/* Statut imprimante / Printer status */}
      <View style={styles.printerBox}>
        {printer ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={styles.printerDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.printerName}>{printer.name}</Text>
              <Text style={styles.printerMeta}>
                {printer.protocol} - {printer.address}
              </Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/printer-settings')}>
              <Text style={styles.linkText}>Changer</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => router.push('/printer-settings')}
            style={styles.printerMissing}
          >
            <Text style={styles.printerMissingTitle}>Aucune imprimante configuree</Text>
            <Text style={styles.printerMissingSubtitle}>Toucher pour configurer</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Type de reprise / Pickup type */}
      <Text style={styles.label}>Type de reprise</Text>
      <View style={styles.pickupTypeRow}>
        {PICKUP_TYPE_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            onPress={() => {
              setPickupType(opt.value)
              setSupportTypeId(null)
            }}
            style={[
              styles.pickupTypeBtn,
              pickupType === opt.value && styles.pickupTypeBtnActive,
            ]}
          >
            <Text style={[
              styles.pickupTypeText,
              pickupType === opt.value && styles.pickupTypeTextActive,
            ]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Type de support / Support type.
          Ticket #105 : toucher un support ouvre la fenetre d'encodage au lieu
          de n'armer qu'une selection qu'il fallait aller completer tout en bas
          de l'ecran. La liste ne garde donc ici que de quoi reconnaitre le
          support. / Tapping a support now opens the encoding sheet. */}
      {needsSupport && (
        <>
          <Text style={styles.label}>Type de support</Text>
          {filteredSupports.length === 0 ? (
            <Text style={styles.emptyHint}>
              {supportTypes.some((st) => st.hidden && supportMatchesPickupType(st.code, pickupType as PickupType))
                ? 'Aucun support affiche pour ce type. Les supports de ce magasin'
                  + ' se reglent depuis le web (Referentiels > Supports visibles PDV).'
                : 'Aucun support disponible pour ce type.'}
            </Text>
          ) : (
            <View style={styles.supportList}>
              {filteredSupports.map((st) => (
                <TouchableOpacity
                  key={st.id}
                  onPress={() => openSupport(st.id)}
                  style={styles.supportRow}
                >
                  <View style={styles.supportThumbWrap}>
                    {st.image_path ? (
                      <Image
                        source={{ uri: supportImageUrl(st.id) }}
                        style={styles.supportThumb}
                        resizeMode="contain"
                      />
                    ) : (
                      <Text style={styles.supportThumbEmpty}>{st.code.slice(0, 2)}</Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.supportCode}>{st.code}</Text>
                    <Text style={styles.supportName}>{st.name}</Text>
                  </View>
                  {st.is_combi && (
                    <View style={styles.combiBadge}>
                      <Text style={styles.combiBadgeText}>COMBI</Text>
                    </View>
                  )}
                  <Text style={styles.supportChevron}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>

    {/* Fenetre d'encodage / Encoding sheet (#105).
        Tout ce qu'il y a a saisir tient dans cette fenetre, photo du support
        comprise : plus d'aller-retour entre le haut et le bas de l'ecran. */}
    <Modal
      visible={sheetOpen}
      animationType="slide"
      transparent
      onRequestClose={closeSheet}
    >
      <View style={styles.sheetBackdrop}>
        <KeyboardAvoidingView
          style={styles.sheetWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.sheet}>
            {/* En-tete : photo + identite du support */}
            <View style={styles.sheetHeader}>
              <View style={styles.sheetPhotoWrap}>
                {selectedSupport?.image_path ? (
                  <Image
                    source={{ uri: supportImageUrl(selectedSupport.id) }}
                    style={styles.sheetPhoto}
                    resizeMode="contain"
                  />
                ) : (
                  <Text style={styles.sheetPhotoEmpty}>Photo{'\n'}a venir</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetCode}>{selectedSupport?.code}</Text>
                <Text style={styles.sheetName}>{selectedSupport?.name}</Text>
                {selectedSupport?.unit_label ? (
                  <Text style={styles.sheetUnit}>{selectedSupport.unit_label}</Text>
                ) : null}
              </View>
              <TouchableOpacity onPress={closeSheet} hitSlop={12} style={styles.sheetClose}>
                <Text style={styles.sheetCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.sheetBody}
              contentContainerStyle={styles.sheetBodyContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            >
              {/* Bandeau info combi / Combi info banner */}
              {isCombi && (
                <View style={styles.combiInfoBanner}>
                  <Text style={styles.combiInfoTitle}>Declaration combi - stock absolu</Text>
                  <Text style={styles.combiInfoText}>
                    Saisissez le nombre TOTAL de combis dispo sur la base. Demain,
                    redeclarez le nouveau total. Le chauffeur reprendra ce qu&apos;il peut.
                  </Text>
                </View>
              )}

              {/* Palette support obligatoire pour les balles (ticket #12) */}
              {showPalletSelect && (
                <>
                  <Text style={styles.label}>Palette support *</Text>
                  {palletTypes.length === 0 ? (
                    <Text style={styles.emptyHint}>Aucune palette disponible.</Text>
                  ) : (
                    <View style={styles.supportList}>
                      {palletTypes.map((pt) => (
                        <TouchableOpacity
                          key={pt.id}
                          onPress={() => setPalletSupportTypeId(pt.id)}
                          style={[
                            styles.supportRow,
                            palletSupportTypeId === pt.id && styles.supportRowActive,
                          ]}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.supportCode}>{pt.code}</Text>
                            <Text style={styles.supportName}>{pt.name}</Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </>
              )}

              {/* Quantite / Quantity */}
              <Text style={styles.label}>
                {isCombi ? 'Stock combi (absolu)' : 'Quantite'}
              </Text>
              <TextInput
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="number-pad"
                style={styles.input}
                placeholder="0"
                placeholderTextColor={COLORS.textMuted}
              />

              {/* Date dispo / Availability date */}
              <Text style={styles.label}>Date de disponibilite (YYYY-MM-DD)</Text>
              <TextInput
                value={availabilityDate}
                onChangeText={setAvailabilityDate}
                style={styles.input}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="none"
              />

              {/* With content (consignes) */}
              {showWithContent && (
                <TouchableOpacity
                  onPress={() => setWithContent((v) => !v)}
                  style={styles.checkboxRow}
                >
                  <View style={[styles.checkbox, withContent && styles.checkboxChecked]} />
                  <Text style={styles.checkboxLabel}>
                    Avec {selectedSupport!.content_item_label}s
                  </Text>
                </TouchableOpacity>
              )}

              {/* Notes */}
              <Text style={styles.label}>Notes (optionnel)</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                style={styles.input}
                placeholder="Informations complementaires..."
                placeholderTextColor={COLORS.textMuted}
              />
            </ScrollView>

            {/* Submit, dans la fenetre comme demande au #105 */}
            <View style={styles.sheetFooter}>
              <TouchableOpacity
                onPress={submitAndPrint}
                disabled={submitting}
                style={[styles.submitBtn, submitting && { opacity: 0.5 }]}
              >
                {submitting ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator color={COLORS.white} size="small" />
                    <Text style={styles.submitText}>{progress || 'En cours...'}</Text>
                  </View>
                ) : (
                  <Text style={styles.submitText}>Declarer et imprimer</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bgPrimary },
  content: { padding: 16, paddingBottom: 220 },  // marge basse pour remonter les champs au-dessus du clavier
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bgPrimary },

  printerBox: {
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 16,
  },
  printerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.success,
    marginRight: 10,
  },
  printerName: { color: COLORS.textPrimary, fontWeight: '700', fontSize: 14 },
  printerMeta: { color: COLORS.textMuted, fontSize: 11, marginTop: 2 },
  printerMissing: { alignItems: 'center', paddingVertical: 4 },
  printerMissingTitle: { color: COLORS.danger, fontWeight: '700', fontSize: 13 },
  printerMissingSubtitle: { color: COLORS.textMuted, fontSize: 11, marginTop: 2 },

  label: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 14,
  },
  pickupTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickupTypeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgSecondary,
  },
  pickupTypeBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  pickupTypeText: { color: COLORS.textPrimary, fontSize: 13 },
  pickupTypeTextActive: { color: COLORS.white, fontWeight: '700' },

  emptyHint: { color: COLORS.textMuted, fontSize: 12, padding: 12 },
  supportList: { gap: 6 },
  supportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
  },
  supportRowActive: { borderColor: COLORS.primary, backgroundColor: 'rgba(249,115,22,0.08)' },
  supportThumbWrap: {
    width: 44, height: 44, borderRadius: 8, marginRight: 10,
    backgroundColor: COLORS.bgTertiary,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  supportThumb: { width: '100%', height: '100%' },
  supportThumbEmpty: { color: COLORS.textMuted, fontSize: 11, fontWeight: '800' },
  supportChevron: { color: COLORS.textMuted, fontSize: 22, marginLeft: 8 },
  supportCode: { color: COLORS.primary, fontWeight: '800', fontSize: 12 },
  supportName: { color: COLORS.textPrimary, fontSize: 13, marginTop: 2 },
  combiBadge: { backgroundColor: 'rgba(139,92,246,0.18)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  combiBadgeText: { color: '#8b5cf6', fontSize: 9, fontWeight: '800' },

  combiInfoBanner: {
    backgroundColor: 'rgba(139,92,246,0.12)',
    borderColor: '#8b5cf6',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  combiInfoTitle: { color: '#8b5cf6', fontWeight: '800', fontSize: 12, marginBottom: 4 },
  combiInfoText: { color: COLORS.textSecondary, fontSize: 11, lineHeight: 16 },

  input: {
    backgroundColor: COLORS.bgSecondary,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: COLORS.textPrimary,
  },

  checkboxRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 10 },
  checkbox: {
    width: 18, height: 18, borderRadius: 4,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.bgSecondary,
  },
  checkboxChecked: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  checkboxLabel: { color: COLORS.textPrimary, fontSize: 13 },

  submitBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,  // le pied de la fenetre porte deja sa marge / sheet footer has padding
  },
  submitText: { color: COLORS.white, fontSize: 15, fontWeight: '800' },

  linkText: { color: COLORS.primary, fontSize: 12, fontWeight: '700' },

  /* Fenetre d'encodage (#105) / Encoding sheet.
     Fond translucide + feuille plafonnee a 88 % de la hauteur : sur une
     tablette magasin, le clavier numerique mange deja la moitie de l'ecran. */
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheetWrap: { width: '100%' },
  sheet: {
    backgroundColor: COLORS.bgPrimary,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderColor: COLORS.border,
    maxHeight: '88%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sheetPhotoWrap: {
    width: 86, height: 86, borderRadius: 12,
    backgroundColor: COLORS.bgSecondary,
    borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  sheetPhoto: { width: '100%', height: '100%' },
  sheetPhotoEmpty: { color: COLORS.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 15 },
  sheetCode: { color: COLORS.primary, fontWeight: '800', fontSize: 14 },
  sheetName: { color: COLORS.textPrimary, fontSize: 15, fontWeight: '700', marginTop: 2 },
  sheetUnit: { color: COLORS.textMuted, fontSize: 11, marginTop: 3 },
  sheetClose: { paddingHorizontal: 6, paddingVertical: 2 },
  sheetCloseText: { color: COLORS.textMuted, fontSize: 20, fontWeight: '700' },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingHorizontal: 16, paddingBottom: 8 },
  sheetFooter: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
})
