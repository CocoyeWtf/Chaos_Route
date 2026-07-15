/* Ecran inventaire contenants base / Base container inventory screen
   Flow :
   1. Chargement auto : base (depuis device) + zones + types de support
   2. Selectionner zone + type d'inventaire
   3. Saisir quantites par type de support (filtre selon type inventaire)
   4. Soumettre
*/

import { useState, useCallback, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator, SafeAreaView, KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import api from '../services/api'
import { COLORS } from '../constants/config'
import { useDeviceStore } from '../stores/useDeviceStore'

interface BaseInfo {
  id: number
  code: string
  name: string
}

interface ZoneInfo {
  id: number
  code: string
  name: string
}

interface SupportTypeInfo {
  id: number
  code: string
  name: string
  unit_quantity: number
  unit_label?: string
  supplier_plant?: string
}

interface SetupData {
  base: BaseInfo
  zones: ZoneInfo[]
  support_types: SupportTypeInfo[]
}

type InventoryType = 'BEER_DAILY' | 'ALL_WEEKLY' | 'COMPLEMENT'

const INVENTORY_TYPES: { key: InventoryType; label: string; desc: string }[] = [
  { key: 'BEER_DAILY', label: 'Biere', desc: 'Inventaire quotidien biere' },
  { key: 'ALL_WEEKLY', label: 'Tous', desc: 'Inventaire hebdo complet' },
  { key: 'COMPLEMENT', label: 'Complement', desc: 'Inventaire complementaire' },
]

interface QuantityMap {
  [supportTypeId: number]: number
}

export default function BaseInventoryScreen() {
  const router = useRouter()
  const friendlyName = useDeviceStore.getState().friendlyName || 'Operateur'

  const [loading, setLoading] = useState(true)
  const [setup, setSetup] = useState<SetupData | null>(null)
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null)
  const [inventoryType, setInventoryType] = useState<InventoryType | null>(null)
  const [quantities, setQuantities] = useState<QuantityMap>({})
  const [search, setSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  /* Charger les donnees au montage / Load setup data on mount */
  useEffect(() => {
    ;(async () => {
      try {
        const { data } = await api.post<SetupData>('/driver/base-inventory-setup')
        setSetup(data)
      } catch (err: unknown) {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
          || 'Erreur chargement donnees base'
        Alert.alert('Erreur', detail)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  /* Types de support filtres selon le type d'inventaire + recherche par nom (ticket #8) /
     Filter support types by inventory type + name search */
  const filteredSupportTypes = (setup?.support_types.filter((st) => {
    if (inventoryType === 'BEER_DAILY' && !st.code.startsWith('SF-')) return false
    const q = search.trim().toLowerCase()
    if (q && !st.name.toLowerCase().includes(q)) return false
    return true
  }) || [])

  /* Initialiser les quantites quand le type change / Init quantities on type change */
  const selectInventoryType = useCallback((type: InventoryType) => {
    setInventoryType(type)
    setQuantities({})
  }, [])

  /* Modifier quantite / Update quantity */
  const updateQty = useCallback((stId: number, delta: number) => {
    setQuantities((prev) => {
      const current = prev[stId] || 0
      return { ...prev, [stId]: Math.max(0, current + delta) }
    })
  }, [])

  const setQtyDirect = useCallback((stId: number, value: string) => {
    const num = parseInt(value, 10)
    setQuantities((prev) => ({
      ...prev,
      [stId]: isNaN(num) ? 0 : Math.max(0, num),
    }))
  }, [])

  /* Soumettre inventaire / Submit inventory */
  const handleSubmit = useCallback(async () => {
    if (!setup || !inventoryType) return

    const lines = Object.entries(quantities)
      .map(([stId, qty]) => ({ support_type_id: Number(stId), quantity: qty }))

    if (lines.length === 0) {
      Alert.alert('Attention', 'Aucune quantite saisie.')
      return
    }

    setSubmitting(true)
    try {
      await api.post('/driver/base-inventory', {
        zone_id: selectedZoneId,
        inventory_type: inventoryType,
        lines,
        inventoried_by: friendlyName,
      })
      setSubmitted(true)
      Alert.alert('Succes', `Inventaire enregistre pour ${setup.base.name}`)
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || 'Erreur lors de l\'enregistrement'
      Alert.alert('Erreur', detail)
    } finally {
      setSubmitting(false)
    }
  }, [setup, inventoryType, selectedZoneId, quantities, friendlyName])

  /* Reset pour nouveau inventaire / Reset for new inventory */
  const handleReset = useCallback(() => {
    setSelectedZoneId(null)
    setInventoryType(null)
    setQuantities({})
    setSubmitted(false)
  }, [])

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backBtnText}>Retour</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Inventaire base</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      </SafeAreaView>
    )
  }

  if (!setup) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backBtnText}>Retour</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Inventaire base</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <Text style={{ color: COLORS.danger, textAlign: 'center' }}>
            Impossible de charger les donnees. Verifiez que l'appareil est rattache a une base.
          </Text>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Retour</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Inventaire base</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Info base */}
          <View style={styles.baseCard}>
            <Text style={styles.baseCode}>{setup.base.code}</Text>
            <Text style={styles.baseName}>{setup.base.name}</Text>
          </View>

          {!submitted && (
            <>
              {/* Etape 1 : Selection zone / Step 1: Zone selection */}
              {setup.zones.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Zone</Text>
                  <View style={styles.typeRow}>
                    <TouchableOpacity
                      style={[styles.typeBtn, !selectedZoneId && styles.typeBtnActive]}
                      onPress={() => setSelectedZoneId(null)}
                    >
                      <Text style={[styles.typeBtnText, !selectedZoneId && styles.typeBtnTextActive]}>
                        Toute la base
                      </Text>
                    </TouchableOpacity>
                    {setup.zones.map((z) => (
                      <TouchableOpacity
                        key={z.id}
                        style={[styles.typeBtn, selectedZoneId === z.id && styles.typeBtnActive]}
                        onPress={() => setSelectedZoneId(z.id)}
                      >
                        <Text style={[styles.typeBtnText, selectedZoneId === z.id && styles.typeBtnTextActive]}>
                          {z.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}

              {/* Etape 2 : Type d'inventaire / Step 2: Inventory type */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Type d'inventaire</Text>
                <View style={styles.typeRow}>
                  {INVENTORY_TYPES.map((t) => (
                    <TouchableOpacity
                      key={t.key}
                      style={[styles.typeBtn, inventoryType === t.key && styles.typeBtnActive]}
                      onPress={() => selectInventoryType(t.key)}
                    >
                      <Text style={[styles.typeBtnText, inventoryType === t.key && styles.typeBtnTextActive]}>
                        {t.label}
                      </Text>
                      <Text style={[styles.typeBtnDesc, inventoryType === t.key && { color: COLORS.white }]}>
                        {t.desc}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Etape 3 : Saisie quantites / Step 3: Quantity entry */}
              {inventoryType && (
                <>
                  <Text style={styles.sectionTitle}>
                    Quantites ({filteredSupportTypes.length} types)
                  </Text>
                  <Text style={styles.sectionHint}>
                    Saisissez le nombre de palettes par type
                  </Text>

                  {/* Recherche support par nom (ticket #8) / Support search by name */}
                  <TextInput
                    style={styles.searchInput}
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Rechercher un support..."
                    placeholderTextColor={COLORS.textMuted}
                    autoCorrect={false}
                  />

                  {filteredSupportTypes.map((st) => (
                    <View key={st.id} style={styles.supportRow}>
                      <View style={styles.supportInfo}>
                        <Text style={styles.supportName}>{st.name}</Text>
                        {st.supplier_plant ? (
                          <Text style={styles.supportPlant}>{st.supplier_plant}</Text>
                        ) : null}
                      </View>
                      <View style={styles.qtyControls}>
                        <TouchableOpacity
                          onPress={() => updateQty(st.id, -1)}
                          style={styles.qtyBtn}
                        >
                          <Text style={styles.qtyBtnText}>-</Text>
                        </TouchableOpacity>
                        <TextInput
                          style={styles.qtyInput}
                          value={String(quantities[st.id] || 0)}
                          onChangeText={(v) => setQtyDirect(st.id, v)}
                          keyboardType="numeric"
                          selectTextOnFocus
                        />
                        <TouchableOpacity
                          onPress={() => updateQty(st.id, 1)}
                          style={styles.qtyBtn}
                        >
                          <Text style={styles.qtyBtnText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}

                  {/* Bouton soumettre / Submit */}
                  <TouchableOpacity
                    onPress={handleSubmit}
                    style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                    disabled={submitting}
                  >
                    {submitting ? (
                      <ActivityIndicator color={COLORS.white} size="small" />
                    ) : (
                      <Text style={styles.submitBtnText}>Enregistrer l'inventaire</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </>
          )}

          {/* Confirmation */}
          {submitted && (
            <View style={styles.successSection}>
              <Text style={styles.successIcon}>OK</Text>
              <Text style={styles.successText}>
                Inventaire enregistre pour {setup.base.name}
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
  // Ticket #9 : marge basse plus importante pour ne pas masquer le bouton sous la
  // barre systeme / larger bottom padding so the button clears the system nav bar.
  content: { padding: 16, paddingBottom: 140 },
  searchInput: {
    backgroundColor: COLORS.bgSecondary, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: COLORS.textPrimary, fontSize: 15, marginBottom: 12,
  },

  /* Base card */
  baseCard: {
    backgroundColor: COLORS.bgSecondary, borderRadius: 12, padding: 14,
    marginBottom: 20, borderWidth: 1, borderColor: COLORS.primary, borderLeftWidth: 3,
  },
  baseCode: { fontSize: 18, fontWeight: 'bold', color: COLORS.textPrimary },
  baseName: { fontSize: 14, color: COLORS.textSecondary, marginTop: 2 },

  /* Sections */
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: COLORS.primary, marginBottom: 8 },
  sectionHint: { fontSize: 12, color: COLORS.textMuted, marginBottom: 12 },

  /* Type/zone buttons */
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeBtn: {
    flex: 1, minWidth: 90, paddingVertical: 12, paddingHorizontal: 10,
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.bgSecondary, alignItems: 'center',
  },
  typeBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  typeBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.textPrimary },
  typeBtnTextActive: { color: COLORS.white },
  typeBtnDesc: { fontSize: 10, color: COLORS.textMuted, marginTop: 2, textAlign: 'center' },

  /* Support type rows */
  supportRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.bgSecondary, borderRadius: 10, padding: 12,
    marginBottom: 8, borderWidth: 1, borderColor: COLORS.border,
  },
  supportInfo: { flex: 1, marginRight: 12 },
  supportName: { fontSize: 14, fontWeight: '700', color: COLORS.textPrimary },
  supportPlant: { fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  qtyBtn: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: COLORS.bgTertiary, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: COLORS.border,
  },
  qtyBtnText: { fontSize: 22, fontWeight: '700', color: COLORS.primary },
  qtyInput: {
    width: 56, height: 44, backgroundColor: COLORS.bgPrimary,
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 8,
    textAlign: 'center', color: COLORS.textPrimary, fontSize: 18, fontWeight: '700',
  },

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
    fontSize: 16, color: COLORS.textPrimary, fontWeight: '600',
    marginBottom: 24, textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: COLORS.primary, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', paddingHorizontal: 40,
  },
  primaryBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
  linkText: {
    color: COLORS.textMuted, fontSize: 14, textDecorationLine: 'underline', textAlign: 'center',
  },
})
