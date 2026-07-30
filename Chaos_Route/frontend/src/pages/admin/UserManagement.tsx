/* Page gestion des utilisateurs / User management page */

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { DataTable, type Column } from '../../components/data/DataTable'
import { FormDialog, type FieldDef } from '../../components/data/FormDialog'
import { ConfirmDialog } from '../../components/data/ConfirmDialog'
import { useApi } from '../../hooks/useApi'
import { create, update, remove } from '../../services/api'
import { DriverBadgeCard } from '../../components/print/DriverBadgeCard'
import { useAuthStore } from '../../stores/useAuthStore'
import type { UserAccount, Role, Region, PDV, Supplier, Tenant } from '../../types'

/* Extrait un message lisible d'une erreur API (ticket #21) : le backend renvoie
   soit un `detail` string (400 : « Username or email already exists »), soit une
   liste de validation Pydantic (422 : politique de mot de passe, champ manquant). */
function extractApiError(err: unknown): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
      .map((m) => m.replace(/^Value error,\s*/i, ''))
      .filter(Boolean)
    if (msgs.length) return msgs.join(' · ')
  }
  return "Échec de l'enregistrement. Vérifiez les champs et réessayez."
}

export default function UserManagement() {
  const { t } = useTranslation()
  const isSuperadmin = useAuthStore((s) => s.user?.is_superadmin ?? false)
  const { data: users, loading, refetch } = useApi<UserAccount>('/users')
  const { data: roles } = useApi<Role>('/roles')
  const { data: regions } = useApi<Region>('/regions')
  const { data: pdvs } = useApi<PDV>('/pdvs')
  const { data: suppliers } = useApi<Supplier>('/suppliers')
  // Sociétés (tenants) : réservé aux superadmins (endpoint 403 sinon) /
  // Tenants list: superadmin only
  const { data: tenants } = useApi<Tenant>(isSuperadmin ? '/tenants' : '')

  const [formOpen, setFormOpen] = useState(false)
  const [editItem, setEditItem] = useState<Record<string, unknown> | undefined>()
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [badgeUser, setBadgeUser] = useState<UserAccount | null>(null)

  const columns: Column<UserAccount>[] = [
    { key: 'username', label: t('admin.users.username'), width: '140px' },
    { key: 'email', label: t('admin.users.email') },
    {
      key: 'roles',
      label: t('admin.users.roles'),
      render: (row) =>
        row.roles.map((r) => r.name).join(', ') || '—',
    },
    {
      key: 'regions',
      label: t('admin.users.regions'),
      render: (row) =>
        row.regions.map((r) => r.name).join(', ') || t('admin.users.allRegions'),
    },
    {
      key: 'is_active',
      label: t('admin.users.active'),
      width: '80px',
      render: (row) => row.is_active ? '✓' : '✗',
    },
    {
      key: 'is_superadmin',
      label: 'Superadmin',
      width: '100px',
      render: (row) => row.is_superadmin ? '✓' : '',
    },
    {
      key: 'badge_code' as keyof UserAccount, label: 'Badge', width: '70px',
      render: (row) => row.badge_code ? (
        <button
          onClick={(e) => { e.stopPropagation(); setBadgeUser(row) }}
          className="px-2 py-1 rounded text-xs font-medium"
          style={{ backgroundColor: 'var(--color-primary)', color: '#fff' }}
          title="Voir badge chauffeur"
        >
          Badge
        </button>
      ) : '—',
    },
  ]

  const fields: FieldDef[] = [
    // Identifiants
    { key: 'username', label: t('admin.users.username'), type: 'text', required: true },
    { key: 'email', label: t('admin.users.email'), type: 'text', required: true },
    {
      key: 'password',
      label: t('admin.users.password'),
      type: 'password',
      required: !editItem?.id,
      placeholder: editItem?.id ? t('admin.users.passwordPlaceholder') : undefined,
      helperText: 'Au moins 12 caractères, avec au moins 3 types parmi : minuscule, majuscule, chiffre, symbole.',
    },
    // Société (tenant) — superadmin uniquement / Tenant — superadmin only
    ...(isSuperadmin ? [{
      key: 'tenant_id',
      label: 'Société (pays)',
      type: 'select' as const,
      options: [
        { value: '', label: '— Belgique (défaut) —' },
        ...tenants.map((tn) => ({ value: String(tn.id), label: `${tn.code} — ${tn.name}` })),
      ],
      helperText: 'Cloisonnement multi-société : l\'utilisateur ne verra que les données de cette société.',
    }] : []),
    {
      key: 'pdv_id',
      label: 'PDV lié',
      type: 'select',
      options: [
        { value: '', label: '— Aucun —' },
        ...pdvs.map((p) => ({ value: String(p.id), label: `${p.code} — ${p.name}` })),
      ],
    },
    {
      key: 'supplier_id',
      label: 'Fournisseur lie',
      type: 'select',
      options: [
        { value: '', label: '— Aucun —' },
        ...suppliers.map((s) => ({ value: String(s.id), label: `${s.code} — ${s.name}` })),
      ],
    },
    {
      key: 'default_route',
      label: 'Page d\'accueil',
      type: 'select',
      options: [
        { value: '', label: '— Par defaut (Tableau de bord) —' },
        { value: '/', label: 'Tableau de bord' },
        { value: '/tour-planning', label: 'Planning tournees' },
        { value: '/tour-history', label: 'Historique tournees' },
        { value: '/operations', label: 'Operations (postier)' },
        { value: '/tracking', label: 'Suivi chauffeurs' },
        { value: '/guard-post', label: 'Poste de garde' },
        { value: '/pickup-requests', label: 'Demandes de reprise' },
        { value: '/base-reception', label: 'Reception reprises' },
        { value: '/pdv-deliveries', label: 'Planning livraisons PDV' },
        { value: '/pdv-stock', label: 'Stock contenants PDV' },
        { value: '/volumes', label: 'Volumes' },
        { value: '/vehicles', label: 'Vehicules' },
        { value: '/base-container-stock', label: 'Stock contenants base' },
        { value: '/supplier-pickups', label: 'Reprises fournisseurs' },
        { value: '/collection-requests', label: 'Enlevements fournisseurs' },
        { value: '/temperature', label: 'Controle temperature' },
        { value: '/reception-booking', label: 'Booking reception' },
      ],
    },
    // Statut
    { key: 'is_active', label: t('admin.users.active'), type: 'checkbox', defaultValue: true },
    { key: 'is_superadmin', label: 'Superadmin', type: 'checkbox' },
    // Permissions
    {
      key: 'role_ids',
      label: t('admin.users.roles'),
      type: 'multicheck',
      getOptions: () => roles.map((r) => ({ value: String(r.id), label: r.name })),
    },
    {
      key: 'region_ids',
      label: t('admin.users.regions'),
      type: 'multicheck',
      getOptions: () => regions.map((r) => ({ value: String(r.id), label: r.name })),
    },
  ]

  const handleCreate = () => {
    setEditItem(undefined)
    setFormError(null)
    setFormOpen(true)
  }

  const handleEdit = (row: UserAccount) => {
    setFormError(null)
    setEditItem({
      ...row,
      role_ids: row.roles.map((r) => String(r.id)),
      region_ids: row.regions.map((r) => String(r.id)),
      tenant_id: row.tenant_id ? String(row.tenant_id) : '',
      pdv_id: row.pdv_id ? String(row.pdv_id) : '',
      supplier_id: (row as unknown as Record<string, unknown>).supplier_id ? String((row as unknown as Record<string, unknown>).supplier_id) : '',
      default_route: (row as unknown as Record<string, unknown>).default_route || '',
      password: '',
    })
    setFormOpen(true)
  }

  const handleSave = useCallback(async (formData: Record<string, unknown>) => {
    setSaving(true)
    setFormError(null)
    try {
      const pdvIdVal = formData.pdv_id ? Number(formData.pdv_id) : null
      const supplierIdVal = formData.supplier_id ? Number(formData.supplier_id) : null
      const payload: Record<string, unknown> = {
        username: formData.username,
        email: formData.email,
        is_active: formData.is_active ?? true,
        is_superadmin: formData.is_superadmin ?? false,
        role_ids: ((formData.role_ids as string[]) || []).map(Number),
        region_ids: ((formData.region_ids as string[]) || []).map(Number),
        pdv_id: pdvIdVal,
        supplier_id: supplierIdVal,
        default_route: (formData.default_route as string) || null,
      }
      // Société (tenant) — n'est envoyé/appliqué que pour les superadmins / Tenant — superadmin only
      if (isSuperadmin) {
        payload.tenant_id = formData.tenant_id ? Number(formData.tenant_id) : null
      }
      // N'envoyer le password que s'il est rempli / Only send password if filled
      const pwd = (formData.password as string | null) ?? ''
      if (pwd.trim().length > 0) {
        payload.password = pwd
      }

      if (editItem?.id) {
        await update<UserAccount>('/users', editItem.id as number, payload as Partial<UserAccount>)
      } else {
        await create<UserAccount>('/users', payload as Partial<UserAccount>)
      }
      setFormOpen(false)
      setEditItem(undefined)
      refetch()
    } catch (err) {
      // Ticket #21 : ne plus avaler l'erreur (création silencieuse). On affiche le
      // message serveur (doublon, politique de mot de passe…) et on garde le
      // dialogue ouvert pour correction. / Surface the error, keep the dialog open.
      setFormError(extractApiError(err))
    } finally {
      setSaving(false)
    }
  }, [editItem, refetch])

  const handleDelete = useCallback(async () => {
    if (deleteId == null) return
    setSaving(true)
    try {
      await remove('/users', deleteId)
      setDeleteId(null)
      refetch()
    } finally {
      setSaving(false)
    }
  }, [deleteId, refetch])

  return (
    <div>
      <DataTable<UserAccount>
        title={t('admin.users.title')}
        columns={columns}
        data={users}
        loading={loading}
        searchable
        searchKeys={['username', 'email']}
        onCreate={handleCreate}
        onEdit={handleEdit}
        onDelete={(row) => setDeleteId(row.id)}
      />

      <FormDialog
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditItem(undefined); setFormError(null) }}
        onSubmit={handleSave}
        title={editItem?.id ? t('admin.users.edit') : t('admin.users.new')}
        fields={fields}
        initialData={editItem}
        loading={saving}
        error={formError}
        size="md"
      />

      <ConfirmDialog
        open={deleteId != null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title={t('common.deleteTitle')}
        message={t('common.deleteConfirm')}
        loading={saving}
      />

      {/* Modal badge chauffeur / Driver badge modal */}
      {badgeUser && badgeUser.badge_code && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999 }}
          onClick={() => setBadgeUser(null)}
        >
          <div
            className="rounded-xl p-6"
            style={{ backgroundColor: 'var(--bg-primary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <DriverBadgeCard
              badgeCode={badgeUser.badge_code}
              username={badgeUser.username}
              roleName={badgeUser.roles.map((r) => r.name).join(', ') || undefined}
              onClose={() => setBadgeUser(null)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
