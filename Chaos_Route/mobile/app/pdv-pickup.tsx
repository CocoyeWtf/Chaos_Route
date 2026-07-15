/* Declaration de contenants PDV avec impression mobile / PDV containers declaration with mobile printing.

   Workflow :
   1. Le responsable PDV se balade dans la cour avec sa tablette
   2. Selectionne type de reprise + support + quantite + date dispo
   3. Soumet -> POST /pickup-requests/ (cree la demande + N etiquettes)
   4. Recupere les chaines ZPL/TSPL via /render-labels?protocol=XXX
   5. Imprime chaque etiquette en RAW sur l'imprimante Bluetooth portable
   6. Logge l'evenement (succes/echec) via /print-events pour audit
*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import api from '../services/api'
import { COLORS } from '../constants/config'
import { useAuthStore } from '../stores/useAuthStore'
import { useDeviceStore } from '../stores/useDeviceStore'
import { usePrinterStore } from '../stores/usePrinterStore'
import { printRaw } from '../services/bluetoothPrint'

type PickupType = 'CONTAINER' | 'CARDBOARD' | 'MERCHANDISE' | 'CONSIGNMENT'

const PICKUP_TYPE_OPTIONS: { value: PickupType; label: string }[] = [
  { value: 'CONTAINER', label: 'Contenants' },
  { value: 'CARDBOARD', label: 'Balles carton' },
  { value: 'CONSIGNMENT', label: 'Consignes' },
  // « Retour marchandise » retiré : solution pas encore développée, les PDV ne
  // doivent pas y avoir accès. / Removed: feature not developed yet.
]

const PICKUP_TYPE_PREFIXES: Record<PickupType, string[]> = {
  CONTAINER: ['PA', 'CO'],
  CARDBOARD: ['RE'],
  CONSIGNMENT: ['SF'],
  MERCHANDISE: [],
}

interface SupportType {
  id: number
  code: string
  name: string
  unit_quantity: number
  is_combi?: boolean
  content_item_label?: string | null
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

  // Liste filtree par type de reprise / Filtered by pickup type
  const filteredSupports = useMemo(() => {
    if (!pickupType) return []
    const prefixes = PICKUP_TYPE_PREFIXES[pickupType]
    if (prefixes.length === 0) return []
    return supportTypes.filter((st) => prefixes.some((p) => st.code.startsWith(p)))
  }, [supportTypes, pickupType])

  const selectedSupport = supportTypes.find((st) => st.id === supportTypeId) || null
  const isCombi = !!selectedSupport?.is_combi
  const needsSupport = pickupType !== '' && pickupType !== 'MERCHANDISE'
  const showWithContent = pickupType === 'CONSIGNMENT' && !!selectedSupport?.content_item_label
  // Ticket #12 : palette support obligatoire pour les balles / Pallet mandatory for bales
  const showPalletSelect = pickupType === 'CARDBOARD'
  const palletTypes = useMemo(() => supportTypes.filter((st) => st.code.startsWith('PA')), [supportTypes])

  const reset = useCallback(() => {
    setPickupType('')
    setSupportTypeId(null)
    setPalletSupportTypeId(null)
    setQuantity('1')
    setWithContent(false)
    setNotes('')
    setAvailabilityDate(tomorrowIso())
  }, [])

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
        Alert.alert(
          'Impression terminee',
          `${printedLabelIds.length} etiquette(s) imprimee(s) avec succes.`,
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

      {/* Type de support / Support type */}
      {needsSupport && (
        <>
          <Text style={styles.label}>Type de support</Text>
          {filteredSupports.length === 0 ? (
            <Text style={styles.emptyHint}>Aucun support disponible pour ce type.</Text>
          ) : (
            <View style={styles.supportList}>
              {filteredSupports.map((st) => (
                <TouchableOpacity
                  key={st.id}
                  onPress={() => setSupportTypeId(st.id)}
                  style={[
                    styles.supportRow,
                    supportTypeId === st.id && styles.supportRowActive,
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.supportCode}>{st.code}</Text>
                    <Text style={styles.supportName}>{st.name}</Text>
                  </View>
                  {st.is_combi && (
                    <View style={styles.combiBadge}>
                      <Text style={styles.combiBadgeText}>COMBI</Text>
                    </View>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      )}

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

      {/* Palette support obligatoire pour les balles (ticket #12) / Mandatory pallet for bales */}
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
      {pickupType !== '' && (
        <>
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
        </>
      )}

      {/* Date dispo / Availability date */}
      {pickupType !== '' && (
        <>
          <Text style={styles.label}>Date de disponibilite (YYYY-MM-DD)</Text>
          <TextInput
            value={availabilityDate}
            onChangeText={setAvailabilityDate}
            style={styles.input}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
          />
        </>
      )}

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
      {pickupType !== '' && (
        <>
          <Text style={styles.label}>Notes (optionnel)</Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            style={styles.input}
            placeholder="Informations complementaires..."
            placeholderTextColor={COLORS.textMuted}
          />
        </>
      )}

      {/* Submit */}
      {pickupType !== '' && (
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
      )}
    </ScrollView>
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
    marginTop: 24,
  },
  submitText: { color: COLORS.white, fontSize: 15, fontWeight: '800' },

  linkText: { color: COLORS.primary, fontSize: 12, fontWeight: '700' },
})
