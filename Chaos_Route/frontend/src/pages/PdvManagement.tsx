/* Page Points de vente / Point of Sale management page */

import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'
import { CrudPage } from '../components/data/CrudPage'
import type { Column } from '../components/data/DataTable'
import type { FieldDef } from '../components/data/FormDialog'
import { useApi } from '../hooks/useApi'
import { PdvBarcodePrint } from '../components/pdv/PdvBarcodePrint'
import api from '../services/api'
import type { PDV, Region, VehicleType } from '../types'
import { VEHICLE_TYPE_DEFAULTS, SELECTABLE_VEHICLE_TYPES } from '../types'

export default function PdvManagement() {
  const { t } = useTranslation()
  const { data: regions } = useApi<Region>('/regions')
  const [qrPdv, setQrPdv] = useState<PDV | null>(null)
  const [barcodePdv, setBarcodePdv] = useState<PDV | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

  /* Gabarits proposés à la saisie (#65) : CITY n'est plus un de leurs
     transporteurs, il disparaît des cases à cocher. */
  const vehicleTypeOptions = SELECTABLE_VEHICLE_TYPES.map((vt) => ({
    value: vt,
    label: VEHICLE_TYPE_DEFAULTS[vt].label,
  }))

  const pdvTypeOptions = [
    { value: 'EXPRESS', label: t('pdvs.express') },
    { value: 'CONTACT', label: t('pdvs.contact') },
    { value: 'SUPER_ALIMENTAIRE', label: t('pdvs.superAlimentaire') },
    { value: 'SUPER_GENERALISTE', label: t('pdvs.superGeneraliste') },
    { value: 'HYPER', label: t('pdvs.hyper') },
    { value: 'NETTO', label: t('pdvs.netto') },
    { value: 'DRIVE', label: t('pdvs.drive') },
    { value: 'URBAIN_PROXI', label: t('pdvs.urbainProxi') },
  ]

  const columns: Column<PDV>[] = [
    {
      key: 'qr' as keyof PDV, label: '', width: '70px',
      render: (row) => (
        <span style={{ display: 'flex', gap: '2px' }}>
          <button
            onClick={(e) => { e.stopPropagation(); setQrPdv(row) }}
            title="QR Code"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: '2px 4px' }}
          >
            ⊞
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setBarcodePdv(row) }}
            title="Code-barres PDV"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: '2px 4px' }}
          >
            |||
          </button>
        </span>
      ),
    },
    { key: 'code', label: t('common.code'), width: '100px', filterable: true },
    { key: 'name', label: t('common.name'), filterable: true },
    { key: 'type', label: t('common.type'), width: '160px', filterable: true },
    { key: 'address', label: t('common.address'), defaultHidden: true },
    { key: 'postal_code', label: t('common.postalCode'), width: '100px', defaultHidden: true },
    { key: 'city', label: t('common.city'), width: '120px', filterable: true },
    { key: 'phone', label: t('common.phone'), width: '130px', defaultHidden: true },
    { key: 'email', label: t('common.email'), defaultHidden: true },
    { key: 'latitude', label: t('common.latitude'), width: '100px', defaultHidden: true },
    { key: 'longitude', label: t('common.longitude'), width: '100px', defaultHidden: true },
    { key: 'has_sas_sec', label: 'SAS Sec', width: '70px' },
    { key: 'sas_sec_surface_m2', label: 'SAS Sec m²', width: '90px', defaultHidden: true },
    { key: 'sas_sec_capacity_eqc', label: 'SAS Sec EQC', width: '100px', defaultHidden: true },
    { key: 'has_sas_frais', label: 'SAS Frais', width: '70px' },
    { key: 'sas_frais_surface_m2', label: 'SAS Frais m²', width: '100px', defaultHidden: true },
    { key: 'sas_frais_capacity_eqc', label: 'SAS Frais EQC', width: '110px', defaultHidden: true },
    { key: 'has_sas_gel', label: 'SAS Gel', width: '70px' },
    { key: 'sas_gel_surface_m2', label: 'SAS Gel m²', width: '90px', defaultHidden: true },
    { key: 'sas_gel_capacity_eqc', label: 'SAS Gel EQC', width: '100px', defaultHidden: true },
    { key: 'has_dock', label: t('pdvs.hasDock'), width: '60px' },
    { key: 'dock_has_niche', label: t('pdvs.dockHasNiche'), width: '70px', defaultHidden: true },
    { key: 'dock_time_minutes', label: t('pdvs.dockTime'), width: '100px', defaultHidden: true },
    { key: 'unload_time_per_eqp_minutes', label: t('pdvs.unloadTime'), width: '120px', defaultHidden: true },
    { key: 'delivery_window_start', label: t('pdvs.deliveryStart'), width: '100px', defaultHidden: true },
    { key: 'delivery_window_end', label: t('pdvs.deliveryEnd'), width: '100px', defaultHidden: true },
    {
      key: 'allowed_vehicle_types' as keyof PDV, label: 'Types véhicules', width: '150px', defaultHidden: true,
      render: (row) => row.allowed_vehicle_types
        ? row.allowed_vehicle_types.split('|').map((vt) => VEHICLE_TYPE_DEFAULTS[vt as VehicleType]?.label || vt).join(', ')
        : 'Tous',
    },
    {
      key: 'region_id', label: t('common.region'), width: '120px', filterable: true,
      render: (row) => regions.find((r) => r.id === row.region_id)?.name || '—',
      filterValue: (row) => regions.find((r) => r.id === row.region_id)?.name || '',
    },
  ]

  const fields: FieldDef[] = [
    // ── Identification ──
    { key: '_s_id', label: 'Identification', type: 'section', color: '#6366f1' },
    { key: 'code', label: 'Code', type: 'text', required: true },
    { key: 'name', label: 'Nom', type: 'text', required: true },
    { key: 'type', label: 'Type', type: 'select', required: true, options: pdvTypeOptions },
    {
      key: 'region_id', label: 'Région', type: 'select', required: true,
      options: regions.map((r) => ({ value: String(r.id), label: r.name })),
    },
    { key: 'address', label: 'Adresse', type: 'text', colSpan: 2 },
    { key: 'postal_code', label: 'CP', type: 'text' },
    { key: 'city', label: 'Ville', type: 'text' },
    { key: 'phone', label: 'Tél', type: 'text' },
    { key: 'email', label: 'Email', type: 'text' },
    { key: 'latitude', label: 'Latitude', type: 'number', step: 0.000001 },
    { key: 'longitude', label: 'Longitude', type: 'number', step: 0.000001 },

    // ── SEC ──
    { key: '_s_sec', label: 'Sec', type: 'section', color: '#f59e0b' },
    { key: 'is_day_sec', label: 'Jour', type: 'checkbox' },
    { key: 'has_sas_sec', label: 'SAS', type: 'checkbox' },
    { key: 'has_dock_sec', label: 'Quai', type: 'checkbox' },
    { key: 'sas_sec_surface_m2', label: 'Surface (m²)', type: 'number', min: 0, step: 0.1 },
    { key: 'sas_sec_capacity_eqc', label: 'Capacité (EQC)', type: 'number', min: 0 },
    { key: 'delivery_window_sec_start', label: 'Livraison de', type: 'time' },
    { key: 'delivery_window_sec_end', label: 'Livraison à', type: 'time' },

    // ── FRAIS ──
    { key: '_s_frais', label: 'Frais', type: 'section', color: '#3b82f6' },
    { key: 'is_day_frais', label: 'Jour', type: 'checkbox' },
    { key: 'has_sas_frais', label: 'SAS', type: 'checkbox' },
    { key: 'has_dock_frais', label: 'Quai', type: 'checkbox' },
    { key: 'sas_frais_surface_m2', label: 'Surface (m²)', type: 'number', min: 0, step: 0.1 },
    { key: 'sas_frais_capacity_eqc', label: 'Capacité (EQC)', type: 'number', min: 0 },
    { key: 'delivery_window_frais_start', label: 'Livraison de', type: 'time' },
    { key: 'delivery_window_frais_end', label: 'Livraison à', type: 'time' },

    // ── GEL ──
    { key: '_s_gel', label: 'Gel', type: 'section', color: '#8b5cf6' },
    { key: 'is_day_gel', label: 'Jour', type: 'checkbox' },
    { key: 'has_sas_gel', label: 'SAS', type: 'checkbox' },
    { key: 'has_dock_gel', label: 'Quai', type: 'checkbox' },
    { key: 'sas_gel_surface_m2', label: 'Surface (m²)', type: 'number', min: 0, step: 0.1 },
    { key: 'sas_gel_capacity_eqc', label: 'Capacité (EQC)', type: 'number', min: 0 },
    { key: 'delivery_window_gel_start', label: 'Livraison de', type: 'time' },
    { key: 'delivery_window_gel_end', label: 'Livraison à', type: 'time' },

    // ── Déchargement & accès ──
    { key: '_s_dock', label: 'Déchargement & accès', type: 'section', color: '#10b981' },
    { key: 'has_dock', label: 'Quai (global)', type: 'checkbox' },
    { key: 'dock_has_niche', label: 'Niche', type: 'checkbox' },
    { key: 'dock_time_minutes', label: 'Temps quai (min)', type: 'number', min: 0 },
    { key: 'unload_time_per_eqp_minutes', label: 'Temps décharg./EQC (min)', type: 'number', min: 0 },
    { key: 'delivery_window_start', label: 'Livraison global de', type: 'time' },
    { key: 'delivery_window_end', label: 'Livraison global à', type: 'time' },
    { key: 'access_constraints', label: 'Contraintes accès', type: 'textarea' },
    { key: 'allowed_vehicle_types', label: 'Véhicules autorisés', type: 'multicheck', options: vehicleTypeOptions },
    /* Groupe de livraison (#69) : permet de n'injecter les volumes qu'une fois
       et de les livrer en deux vagues. */
    {
      key: 'delivery_group', label: 'Groupe de livraison', type: 'select',
      options: [{ value: '', label: '— Aucun —' }, { value: 'A', label: 'A' }, { value: 'B', label: 'B' }],
    },
  ]

  const [uploading, setUploading] = useState(false)

  const formExtra = useCallback((_formData: Record<string, unknown>, initialData?: Record<string, unknown>) => {
    if (!initialData?.id) return null // Pas d'upload en création
    const pdvId = initialData.id as number
    const planUrl = initialData.site_plan_url as string | null

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        alert('Seuls les fichiers PDF sont acceptés')
        return
      }
      setUploading(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        await api.post(`/pdvs/${pdvId}/upload-plan`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        alert('Plan chargé avec succès')
        window.location.reload()
      } catch {
        alert('Erreur lors du chargement')
      } finally {
        setUploading(false)
      }
    }

    const handleDelete = async () => {
      if (!confirm('Supprimer le plan du site ?')) return
      try {
        await api.delete(`/pdvs/${pdvId}/plan`)
        alert('Plan supprimé')
        window.location.reload()
      } catch {
        alert('Erreur lors de la suppression')
      }
    }

    /* L'endpoint plan est désormais authentifié + cloisonné tenant : on ouvre via
       une requête blob (Bearer) plutôt qu'un <a href> qui n'enverrait pas le token. */
    const handleViewPlan = async () => {
      if (!planUrl) return
      try {
        const res = await api.get(planUrl.replace(/^\/api/, ''), { responseType: 'blob' })
        const url = URL.createObjectURL(res.data as Blob)
        window.open(url, '_blank', 'noopener,noreferrer')
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      } catch {
        alert("Impossible d'ouvrir le plan")
      }
    }

    return (
      <div
        className="rounded-lg overflow-hidden border"
        style={{ borderColor: '#ef444440', backgroundColor: '#ef444408' }}
      >
        <div
          className="text-xs font-bold uppercase tracking-wide px-3 py-1.5"
          style={{ backgroundColor: '#ef444420', color: '#ef4444' }}
        >
          Plan du site (PDF)
        </div>
        <div className="p-3 flex items-center gap-3">
          {planUrl ? (
            <>
              <button
                type="button"
                onClick={handleViewPlan}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--color-primary)', color: 'var(--color-primary)' }}
              >
                Voir le plan
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:opacity-80"
                style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
              >
                Supprimer
              </button>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>ou remplacer :</span>
            </>
          ) : (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Aucun plan chargé —</span>
          )}
          <label className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white cursor-pointer transition-all hover:opacity-80" style={{ backgroundColor: 'var(--color-primary)' }}>
            {uploading ? 'Chargement...' : 'Charger un PDF'}
            <input type="file" accept=".pdf" onChange={handleUpload} className="hidden" disabled={uploading} />
          </label>
        </div>
      </div>
    )
  }, [uploading])

  /* Impression QR / Print QR code */
  const handlePrint = () => {
    if (!printRef.current || !qrPdv) return
    const win = window.open('', '_blank', 'width=400,height=500')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><title>QR ${qrPdv.code}</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 40px; }
        .code { font-size: 28px; font-weight: bold; margin: 16px 0 4px; }
        .name { font-size: 16px; color: #666; margin-bottom: 8px; }
        .city { font-size: 14px; color: #999; }
        @media print { body { padding: 20px; } }
      </style></head><body>
      ${printRef.current.innerHTML}
      <script>window.onload=function(){window.print();window.close();}<\/script>
    </body></html>`)
    win.document.close()
  }

  return (
    <>
      <CrudPage<PDV>
        resource="pdvs"
        title={t('pdvs.title')}
        endpoint="/pdvs"
        columns={columns}
        fields={fields}
        searchKeys={['code', 'name', 'city']}
        createTitle={t('pdvs.new')}
        editTitle={t('pdvs.edit')}
        importEntity="pdvs"
        exportEntity="pdvs"
        transformPayload={(d) => {
          const avt = d.allowed_vehicle_types as string[] | undefined
          return {
            ...d,
            region_id: Number(d.region_id),
            allowed_vehicle_types: avt && avt.length > 0 ? avt.join('|') : null,
          }
        }}
        transformInitialData={(d) => ({
          ...d,
          allowed_vehicle_types: d.allowed_vehicle_types ? (d.allowed_vehicle_types as string).split('|') : [],
        })}
        formSize="xl"
        formExtra={formExtra}
      />

      {/* Modale QR PDV / PDV QR code modal */}
      {qrPdv && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setQrPdv(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-secondary)', borderRadius: 12, padding: 32,
              border: '1px solid var(--border-color)', textAlign: 'center', minWidth: 320,
            }}
          >
            <div ref={printRef}>
              <QRCodeSVG value={qrPdv.code} size={200} level="H" />
              <div className="code" style={{ fontSize: 28, fontWeight: 'bold', marginTop: 16 }}>{qrPdv.code}</div>
              <div className="name" style={{ fontSize: 16, color: 'var(--text-secondary)', marginBottom: 4 }}>{qrPdv.name}</div>
              {qrPdv.city && (
                <div className="city" style={{ fontSize: 14, color: 'var(--text-muted)' }}>{qrPdv.address} — {qrPdv.city}</div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'center' }}>
              <button
                onClick={handlePrint}
                style={{
                  padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: 'var(--accent-color)', color: '#fff', fontWeight: 600, fontSize: 14,
                }}
              >
                Imprimer
              </button>
              <button
                onClick={() => setQrPdv(null)}
                style={{
                  padding: '10px 24px', borderRadius: 8, cursor: 'pointer',
                  background: 'none', border: '1px solid var(--border-color)',
                  color: 'var(--text-secondary)', fontWeight: 600, fontSize: 14,
                }}
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale code-barres PDV / PDV barcode modal */}
      {barcodePdv && (
        <PdvBarcodePrint
          pdvCode={barcodePdv.code}
          pdvName={barcodePdv.name}
          pdvCity={barcodePdv.city}
          onClose={() => setBarcodePdv(null)}
        />
      )}
    </>
  )
}
