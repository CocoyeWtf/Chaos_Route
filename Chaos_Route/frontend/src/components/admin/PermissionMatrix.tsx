/* Matrice de permissions par menu/sous-menu / Permission matrix grid organized by menu sections */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/* Structure menu/sous-menu identique au Sidebar / Menu structure matching Sidebar */
interface ResourceGroup {
  key: string
  label: string
  icon: string
  resources: { resource: string; label: string }[]
}

const RESOURCE_GROUPS: ResourceGroup[] = [
  {
    key: 'dashboard', label: 'Tableau de bord', icon: '📊',
    resources: [
      { resource: 'dashboard', label: 'Tableau de bord' },
    ],
  },
  {
    key: 'database', label: 'Base de donnees', icon: '🗄️',
    resources: [
      { resource: 'countries', label: 'Pays / Regions' },
      { resource: 'pdvs', label: 'Points de vente' },
      { resource: 'base-activities', label: 'Activites base' },
      { resource: 'bases', label: 'Bases logistiques' },
      { resource: 'loaders', label: 'Chargeurs' },
      { resource: 'base-drivers', label: 'Chauffeurs base' },
      { resource: 'tour-stop-modify', label: 'Modifier stops tour (live)' },
      { resource: 'support-types', label: 'Types de support' },
      { resource: 'surcharge-types', label: 'Types de surcharge' },
      { resource: 'distances', label: 'Distancier / Taxe km' },
      { resource: 'devices', label: 'Appareils mobiles' },
      { resource: 'carriers', label: 'Transporteurs' },
      { resource: 'suppliers', label: 'Fournisseurs' },
      { resource: 'cnuf-temperatures', label: 'CNUF / Temperature' },
    ],
  },
  {
    key: 'transport', label: 'Transport', icon: '🚛',
    resources: [
      { resource: 'contracts', label: 'Contrats' },
      { resource: 'volumes', label: 'Volumes' },
      { resource: 'tour-planning', label: 'Planning tournees' },
      { resource: 'tour-unschedule', label: 'Retirer planification (deplanifier)' },
      { resource: 'tour-history', label: 'Historique / Synthese transport' },
      { resource: 'aide-decision', label: 'Aide a la decision' },
      { resource: 'surcharges', label: 'Surcharges' },
      { resource: 'collection-requests', label: 'Enlevements fournisseurs' },
    ],
  },
  {
    key: 'baseOps', label: 'Operations base', icon: '🏭',
    resources: [
      { resource: 'operations', label: 'Operations (postier)' },
      { resource: 'tracking', label: 'Suivi chauffeurs' },
      { resource: 'pickup-requests', label: 'Reprises / Reception base' },
      { resource: 'crate-requests', label: 'Demandes de casiers' },
      { resource: 'crate-types', label: 'Types de casiers (admin)' },
      { resource: 'declarations', label: 'Declarations chauffeur' },
      { resource: 'waybill-archives', label: 'Registre CMR' },
      // ── Contenants — masqué en attente activation (backlog) ──
      // { resource: 'consignment-movements', label: 'Suivi consignes' },
      // { resource: 'base-container-stock', label: 'Stock contenants base' },
      // { resource: 'supplier-pickups', label: 'Reprises fournisseurs' },
      // { resource: 'beer-consignments', label: 'Consignes biere' },
      // { resource: 'container-anomalies', label: 'Anomalies contenants' },
      // { resource: 'bottle-sorting', label: 'Tri vidanges' },
      { resource: 'temperature', label: 'Controle temperature' },
      { resource: 'booking-appros', label: 'Booking — Appros' },
      { resource: 'booking-gate', label: 'Booking — Poste de garde' },
      { resource: 'booking-reception', label: 'Booking — Reception' },
    ],
  },
  {
    key: 'pdvOps', label: 'PDV', icon: '🏪',
    resources: [
      // { resource: 'pdv-stock', label: 'Stock contenants PDV' },  // backlog contenants
    ],
  },
  {
    key: 'fleet', label: 'Flotte', icon: '🚚',
    resources: [
      { resource: 'vehicles', label: 'Vehicules' },
      { resource: 'inspections', label: 'Inspections' },
      { resource: 'fleet', label: 'Maintenance / Couts' },
    ],
  },
  {
    key: 'reports', label: 'Rapports', icon: '📈',
    resources: [
      { resource: 'reports', label: 'Tous les rapports' },
    ],
  },
  {
    key: 'guardPost', label: 'Poste de garde', icon: '🚧',
    resources: [
      { resource: 'guard-post', label: 'Poste de garde' },
    ],
  },
  {
    key: 'admin', label: 'Administration', icon: '⚙️',
    resources: [
      { resource: 'users', label: 'Utilisateurs' },
      { resource: 'roles', label: 'Roles' },
      { resource: 'parameters', label: 'Parametres / Prix carburant / Audit' },
      { resource: 'imports-exports', label: 'Imports / Exports' },
    ],
  },
]

/* Liste plate pour les toggles globaux / Flat list for global toggles */
const ALL_RESOURCES = RESOURCE_GROUPS.flatMap((g) => g.resources.map((r) => r.resource))

const ACTIONS = ['read', 'create', 'update', 'delete'] as const
const ACTION_LABELS: Record<string, string> = {
  read: 'Lire',
  create: 'Creer',
  update: 'Modif.',
  delete: 'Suppr.',
}

interface PermissionEntry {
  resource: string
  action: string
}

interface PermissionMatrixProps {
  value: PermissionEntry[]
  onChange: (permissions: PermissionEntry[]) => void
}

/* Checkbox réutilisable / Reusable checkbox */
function Check({ checked, onChange, size = 24 }: { checked: boolean; onChange: () => void; size?: number }) {
  return (
    <label
      className="inline-flex items-center justify-center rounded cursor-pointer transition-all border"
      style={{
        width: size,
        height: size,
        backgroundColor: checked ? 'rgba(249,115,22,0.15)' : 'var(--bg-tertiary)',
        borderColor: checked ? 'var(--color-primary)' : 'var(--border-color)',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only" />
      {checked && <span style={{ color: 'var(--color-primary)', fontSize: size * 0.55 }} className="font-bold">✓</span>}
    </label>
  )
}

export function PermissionMatrix({ value, onChange }: PermissionMatrixProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const has = (resource: string, action: string) =>
    value.some((p) => p.resource === resource && p.action === action)

  const toggle = (resource: string, action: string) => {
    if (has(resource, action)) {
      onChange(value.filter((p) => !(p.resource === resource && p.action === action)))
    } else {
      onChange([...value, { resource, action }])
    }
  }

  const toggleRow = (resource: string) => {
    const allChecked = ACTIONS.every((a) => has(resource, a))
    if (allChecked) {
      onChange(value.filter((p) => p.resource !== resource))
    } else {
      const without = value.filter((p) => p.resource !== resource)
      const added = ACTIONS.map((a) => ({ resource, action: a }))
      onChange([...without, ...added])
    }
  }

  const toggleGroup = (group: ResourceGroup) => {
    const groupResources = group.resources.map((r) => r.resource)
    if (groupResources.length === 0) return
    const allChecked = groupResources.every((r) => ACTIONS.every((a) => has(r, a)))
    if (allChecked) {
      onChange(value.filter((p) => !groupResources.includes(p.resource)))
    } else {
      const without = value.filter((p) => !groupResources.includes(p.resource))
      const added: PermissionEntry[] = []
      groupResources.forEach((r) => ACTIONS.forEach((a) => added.push({ resource: r, action: a })))
      onChange([...without, ...added])
    }
  }

  const toggleGroupCol = (group: ResourceGroup, action: string) => {
    const resources = group.resources.map((r) => r.resource)
    if (resources.length === 0) return
    const colChecked = resources.every((r) => has(r, action))
    if (colChecked) {
      onChange(value.filter((p) => !(resources.includes(p.resource) && p.action === action)))
    } else {
      const without = value.filter((p) => !(resources.includes(p.resource) && p.action === action))
      const added = resources.map((r) => ({ resource: r, action }))
      onChange([...without, ...added])
    }
  }

  /* Les cases « tout » ne doivent agir QUE sur ce qui est affiché. Certaines
     ressources existent au catalogue sans figurer dans la matrice — celles du
     module contenants, encore commentées — et trois rôles en détiennent déjà
     (PDV, Responsable Contenants, Bêta Testeur ont des droits « pdv-stock »).
     Elles étaient effacées en silence au premier clic sur une case « tout »,
     puisque la liste était reconstruite à partir des seules ressources visibles.
     On les préserve donc explicitement. (#21) /
     Bulk toggles must only affect displayed resources: permissions on resources
     absent from the matrix were silently wiped. */
  const isVisible = (resource: string) => ALL_RESOURCES.includes(resource)

  const toggleCol = (action: string) => {
    const allChecked = ALL_RESOURCES.every((r) => has(r, action))
    const without = value.filter((p) => !(p.action === action && isVisible(p.resource)))
    if (allChecked) {
      onChange(without)
    } else {
      onChange([...without, ...ALL_RESOURCES.map((r) => ({ resource: r, action }))])
    }
  }

  const toggleAll = () => {
    const total = ALL_RESOURCES.length * ACTIONS.length
    const visibleCount = value.filter((p) => isVisible(p.resource)).length
    const hidden = value.filter((p) => !isVisible(p.resource))
    if (visibleCount >= total) {
      onChange(hidden)
    } else {
      const all: PermissionEntry[] = []
      ALL_RESOURCES.forEach((r) => ACTIONS.forEach((a) => all.push({ resource: r, action: a })))
      onChange([...hidden, ...all])
    }
  }

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const groupCount = (group: ResourceGroup) => {
    const total = group.resources.length * ACTIONS.length
    let active = 0
    for (const r of group.resources) {
      for (const a of ACTIONS) {
        if (has(r.resource, a)) active++
      }
    }
    return { active, total }
  }

  /* Style de grille : label flexible + 4 colonnes fixes / Grid: flexible label + 4 fixed columns */
  const gridStyle = { display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 60px', alignItems: 'center' }

  return (
    <div>
      {/* En-tete / Header */}
      <div style={gridStyle} className="mb-1">
        <div className="px-2">
          <button
            type="button"
            onClick={toggleAll}
            className="text-xs underline"
            style={{ color: 'var(--color-primary)' }}
          >
            {t('admin.roles.toggleAll')}
          </button>
        </div>
        {ACTIONS.map((action) => (
          <div key={action} className="text-center">
            <button
              type="button"
              onClick={() => toggleCol(action)}
              className="text-xs hover:underline font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              {ACTION_LABELS[action]}
            </button>
          </div>
        ))}
      </div>

      {/* Groupes / Groups */}
      {RESOURCE_GROUPS.map((group) => {
        /* Ticket #21 : un groupe sans ressource ne doit PAS s'afficher. Le groupe
           « PDV » est un emplacement réservé au module contenants, dont les
           ressources sont encore commentées : il s'affichait donc vide, avec le
           compteur 0/0 — et ses quatre cases apparaissaient COCHÉES, parce que
           `[].every(...)` vaut `true` en JavaScript. Le clic recalculait la même
           chose, d'où « coché d'office et impossible à décocher ». /
           An empty group must not render: `[].every(...)` is true, so its column
           checkboxes looked permanently checked and could not be unchecked. */
        if (group.resources.length === 0) return null
        const isCollapsed = collapsed.has(group.key)
        const { active, total } = groupCount(group)
        const allGroupChecked = total > 0 && active === total

        return (
          <div key={group.key} className="mb-0.5">
            {/* En-tete de groupe / Group header */}
            <div
              style={{ ...gridStyle, backgroundColor: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)' }}
              className="rounded-t py-1.5"
            >
              <div className="px-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => toggleCollapse(group.key)}
                  className="text-xs"
                  style={{ color: 'var(--text-muted)', width: '14px', flexShrink: 0 }}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  className="font-semibold text-xs hover:underline flex items-center gap-1"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <span>{group.icon}</span>
                  <span>{group.label}</span>
                </button>
                <span
                  className="text-xs px-1 rounded"
                  style={{
                    fontSize: '10px',
                    backgroundColor: allGroupChecked ? 'rgba(34,197,94,0.15)' : active > 0 ? 'rgba(249,115,22,0.15)' : 'var(--bg-tertiary)',
                    color: allGroupChecked ? '#22c55e' : active > 0 ? 'var(--color-primary)' : 'var(--text-muted)',
                  }}
                >
                  {active}/{total}
                </span>
              </div>
              {ACTIONS.map((action) => {
                const colChecked = group.resources.length > 0
                  && group.resources.every((r) => has(r.resource, action))
                return (
                  <div key={action} className="text-center">
                    <Check checked={colChecked} onChange={() => toggleGroupCol(group, action)} size={22} />
                  </div>
                )
              })}
            </div>

            {/* Sous-elements / Sub-items */}
            {!isCollapsed && group.resources.map((item) => (
              <div
                key={item.resource}
                style={{ ...gridStyle, borderBottom: '1px solid var(--border-color)' }}
                className="py-1"
              >
                <div className="pl-8 pr-2">
                  <button
                    type="button"
                    onClick={() => toggleRow(item.resource)}
                    className="text-xs hover:underline text-left"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {item.label}
                  </button>
                </div>
                {ACTIONS.map((action) => {
                  const checked = has(item.resource, action)
                  return (
                    <div key={action} className="text-center">
                      <Check checked={checked} onChange={() => toggle(item.resource, action)} size={20} />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
