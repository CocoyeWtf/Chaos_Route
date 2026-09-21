/* Page gestion appareils mobiles / Mobile device management page */

import { useState, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import api from '../services/api'
import { ConfirmDialog } from '../components/data/ConfirmDialog'
import type { MobileDevice, BaseLogistics, PDV } from '../types'

/** URL publique HTTPS du backend / Public HTTPS backend URL.
 *  Utilise le domaine HTTPS pour que le telechargement APK fonctionne sur Android */
function getServerBaseUrl(): string {
  // En production (HTTPS), utiliser l'URL courante ; sinon fallback sur le domaine
  if (window.location.protocol === 'https:') {
    return `${window.location.protocol}//${window.location.host}`
  }
  return 'https://chaosroute.chaosmanager.tech'
}

type ConfirmActionType = 'deactivate' | 'hardDelete' | 'resetIdentity'

const DEVICE_PROFILES = [
  { key: 'DRIVER', label: 'Chauffeur', desc: 'Tours, reprises, declarations' },
  { key: 'BASE_RECEPTION', label: 'Reception base', desc: 'Scanner reception base' },
  { key: 'INVENTORY', label: 'Inventaire', desc: 'Inventaire PDV et base' },
  { key: 'PDV', label: 'PDV (magasin)', desc: 'Tablette magasin : declaration contenants (sans inventaire base)' },
] as const

export default function DeviceManagement() {
  const [devices, setDevices] = useState<MobileDevice[]>([])
  const [bases, setBases] = useState<BaseLogistics[]>([])
  const [pdvs, setPdvs] = useState<PDV[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ friendly_name: '', imei: '', base_id: '' as string, pdv_id: '' as string, profile: 'DRIVER' })
  const [qrDevice, setQrDevice] = useState<MobileDevice | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState({ friendly_name: '', imei: '', base_id: '' as string, pdv_id: '' as string, profile: 'DRIVER', control_mode: '' as string })
  const [serverUrl, setServerUrl] = useState(() => getServerBaseUrl())
  const [confirmAction, setConfirmAction] = useState<{ type: ConfirmActionType; deviceId: number; deviceName: string } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    api.get('/bases/').then((r) => setBases(r.data)).catch(() => {})
    api.get('/pdvs/').then((r) => setPdvs(r.data)).catch(() => {})
  }, [])

  const loadDevices = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get<MobileDevice[]>('/devices/')
      setDevices(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadDevices() }, [loadDevices])

  const handleCreate = async () => {
    try {
      const { data } = await api.post<MobileDevice>('/devices/', {
        friendly_name: form.friendly_name || null,
        imei: form.imei || null,
        base_id: form.base_id ? Number(form.base_id) : null,
        pdv_id: form.profile === 'PDV' && form.pdv_id ? Number(form.pdv_id) : null,
        profile: form.profile,
      })
      setForm({ friendly_name: '', imei: '', base_id: '', pdv_id: '', profile: 'DRIVER' })
      setShowCreate(false)
      setQrDevice(data)
      loadDevices()
    } catch (e: unknown) {
      const raw = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      const msg = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : 'Erreur lors de la creation'
      alert(msg)
    }
  }

  const handleUpdate = async (id: number) => {
    try {
      await api.put(`/devices/${id}`, {
        friendly_name: editForm.friendly_name || null,
        imei: editForm.imei || null,
        base_id: editForm.base_id ? Number(editForm.base_id) : null,
        pdv_id: editForm.profile === 'PDV' && editForm.pdv_id ? Number(editForm.pdv_id) : null,
        profile: editForm.profile,
        control_mode: editForm.control_mode === '' ? null : editForm.control_mode === 'true',
      })
      setEditingId(null)
      loadDevices()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur lors de la modification'
      alert(msg)
    }
  }

  const handleDeactivate = async (id: number) => {
    try {
      await api.delete(`/devices/${id}`)
      loadDevices()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur lors de la desactivation'
      alert(msg)
    }
  }

  const handleReactivate = async (id: number) => {
    try {
      await api.put(`/devices/${id}`, { is_active: true })
      loadDevices()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur lors de la reactivation'
      alert(msg)
    }
  }

  const handleHardDelete = async (id: number) => {
    try {
      await api.delete(`/devices/${id}`, { params: { hard: true } })
      loadDevices()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur lors de la suppression'
      alert(msg)
    }
  }

  const handleResetIdentity = async (id: number) => {
    try {
      await api.post(`/devices/${id}/reset-identity`)
      loadDevices()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Erreur lors de la reinitialisation'
      alert(msg)
    }
  }

  const executeConfirmedAction = async () => {
    if (!confirmAction) return
    setActionLoading(true)
    try {
      switch (confirmAction.type) {
        case 'deactivate':
          await handleDeactivate(confirmAction.deviceId)
          break
        case 'hardDelete':
          await handleHardDelete(confirmAction.deviceId)
          break
        case 'resetIdentity':
          await handleResetIdentity(confirmAction.deviceId)
          break
      }
    } finally {
      setActionLoading(false)
      setConfirmAction(null)
    }
  }

  const startEdit = (d: MobileDevice) => {
    setEditingId(d.id)
    setEditForm({
      friendly_name: d.friendly_name || '',
      imei: d.imei || '',
      base_id: d.base_id ? String(d.base_id) : '',
      pdv_id: d.pdv_id ? String(d.pdv_id) : '',
      profile: d.profile || 'DRIVER',
      control_mode: d.control_mode === true ? 'true' : d.control_mode === false ? 'false' : '',
    })
  }

  const profileLabel = (profile: string | null | undefined): string => {
    return DEVICE_PROFILES.find((p) => p.key === (profile || 'DRIVER'))?.label || profile || 'Chauffeur'
  }

  const baseName = (id: number | null | undefined) => {
    if (!id) return '—'
    const b = bases.find((x) => x.id === id)
    return b ? `${b.code} — ${b.name}` : `#${id}`
  }

  const isRegistered = (d: MobileDevice) => !!d.device_identifier

  const confirmMessages: Record<ConfirmActionType, { title: string; message: string }> = {
    deactivate: {
      title: 'Desactiver l\'appareil',
      message: `Desactiver "${confirmAction?.deviceName || ''}" ? L'appareil ne pourra plus se connecter. Vous pourrez le reactiver plus tard.`,
    },
    hardDelete: {
      title: 'Supprimer definitivement',
      message: `Supprimer definitivement "${confirmAction?.deviceName || ''}" ? Cette action est irreversible. Toutes les donnees liees seront perdues.`,
    },
    resetIdentity: {
      title: 'Reinitialiser l\'identite',
      message: `Reinitialiser l'identite physique de "${confirmAction?.deviceName || ''}" ? Un nouveau telephone pourra s'enregistrer avec le meme code.`,
    },
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Gestion des appareils
        </h1>
        <button
          onClick={() => { setShowCreate(true); setForm({ friendly_name: '', imei: '', base_id: '', pdv_id: '', profile: 'DRIVER' }) }}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-80"
          style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
        >
          + Ajouter un appareil
        </button>
      </div>

      {/* Formulaire creation / Create form */}
      {showCreate && (
        <div className="mb-4 p-4 rounded-xl border" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Nouvel appareil</h3>
          <div className="grid grid-cols-5 gap-3 mb-3">
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Nom de l'appareil</label>
              <input type="text" value={form.friendly_name} onChange={(e) => setForm({ ...form, friendly_name: e.target.value })}
                placeholder="Ex: Phone-01"
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>N° IMEI</label>
              <input type="text" value={form.imei} onChange={(e) => setForm({ ...form, imei: e.target.value.replace(/\D/g, '').slice(0, 15) })}
                placeholder="Ex: 355321082345678"
                maxLength={15}
                className="w-full px-3 py-2 rounded-lg border text-sm font-mono"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
              <span className="text-[10px] mt-0.5 block" style={{ color: 'var(--text-muted)' }}>15 chiffres — taper *#06# sur le telephone</span>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Base</label>
              <select value={form.base_id} onChange={(e) => setForm({ ...form, base_id: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                <option value="">—</option>
                {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Profil</label>
              <select value={form.profile} onChange={(e) => setForm({ ...form, profile: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border text-sm"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                {DEVICE_PROFILES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <span className="text-[10px] mt-0.5 block" style={{ color: 'var(--text-muted)' }}>
                {DEVICE_PROFILES.find((p) => p.key === form.profile)?.desc}
              </span>
            </div>
            {form.profile === 'PDV' && (
              <div>
                <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Magasin (PDV)</label>
                <select value={form.pdv_id} onChange={(e) => setForm({ ...form, pdv_id: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border text-sm"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                  <option value="">— Choisir le magasin —</option>
                  {pdvs.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                </select>
                <span className="text-[10px] mt-0.5 block" style={{ color: 'var(--text-muted)' }}>La tablette n'accedera qu'a ce magasin (declaration contenants).</span>
              </div>
            )}
            <div className="flex items-end gap-2">
              <button onClick={handleCreate}
                className="px-4 py-2 rounded-lg text-sm font-semibold"
                style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}>Creer</button>
              <button onClick={() => setShowCreate(false)}
                className="px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>Annuler</button>
            </div>
          </div>
        </div>
      )}

      {/* Modale QR Code / QR Code modal */}
      {qrDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="rounded-2xl p-6 max-w-md w-full mx-4 text-center" style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
            <h2 className="text-lg font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
              {qrDevice.friendly_name || 'Nouvel appareil'}
            </h2>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Scannez ce QR code avec le telephone pour installer l'app et enregistrer l'appareil
            </p>

            {/* URL serveur editable / Editable server URL */}
            <div className="mb-3">
              <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>URL serveur (accessible depuis le telephone)</label>
              <input
                type="text" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
                className="w-full px-2 py-1.5 rounded border text-xs text-center font-mono"
                style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
              />
            </div>

            {/* QR Code — contient l'URL de setup / Contains setup URL */}
            <div className="flex justify-center mb-3">
              <div className="bg-white p-4 rounded-xl">
                <QRCodeSVG
                  value={`${serverUrl}/app/setup/${qrDevice.registration_code}`}
                  size={200}
                  level="M"
                />
              </div>
            </div>

            <div className="text-xs font-mono mb-3 break-all" style={{ color: 'var(--text-muted)' }}>
              {serverUrl}/app/setup/{qrDevice.registration_code}
            </div>

            {/* Code lisible / Readable code */}
            <div className="mb-3">
              <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Code d'enregistrement</span>
              <div className="font-mono text-2xl font-bold tracking-widest mt-1" style={{ color: 'var(--color-primary)' }}>
                {qrDevice.registration_code}
              </div>
            </div>

            <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
              1. Scanner ce QR avec la camera du telephone<br />
              2. Telecharger et installer l'app CMRO Driver<br />
              3. Ouvrir l'app et saisir le code ci-dessus<br />
              4. L'appareil est enregistre
            </p>

            <button
              onClick={() => setQrDevice(null)}
              className="px-6 py-2 rounded-lg text-sm font-semibold"
              style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
            >
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* Tableau / Table */}
      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Chargement...</p>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-tertiary)' }}>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Nom</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>IMEI</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Statut</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Identifiant</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Base</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Profil</th>
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Controle</th>
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Actif</th>
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr
                  key={d.id}
                  className="border-t"
                  style={{
                    borderColor: 'var(--border-color)',
                    opacity: d.is_active ? 1 : 0.55,
                  }}
                >
                  {editingId === d.id ? (
                    <>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <input type="text" value={editForm.friendly_name} onChange={(e) => setEditForm({ ...editForm, friendly_name: e.target.value })}
                          className="w-full px-2 py-1 rounded border text-xs"
                          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <input type="text" value={editForm.imei} onChange={(e) => setEditForm({ ...editForm, imei: e.target.value.replace(/\D/g, '').slice(0, 15) })}
                          maxLength={15} placeholder="IMEI"
                          className="w-full px-2 py-1 rounded border text-xs font-mono"
                          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {isRegistered(d)
                          ? <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#22c55e22', color: '#22c55e' }}>Enregistre</span>
                          : <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#f59e0b22', color: '#f59e0b' }}>En attente</span>
                        }
                      </td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{d.device_identifier || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <select value={editForm.base_id} onChange={(e) => setEditForm({ ...editForm, base_id: e.target.value })}
                          className="w-full px-2 py-1 rounded border text-xs"
                          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                          <option value="">—</option>
                          {bases.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select value={editForm.profile} onChange={(e) => setEditForm({ ...editForm, profile: e.target.value })}
                          className="w-full px-2 py-1 rounded border text-xs"
                          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                          {DEVICE_PROFILES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                        </select>
                        {editForm.profile === 'PDV' && (
                          <select value={editForm.pdv_id} onChange={(e) => setEditForm({ ...editForm, pdv_id: e.target.value })}
                            className="w-full mt-1 px-2 py-1 rounded border text-xs"
                            style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                            <option value="">— Magasin —</option>
                            {pdvs.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <select value={editForm.control_mode} onChange={(e) => setEditForm({ ...editForm, control_mode: e.target.value })}
                          className="px-2 py-1 rounded border text-xs"
                          style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
                          <option value="">Herite</option>
                          <option value="true">Actif</option>
                          <option value="false">Inactif</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">{d.is_active ? '✓' : '✗'}</td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <button onClick={() => handleUpdate(d.id)} className="text-xs font-semibold mr-2" style={{ color: 'var(--color-primary)' }}>OK</button>
                        <button onClick={() => setEditingId(null)} className="text-xs" style={{ color: 'var(--text-muted)' }}>Annuler</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 font-semibold whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{d.friendly_name || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{d.imei || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {isRegistered(d)
                          ? <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#22c55e22', color: '#22c55e' }}>Enregistre</span>
                          : <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#f59e0b22', color: '#f59e0b' }}>En attente</span>
                        }
                        {/* Version ET build (#14) : le nom de version seul ne distingue
                            pas les builds 11 à 14, tous appelés « 1.9.3 » — impossible
                            de savoir si une tablette avait pris la mise à jour. Le
                            build n'apparaît qu'à partir des apps qui le remontent. */}
                        {d.app_version && (
                          <div className="text-[10px] mt-0.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                            v{d.app_version}{d.app_build != null ? ` (build ${d.app_build})` : ' (build inconnu)'}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{d.device_identifier || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{baseName(d.base_id)}</td>
                      <td className="px-3 py-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{profileLabel(d.profile)}</td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {d.control_mode === true ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#f59e0b22', color: '#f59e0b' }}>Actif</span>
                        ) : d.control_mode === false ? (
                          <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>Inactif</span>
                        ) : (
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: d.is_active ? '#22c55e' : 'var(--color-danger)' }}>
                        {d.is_active ? '✓' : '✗'}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {d.is_active ? (
                          <>
                            {/* Actif : QR + Modifier + (Reinitialiser si enregistre) + Desactiver/Supprimer */}
                            <button onClick={() => setQrDevice(d)} className="text-xs font-semibold mr-2" style={{ color: 'var(--color-primary)' }}
                              title="Afficher le QR code">
                              QR
                            </button>
                            <button onClick={() => startEdit(d)} className="text-xs font-semibold mr-2" style={{ color: 'var(--text-secondary)' }}>Modifier</button>
                            {isRegistered(d) ? (
                              <>
                                <button
                                  onClick={() => setConfirmAction({ type: 'resetIdentity', deviceId: d.id, deviceName: d.friendly_name || `#${d.id}` })}
                                  className="text-xs font-semibold mr-2"
                                  style={{ color: '#f59e0b' }}
                                >
                                  Reinitialiser
                                </button>
                                <button
                                  onClick={() => setConfirmAction({ type: 'deactivate', deviceId: d.id, deviceName: d.friendly_name || `#${d.id}` })}
                                  className="text-xs font-semibold"
                                  style={{ color: 'var(--color-danger)' }}
                                >
                                  Desactiver
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => setConfirmAction({ type: 'hardDelete', deviceId: d.id, deviceName: d.friendly_name || `#${d.id}` })}
                                className="text-xs font-semibold"
                                style={{ color: 'var(--color-danger)' }}
                              >
                                Supprimer
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            {/* Inactif : Reactiver + Supprimer */}
                            <button
                              onClick={() => handleReactivate(d.id)}
                              className="text-xs font-semibold mr-2"
                              style={{ color: '#22c55e' }}
                            >
                              Reactiver
                            </button>
                            <button
                              onClick={() => setConfirmAction({ type: 'hardDelete', deviceId: d.id, deviceName: d.friendly_name || `#${d.id}` })}
                              className="text-xs font-semibold"
                              style={{ color: 'var(--color-danger)' }}
                            >
                              Supprimer
                            </button>
                          </>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {devices.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                    Aucun appareil enregistre — cliquez sur "Ajouter" pour creer un appareil
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Modale de confirmation / Confirmation modal */}
      <ConfirmDialog
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={executeConfirmedAction}
        title={confirmAction ? confirmMessages[confirmAction.type].title : ''}
        message={confirmAction ? confirmMessages[confirmAction.type].message : ''}
        loading={actionLoading}
        danger={confirmAction?.type !== 'resetIdentity'}
      />
    </div>
  )
}
