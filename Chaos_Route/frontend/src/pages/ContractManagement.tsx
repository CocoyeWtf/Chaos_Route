/* Page Contrats transporteurs (fusionné véhicule) / Contract management page (merged with vehicle) */

import { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CrudPage } from '../components/data/CrudPage'
import { ScheduleCalendar } from '../components/contract/ScheduleCalendar'
import type { Column } from '../components/data/DataTable'
import type { FieldDef } from '../components/data/FormDialog'
import { useApi } from '../hooks/useApi'
import api from '../services/api'
import type { Contract, Region, Carrier } from '../types'
import { formatDate } from '../utils/tourTimeUtils'

export default function ContractManagement() {
  const { t } = useTranslation()
  const { data: regions } = useApi<Region>('/regions')
  const { data: carriers } = useApi<Carrier>('/carriers')
  const [scheduleContract, setScheduleContract] = useState<Contract | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)

  const tempOptions = [
    { value: 'GEL', label: t('vehicles.gel') },
    { value: 'FRAIS', label: t('vehicles.frais') },
    { value: 'SEC', label: t('vehicles.sec') },
    { value: 'BI_TEMP', label: t('vehicles.biTemp') },
    { value: 'TRI_TEMP', label: t('vehicles.triTemp') },
  ]

  const vehicleTypeOptions = [
    { value: 'SEMI', label: t('vehicles.semi') },
    { value: 'PORTEUR', label: t('vehicles.porteur') },
    { value: 'PORTEUR_SURBAISSE', label: 'Porteur surbaissé' },
    { value: 'PORTEUR_REMORQUE', label: t('vehicles.porteurRemorque') },
    { value: 'CITY', label: t('vehicles.city') },
    { value: 'VL', label: t('vehicles.vl') },
  ]

  const tailgateOptions = [
    { value: 'RETRACTABLE', label: t('vehicles.retractable') },
    { value: 'RABATTABLE', label: t('vehicles.rabattable') },
  ]

  const columns: Column<Contract>[] = [
    { key: 'code', label: t('common.code'), width: '90px', filterable: true },
    {
      key: 'carrier_id' as keyof Contract, label: t('contracts.transporterName'), width: '140px', filterable: true,
      render: (row) => row.carrier?.name ?? row.transporter_name ?? '—',
      filterValue: (row) => row.carrier?.name ?? row.transporter_name ?? '',
    },
    {
      key: 'id' as keyof Contract,
      label: '',
      width: '70px',
      render: (row) => (
        <button
          className="text-xs px-2 py-1 rounded transition-colors hover:opacity-80"
          style={{ color: 'var(--color-primary)', backgroundColor: 'rgba(249,115,22,0.1)' }}
          onClick={(e) => {
            e.stopPropagation()
            setScheduleContract(row)
          }}
        >
          Planning
        </button>
      ),
    },
    /* Le champ porte le code Infolog du véhicule : c'est ainsi que
       l'exploitation le nomme, et c'est sous ce nom qu'il sert à rapprocher les
       tournées de l'encodage Infolog (#61). / Renamed to its operational name. */
    { key: 'vehicle_code' as keyof Contract, label: 'Code Infolog', width: '110px', filterable: true },
    { key: 'vehicle_name' as keyof Contract, label: t('contracts.vehicleName'), width: '130px', filterable: true },
    {
      key: 'temperature_type' as keyof Contract, label: t('vehicles.temperatureType'), width: '90px', filterable: true,
      render: (row) => row.temperature_type ?? '—',
    },
    {
      key: 'vehicle_type' as keyof Contract, label: t('vehicles.vehicleType'), width: '100px', filterable: true,
      render: (row) => row.vehicle_type ?? '—',
    },
    { key: 'capacity_eqp' as keyof Contract, label: t('contracts.capacity'), width: '80px' },
    {
      /* Un seul montant (#58) : « terme fixe » et « vacation » désignaient la
         même chose et portaient la même valeur dans tous les contrats. On garde
         le vocabulaire de l'exploitation — vacation — et le serveur tient les
         deux colonnes égales pour l'extraction de pré-facturation. /
         One amount: "fixed term" and "vacation" were the same thing. */
      key: 'vacation' as keyof Contract, label: 'Vacation', width: '100px',
      render: (row) => row.vacation != null ? `${row.vacation} €` : '—',
    },

    {
      key: 'cost_per_km', label: t('contracts.costPerKm'), width: '80px',
      render: (row) => row.cost_per_km != null ? `${row.cost_per_km} €` : '—',
    },
    {
      key: 'consumption_coefficient' as keyof Contract, label: t('contracts.consumptionCoefficient'), width: '100px', defaultHidden: true,
      render: (row) => row.consumption_coefficient != null ? String(row.consumption_coefficient) : '—',
    },
    { key: 'start_date', label: t('common.startDate'), width: '100px', defaultHidden: true, render: (row) => formatDate(row.start_date) },
    { key: 'end_date', label: t('common.endDate'), width: '100px', defaultHidden: true, render: (row) => formatDate(row.end_date) },
    {
      key: 'region_id', label: t('common.region'), width: '100px', filterable: true,
      render: (row) => regions.find((r) => r.id === row.region_id)?.name || '—',
      filterValue: (row) => regions.find((r) => r.id === row.region_id)?.name || '',
    },
  ]

  const fields: FieldDef[] = [
    // Identification
    { key: 'code', label: t('common.code'), type: 'text', required: true },
    {
      key: 'carrier_id', label: 'Transporteur', type: 'searchable-select', required: true,
      options: carriers.map((c) => ({ value: String(c.id), label: `${c.code} — ${c.name}` })),
      helperText: 'Si le transporteur ne figure pas dans la liste, ajoutez-le d\'abord dans Referentiel > Transporteurs.',
    },
    // Véhicule
    { key: 'vehicle_code', label: 'Code Infolog', type: 'text' },
    { key: 'vehicle_name', label: t('contracts.vehicleName'), type: 'text' },
    { key: 'temperature_type', label: t('vehicles.temperatureType'), type: 'select', options: tempOptions },
    { key: 'vehicle_type', label: t('vehicles.vehicleType'), type: 'select', options: vehicleTypeOptions },
    // Capacité + Hayon
    { key: 'capacity_eqp', label: t('contracts.capacity'), type: 'number', min: 1 },
    { key: 'capacity_weight_kg', label: t('vehicles.capacityWeight'), type: 'number', min: 0 },
    { key: 'has_tailgate', label: t('vehicles.hasTailgate'), type: 'checkbox' },
    { key: 'tailgate_type', label: t('vehicles.tailgateType'), type: 'select', options: tailgateOptions },
    // Fourniture transporteur / Carrier provides
    { key: 'provides_tractor', label: 'Transporteur fournit le tracteur', type: 'checkbox', helperText: 'Coche si le transporteur amene son tracteur (presté ou traction).' },
    {
      key: 'trailer_supply', label: 'Remorque', type: 'select',
      options: [
        { value: 'CARRIER', label: 'Le transporteur amene la sienne (presté)' },
        { value: 'CMRO', label: 'Nous la fournissons (traction / mixte)' },
        { value: 'BOTH', label: 'Les deux, selon la tournée' },
      ],
      helperText: "Choisis « Les deux » si le transporteur amene sa remorque sur certaines tournees (frais) mais tracte une remorque CMRO sur d'autres (gel). Le mode preste/mixte reste choisi par tournee a l'ordonnancement.",
      colSpan: 2,
    },
    // Carburant (obligatoire) / Fuel type (required)
    {
      key: 'fuel_type', label: t('contracts.fuelType'), type: 'select', required: true,
      options: [
        { value: 'DIESEL', label: t('fuelPrices.tabGasoil') },
        { value: 'GNV', label: t('fuelPrices.tabGaz') },
      ],
      helperText: 'Detemine le prix carburant applique (gasoil €/L ou gaz €/kg).',
    },
    // Couts
    /* Un seul champ de saisie (#58). Le serveur recopie la valeur dans l'ancien
       champ « terme fixe », que lit l'extraction de pré-facturation. */
    { key: 'vacation', label: 'Vacation (terme fixe)', type: 'number', step: 0.01 },
    { key: 'cost_per_km', label: t('contracts.costPerKm'), type: 'number', step: 0.0001 },
    { key: 'cost_per_hour', label: t('contracts.costPerHour'), type: 'number', step: 0.01 },
    // Barème pré-facturation CMRO
    {
      key: 'billing_type', label: 'Type de facturation', type: 'select',
      options: [
        { value: '1', label: '1 — Base / intérim (non facturé)' },
        { value: '2', label: '2 — Tractionnaire sous contrat (barème)' },
        { value: '3', label: '3 — Occasionnel (forfait jour)' },
        { value: '4', label: '4 — Journalier' },
      ],
      helperText: 'Type 2 = barème complet. Types 1/3/4 = forfait/éval journalier ÷ nb tournées.',
    },
    { key: 'daily_cost', label: 'Forfait/éval journalier', type: 'number', step: 0.01, helperText: 'Utilisé pour les types 1, 3 et 4 (÷ nb tournées du jour).' },
    { key: 'trailer_cost', label: 'Tarif remorque (T_rem)', type: 'number', step: 0.01, helperText: 'Forfait remorque, divisé par le nb de tournées du jour.' },
    { key: 'ha_cost', label: 'HA (forfait/tournée)', type: 'number', step: 0.01 },
    { key: 'prime_saturday', label: 'Prime samedi', type: 'number', step: 0.01 },
    { key: 'prime_sunday_holiday', label: 'Prime dimanche/férié', type: 'number', step: 0.01 },
    // Minimums + Consommation
    { key: 'min_hours_per_day', label: t('contracts.minHoursPerDay'), type: 'number', step: 0.5 },
    { key: 'min_km_per_day', label: t('contracts.minKmPerDay'), type: 'number' },
    { key: 'consumption_coefficient', label: t('contracts.consumptionCoefficient'), type: 'number', step: 0.0001 },
    {
      key: 'region_id', label: t('common.region'), type: 'select', required: true,
      options: regions.map((r) => ({ value: String(r.id), label: r.name })),
    },
    // Dates
    { key: 'start_date', label: t('common.startDate'), type: 'date' },
    { key: 'end_date', label: t('common.endDate'), type: 'date' },
  ]

  // Dates indisponibles du contrat sélectionné / Unavailable dates of selected contract
  const unavailableDates = useMemo(() => {
    const set = new Set<string>()
    if (scheduleContract?.schedules) {
      for (const s of scheduleContract.schedules) {
        if (!s.is_available) set.add(s.date)
      }
    }
    return set
  }, [scheduleContract])

  const saveSchedule = useCallback(async (changes: Array<{ date: string; is_available: boolean }>) => {
    if (!scheduleContract || changes.length === 0) return
    setSavingSchedule(true)
    try {
      await api.put(`/contracts/${scheduleContract.id}/schedule`, changes)
      setScheduleContract(null)
    } catch (e) {
      console.error('Failed to save schedule', e)
    } finally {
      setSavingSchedule(false)
    }
  }, [scheduleContract])

  return (
    <>
      <CrudPage<Contract>
        resource="contracts"
        title={t('contracts.title')}
        endpoint="/contracts"
        columns={columns}
        fields={fields}
        searchKeys={['code', 'transporter_name', 'vehicle_code', 'vehicle_name']}
        createTitle={t('contracts.new')}
        editTitle={t('contracts.edit')}
        importEntity="contracts"
        exportEntity="contracts"
        allowDuplicate
        transformPayload={(d) => {
          const cid = d.carrier_id ? Number(d.carrier_id) : null
          const carrier = carriers.find((c) => c.id === cid)
          return {
            ...d,
            region_id: Number(d.region_id),
            carrier_id: cid,
            billing_type: d.billing_type ? Number(d.billing_type) : null,
            trailer_supply: d.trailer_supply || null,
            transporter_name: carrier?.name ?? d.transporter_name ?? '',
          }
        }}
        formSize="lg"
      />

      {scheduleContract && (
        <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}>
          <div
            className="rounded-xl border shadow-2xl p-6 w-[420px]"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
          >
            <h3 className="text-sm font-bold mb-4" style={{ color: 'var(--text-primary)' }}>
              {t('contracts.calendarTitle')} — {scheduleContract.code}
            </h3>
            <ScheduleCalendar
              unavailableDates={unavailableDates}
              onSave={saveSchedule}
              saving={savingSchedule}
              onClose={() => setScheduleContract(null)}
            />
          </div>
        </div>
      )}
    </>
  )
}
