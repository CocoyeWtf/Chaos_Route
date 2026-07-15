/* Ecran inventaire contenants PDV / PDV container inventory screen
   Flow :
   1. Saisir code PDV → POST /driver/inventory-lookup → info PDV + types supports (retours autorisés)
   2. Rechercher/saisir quantites par type de support
   3. Recap → Valider → POST /driver/inventory (create_requests) → cree les demandes CMRO
   4. Impression des etiquettes generees sur l'imprimante Bluetooth (Zebra 105*148 ZPL)
*/

import { useState, useCallback, useMemo } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator, SafeAreaView, KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import api from '../services/api'
import { COLORS } from '../constants/config'
import { useDeviceStore } from '../stores/useDeviceStore'
import { usePrinterStore } from '../stores/usePrinterStore'
import { printRaw } from '../services/bluetoothPrint'
import type { SupportTypeBasic, PdvBasic } from '../types'

interface InventorySetup {
  pdv: PdvBasic
  support_types: SupportTypeBasic[]
}

interface QuantityMap {
  [supportTypeId: number]: number
}

interface RenderedLabel {
  label_id: number
  label_code: string
  sequence_number: number
  payload: string
}

interface CreatedRequest {
  id: number
  support_type_id: number
  support_type_name: string
  quantity: number
  labels: { label_id: number; label_code: string; sequence_number: number }[]
}

export default function InventoryScreen() {
  const router = useRouter()
  const friendlyName = useDeviceStore.getState().friendlyName || 'Chauffeur'
  const printer = usePrinterStore((s) => s.printer)
  const loadPrinter = usePrinterStore((s) => s.load)

  // Etape 1 : recherche PDV / Step 1: PDV lookup
  const [pdvCode, setPdvCode] = useState('')
  const [lookupLoading, setLookupLoading] = useState(false)

  // Etape 2 : saisie quantites / Step 2: quantity entry
  const [setup, setSetup] = useState<InventorySetup | null>(null)
  const [quantities, setQuantities] = useState<QuantityMap>({})
  const [search, setSearch] = useState('')
  const [showRecap, setShowRecap] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [resultSummary, setResultSummary] = useState<string>('')

  /* Rechercher le PDV / Lookup PDV */
  const handleLookup = useCallback(async () => {
    const code = pdvCode.trim()
    if (!code) {
      Alert.alert('Erreur', 'Veuillez saisir un code PDV')
      return
    }
    setLookupLoading(true)
    loadPrinter()
    try {
      const { data } = await api.post<InventorySetup>('/driver/inventory-lookup', { pdv_code: code })
      setSetup(data)
      const initQty: QuantityMap = {}
      data.support_types.forEach((st) => { initQty[st.id] = 0 })
      setQuantities(initQty)
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || 'PDV non trouve ou erreur serveur'
      Alert.alert('Erreur', detail)
    } finally {
      setLookupLoading(false)
    }
  }, [pdvCode, loadPrinter])

  /* Modifier quantite / Update quantity */
  const updateQty = useCallback((stId: number, delta: number) => {
    setQuantities((prev) => {
      const current = prev[stId] || 0
      return { ...prev, [stId]: Math.max(0, current + delta) }
    })
  }, [])

  const setQtyDirect = useCallback((stId: number, value: string) => {
    const num = parseInt(value, 10)
    setQuantities((prev) => ({ ...prev, [stId]: isNaN(num) ? 0 : Math.max(0, num) }))
  }, [])

  /* Liste filtree par recherche (nom) / List filtered by name search (ticket #8) */
  const filteredSupports = useMemo(() => {
    if (!setup) return []
    const q = search.trim().toLowerCase()
    if (!q) return setup.support_types
    return setup.support_types.filter((st) => st.name.toLowerCase().includes(q))
  }, [setup, search])

  /* Lignes saisies (quantite > 0) / Encoded lines (quantity > 0) */
  const encodedLines = useMemo(() => {
    if (!setup) return []
    return setup.support_types
      .map((st) => ({ st, qty: quantities[st.id] || 0 }))
      .filter((l) => l.qty > 0)
  }, [setup, quantities])

  /* Ouvrir le recap avant validation / Open recap before validation */
  const handleReview = useCallback(() => {
    if (encodedLines.length === 0) {
      Alert.alert('Attention', 'Aucune quantite saisie. Veuillez saisir au moins une quantite.')
      return
    }
    setShowRecap(true)
  }, [encodedLines])

  /* Valider l'inventaire : cree les demandes CMRO + imprime les etiquettes */
  const handleConfirm = useCallback(async () => {
    if (!setup) return
    const lines = encodedLines.map((l) => ({ support_type_id: l.st.id, quantity: l.qty }))

    setSubmitting(true)
    setProgress('Enregistrement et creation des demandes...')
    try {
      // 1. Enregistrer l'inventaire + creer les demandes de reprise CMRO (ticket #10)
      const { data } = await api.post<{ requests: CreatedRequest[]; requests_created: number }>(
        '/driver/inventory',
        {
          pdv_id: setup.pdv.id,
          lines,
          inventoried_by: friendlyName,
          create_requests: true,
        },
      )
      const requests = data.requests || []
      const totalLabels = requests.reduce((n, r) => n + r.labels.length, 0)

      // 2. Impression des etiquettes (ticket #7) si imprimante configuree
      let printedCount = 0
      let failedCount = 0
      let lastError: string | undefined
      if (printer && totalLabels > 0) {
        outer:
        for (const req of requests) {
          setProgress('Generation des etiquettes...')
          const { data: renderRes } = await api.post(
            `/pickup-requests/device/${req.id}/render-labels?protocol=${printer.protocol}`,
          )
          const labels = (renderRes.labels || []) as RenderedLabel[]
          const printedIds: number[] = []
          for (let i = 0; i < labels.length; i++) {
            setProgress(`Impression ${printedCount + 1}/${totalLabels}...`)
            const result = await printRaw(printer.address, labels[i].payload)
            if (result.success) {
              printedCount += 1
              printedIds.push(labels[i].label_id)
            } else {
              failedCount += 1
              lastError = result.error
              // Logger les succes deja obtenus avant d'arreter / Log successes before stopping
              if (printedIds.length > 0) {
                await api.post('/pickup-requests/device/print-events', {
                  label_ids: printedIds, protocol: printer.protocol, source: 'MOBILE_PDV',
                  printer_name: printer.name, printer_address: printer.address, success: true,
                }).catch(() => {})
              }
              break outer
            }
          }
          if (printedIds.length > 0) {
            await api.post('/pickup-requests/device/print-events', {
              label_ids: printedIds, protocol: printer.protocol, source: 'MOBILE_PDV',
              printer_name: printer.name, printer_address: printer.address, success: true,
            }).catch(() => {})
          }
        }
      }

      // 3. Resume / Summary
      const parts = [`${data.requests_created} demande(s) de reprise creee(s)`]
      if (!printer) {
        parts.push('Aucune imprimante configuree — etiquettes imprimables depuis le web ou apres configuration.')
      } else if (failedCount > 0) {
        parts.push(`${printedCount} etiquette(s) imprimee(s), ${failedCount} en echec (${lastError || 'erreur'}).`)
      } else {
        parts.push(`${printedCount} etiquette(s) imprimee(s).`)
      }
      setResultSummary(parts.join('\n'))
      setShowRecap(false)
      setSubmitted(true)
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || (err as { message?: string })?.message
        || 'Erreur lors de l\'enregistrement'
      Alert.alert('Erreur', detail)
    } finally {
      setSubmitting(false)
      setProgress('')
    }
  }, [setup, encodedLines, friendlyName, printer])

  /* Reset pour nouveau inventaire / Reset for new inventory */
  const handleReset = useCallback(() => {
    setSetup(null)
    setQuantities({})
    setPdvCode('')
    setSearch('')
    setShowRecap(false)
    setSubmitted(false)
    setResultSummary('')
  }, [])

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (showRecap ? setShowRecap(false) : router.back())} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Retour</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Inventaire PDV</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Etape 1 : Saisie code PDV / Step 1: PDV code entry */}
          {!setup && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Rechercher un PDV</Text>
              <Text style={styles.sectionHint}>Saisissez le code du point de vente</Text>
              <TextInput
                style={styles.input}
                value={pdvCode}
                onChangeText={setPdvCode}
                placeholder="Code PDV (ex: 12345)"
                placeholderTextColor={COLORS.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={handleLookup}
              />
              <TouchableOpacity onPress={handleLookup} style={styles.primaryBtn} disabled={lookupLoading}>
                {lookupLoading ? (
                  <ActivityIndicator color={COLORS.white} size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>Rechercher</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* Etape 2 : Saisie quantites / Step 2: Quantity entry */}
          {setup && !submitted && !showRecap && (
            <>
              <View style={styles.pdvCard}>
                <Text style={styles.pdvCode}>{setup.pdv.code}</Text>
                <Text style={styles.pdvName}>{setup.pdv.name}</Text>
                <TouchableOpacity onPress={handleReset}>
                  <Text style={styles.changeLink}>Changer de PDV</Text>
                </TouchableOpacity>
              </View>

              {/* Statut imprimante / Printer status */}
              <TouchableOpacity style={styles.printerBox} onPress={() => router.push('/printer-settings')}>
                {printer ? (
                  <Text style={styles.printerOk}>Imprimante : {printer.name} ({printer.protocol})</Text>
                ) : (
                  <Text style={styles.printerMissing}>Aucune imprimante — toucher pour configurer</Text>
                )}
              </TouchableOpacity>

              <Text style={styles.sectionTitle}>Quantites en stock</Text>
              <Text style={styles.sectionHint}>Recherchez un support et saisissez la quantite</Text>

              {/* Recherche support par nom (ticket #8) / Support search by name */}
              <TextInput
                style={styles.input}
                value={search}
                onChangeText={setSearch}
                placeholder="Rechercher un support..."
                placeholderTextColor={COLORS.textMuted}
                autoCorrect={false}
              />

              {filteredSupports.map((st) => (
                <View key={st.id} style={styles.supportRow}>
                  <View style={styles.supportInfo}>
                    {/* Ticket #8 : afficher uniquement le libelle, pas le code */}
                    <Text style={styles.supportName}>{st.name}</Text>
                  </View>
                  <View style={styles.qtyControls}>
                    <TouchableOpacity onPress={() => updateQty(st.id, -1)} style={styles.qtyBtn}>
                      <Text style={styles.qtyBtnText}>-</Text>
                    </TouchableOpacity>
                    <TextInput
                      style={styles.qtyInput}
                      value={String(quantities[st.id] || 0)}
                      onChangeText={(v) => setQtyDirect(st.id, v)}
                      keyboardType="numeric"
                      selectTextOnFocus
                    />
                    <TouchableOpacity onPress={() => updateQty(st.id, 1)} style={styles.qtyBtn}>
                      <Text style={styles.qtyBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              {filteredSupports.length === 0 && (
                <Text style={styles.emptyHint}>Aucun support ne correspond a la recherche.</Text>
              )}

              <TouchableOpacity onPress={handleReview} style={styles.submitBtn}>
                <Text style={styles.submitBtnText}>
                  Verifier ({encodedLines.length} ligne{encodedLines.length > 1 ? 's' : ''})
                </Text>
              </TouchableOpacity>
            </>
          )}

          {/* Etape 3 : Recap avant validation (ticket #10) / Recap before validation */}
          {setup && showRecap && !submitted && (
            <>
              <View style={styles.pdvCard}>
                <Text style={styles.pdvCode}>{setup.pdv.code}</Text>
                <Text style={styles.pdvName}>{setup.pdv.name}</Text>
              </View>
              <Text style={styles.sectionTitle}>Recapitulatif</Text>
              <Text style={styles.sectionHint}>
                Verifiez avant de creer la demande de reprise CMRO.
              </Text>
              {encodedLines.map((l) => (
                <View key={l.st.id} style={styles.recapRow}>
                  <Text style={styles.recapName}>{l.st.name}</Text>
                  <Text style={styles.recapQty}>{l.qty}</Text>
                </View>
              ))}
              <View style={styles.recapTotalRow}>
                <Text style={styles.recapTotalLabel}>Total lignes</Text>
                <Text style={styles.recapTotalValue}>{encodedLines.length}</Text>
              </View>

              <Text style={[styles.sectionHint, { marginTop: 12 }]}>
                {printer
                  ? `Les etiquettes seront imprimees sur ${printer.name}.`
                  : 'Aucune imprimante : la demande sera creee, etiquettes imprimables plus tard.'}
              </Text>

              <TouchableOpacity
                onPress={handleConfirm}
                style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                disabled={submitting}
              >
                {submitting ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator color={COLORS.white} size="small" />
                    <Text style={styles.submitBtnText}>{progress || 'En cours...'}</Text>
                  </View>
                ) : (
                  <Text style={styles.submitBtnText}>Valider et creer la demande</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowRecap(false)} style={{ marginTop: 12 }} disabled={submitting}>
                <Text style={styles.linkText}>Modifier les quantites</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Etape 4 : Confirmation / Step 4: Confirmation */}
          {submitted && (
            <View style={styles.successSection}>
              <Text style={styles.successIcon}>OK</Text>
              <Text style={styles.successText}>
                Inventaire enregistre pour {setup?.pdv.code}
                {resultSummary ? `\n\n${resultSummary}` : ''}
              </Text>
              <TouchableOpacity onPress={handleReset} style={styles.primaryBtn}>
                <Text style={styles.primaryBtnText}>Nouvel inventaire</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
                <Text style={styles.linkText}>Retour a l'accueil</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bgPrimary },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 17, fontWeight: 'bold', color: COLORS.textPrimary },
  backBtn: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  backBtnText: { fontSize: 13, fontWeight: '600', color: COLORS.textSecondary },
  // Ticket #9 : marge basse plus importante pour que le bouton ne soit pas
  // masque par la barre de controle du telephone / larger bottom padding so the
  // button is not hidden by the phone's system navigation bar.
  content: { padding: 16, paddingBottom: 140 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: COLORS.primary, marginBottom: 6 },
  sectionHint: { fontSize: 12, color: COLORS.textMuted, marginBottom: 12 },
  input: {
    backgroundColor: COLORS.bgSecondary, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 14,
    color: COLORS.textPrimary, fontSize: 16, marginBottom: 12,
  },
  primaryBtn: { backgroundColor: COLORS.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  primaryBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
  linkText: { color: COLORS.textMuted, fontSize: 14, textDecorationLine: 'underline', textAlign: 'center' },

  /* Printer box */
  printerBox: {
    backgroundColor: COLORS.bgSecondary, borderRadius: 10, borderWidth: 1,
    borderColor: COLORS.border, padding: 12, marginBottom: 16,
  },
  printerOk: { color: COLORS.success, fontWeight: '700', fontSize: 13 },
  printerMissing: { color: COLORS.danger, fontWeight: '700', fontSize: 13 },

  /* PDV card */
  pdvCard: {
    backgroundColor: COLORS.bgSecondary, borderRadius: 12, padding: 14, marginBottom: 20,
    borderWidth: 1, borderColor: COLORS.primary, borderLeftWidth: 3,
  },
  pdvCode: { fontSize: 18, fontWeight: 'bold', color: COLORS.textPrimary },
  pdvName: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2 },
  changeLink: { fontSize: 12, color: COLORS.primary, marginTop: 6, textDecorationLine: 'underline' },

  /* Support type rows */
  supportRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.bgSecondary, borderRadius: 10, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  supportInfo: { flex: 1, marginRight: 12 },
  supportName: { fontSize: 14, fontWeight: '600', color: COLORS.textPrimary },
  emptyHint: { color: COLORS.textMuted, fontSize: 12, padding: 12, textAlign: 'center' },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  qtyBtn: {
    width: 44, height: 44, borderRadius: 10, backgroundColor: COLORS.bgTertiary,
    justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: COLORS.border,
  },
  qtyBtnText: { fontSize: 22, fontWeight: '700', color: COLORS.primary },
  qtyInput: {
    width: 56, height: 44, backgroundColor: COLORS.bgPrimary, borderWidth: 1,
    borderColor: COLORS.border, borderRadius: 8, textAlign: 'center',
    color: COLORS.textPrimary, fontSize: 18, fontWeight: '700',
  },

  /* Recap */
  recapRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.bgSecondary, borderRadius: 10, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.border,
  },
  recapName: { flex: 1, fontSize: 14, fontWeight: '600', color: COLORS.textPrimary, marginRight: 12 },
  recapQty: { fontSize: 18, fontWeight: '800', color: COLORS.primary },
  recapTotalRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4,
    paddingTop: 8, borderTopWidth: 1, borderTopColor: COLORS.border, marginTop: 4,
  },
  recapTotalLabel: { fontSize: 13, color: COLORS.textSecondary, fontWeight: '600' },
  recapTotalValue: { fontSize: 15, color: COLORS.textPrimary, fontWeight: '800' },

  /* Submit */
  submitBtn: {
    backgroundColor: COLORS.success, paddingVertical: 16, borderRadius: 12,
    alignItems: 'center', marginTop: 20,
  },
  submitBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },

  /* Success */
  successSection: { alignItems: 'center', paddingTop: 40 },
  successIcon: { fontSize: 32, fontWeight: '900', color: COLORS.success, marginBottom: 16 },
  successText: {
    fontSize: 15, color: COLORS.textPrimary, fontWeight: '600',
    marginBottom: 24, textAlign: 'center',
  },
})
