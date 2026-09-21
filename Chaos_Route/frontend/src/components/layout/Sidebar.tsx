/* Barre latérale de navigation 2 niveaux / Two-level sliding navigation sidebar */

import { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/useAppStore'
import { useAuthStore } from '../../stores/useAuthStore'
import { AboutDialog } from './AboutDialog'
import api from '../../services/api'

interface NavItem {
  path: string
  label: string
  icon: string
  resource: string
  resources?: string[]  // Alternative: visible si au moins un de ces resources est lisible
  superadminOnly?: boolean
}

interface NavGroup {
  key: string
  label: string
  icon: string
  path?: string
  resource?: string
  children?: NavItem[]
  /** Masquer ce groupe pour les utilisateurs PDV / Hide this group for PDV users */
  hideForPdv?: boolean
}

const navGroups: NavGroup[] = [
  { key: 'dashboard', label: 'nav.dashboard', icon: '📊', path: '/', resource: 'dashboard' },
  // Board de tickets transparent — visible par tous (pas de resource) /
  // Transparent ticket board — visible to everyone (no resource gate)
  { key: 'tickets', label: 'Tickets', icon: '🎫', path: '/tickets' },
  {
    key: 'database',
    label: 'nav.database',
    icon: '🗄️',
    hideForPdv: true,
    children: [
      { path: '/countries', label: 'nav.countries', icon: '🌍', resource: 'countries' },
      { path: '/pdvs', label: 'nav.pdvs', icon: '🏪', resource: 'pdvs' },
      { path: '/base-activities', label: 'nav.baseActivities', icon: '🏷️', resource: 'base-activities' },
      { path: '/bases', label: 'nav.bases', icon: '🏭', resource: 'bases' },
      { path: '/loaders', label: 'Chargeurs', icon: '🧑‍🔧', resource: 'loaders' },
      { path: '/base-drivers', label: 'Chauffeurs base', icon: '🚛', resource: 'base-drivers' },
      { path: '/support-types', label: 'Types de support', icon: '📦', resource: 'support-types' },
      { path: '/base-support-rules', label: 'Regles support/base', icon: '🔒', resource: 'support-types' },
      { path: '/surcharge-types', label: 'Types de surcharge', icon: '🏷️', resource: 'surcharge-types' },
      { path: '/distances', label: 'nav.distances', icon: '📏', resource: 'distances' },
      { path: '/km-tax', label: 'nav.kmTax', icon: '💰', resource: 'distances' },
      { path: '/devices', label: 'Appareils', icon: '📱', resource: 'devices' },
      { path: '/carriers', label: 'Transporteurs', icon: '🏢', resource: 'carriers' },
      { path: '/suppliers', label: 'nav.suppliers', icon: '📦', resource: 'suppliers' },
      { path: '/cnuf-temperatures', label: 'CNUF / Temperature', icon: '🌡️', resource: 'cnuf-temperatures' },
    ],
  },
  {
    key: 'transport',
    label: 'nav.transportOps',
    icon: '🚛',
    hideForPdv: true,
    children: [
      { path: '/contracts', label: 'nav.contracts', icon: '📝', resource: 'contracts' },
      { path: '/volumes', label: 'nav.volumes', icon: '📋', resource: 'volumes' },
      { path: '/fuel-prices', label: 'nav.fuelPrices', icon: '⛽', resource: 'fuel-prices' },
      { path: '/tour-planning', label: 'nav.tourPlanning', icon: '🗺️', resource: 'tour-planning' },
      { path: '/tour-history', label: 'nav.tourHistory', icon: '📜', resource: 'tour-history' },
      { path: '/transporter-summary', label: 'nav.transporterSummary', icon: '🧾', resource: 'tour-history' },
      { path: '/aide-decision', label: 'Aide à la décision', icon: '🧠', resource: 'aide-decision' },
      { path: '/collection-requests', label: 'Enlevements fournisseurs', icon: '🚚', resource: 'collection-requests' },
    ],
  },
  {
    key: 'appros',
    label: 'Approvisionnement',
    icon: '📦',
    hideForPdv: true,
    children: [
      { path: '/reception-booking?view=appros', label: 'Booking fournisseurs', icon: '📅', resource: 'booking-appros' },
      { path: '/reception-booking?view=transport', label: 'Enlevements transport', icon: '🚛', resource: 'booking-appros' },
      { path: '/guide-booking', label: 'Guide booking', icon: '📖', resource: 'booking-appros' },
    ],
  },
  {
    key: 'baseOps',
    label: 'nav.baseOps',
    icon: '🏭',
    hideForPdv: true,
    children: [
      { path: '/operations', label: 'nav.postier', icon: '📮', resource: 'operations' },
      { path: '/alerts', label: 'Alertes', icon: '🔔', resource: 'operations' },
      { path: '/tracking', label: 'Suivi chauffeurs', icon: '📡', resource: 'tracking' },
      { path: '/base-reception', label: 'Reception reprises', icon: '📥', resource: 'pickup-requests' },
      { path: '/crate-management', label: 'Gestion casiers', icon: '🍺', resource: 'crate-requests' },
      { path: '/declarations', label: 'Declarations', icon: '⚠', resource: 'declarations' },
      { path: '/waybill-registry', label: 'Registre CMR', icon: '📄', resource: 'waybill-archives' },
      { path: '/temperature', label: 'Controle temperature', icon: '🌡️', resource: 'temperature' },
      { path: '/reception-booking?view=reception', label: 'Reception quais', icon: '📅', resource: 'booking-reception' },
      // ── Contenants — masqué en attente activation (backlog) ──
      // { path: '/consignments', label: 'Suivi consignes', icon: '📊', resource: 'consignment-movements' },
      // { path: '/container-dashboard', label: 'Dashboard contenants', icon: '📊', resource: 'base-container-stock' },
      // { path: '/container-map', label: 'Carte contenants', icon: '🗺️', resource: 'pdv-stock' },
      // { path: '/gic-billing', label: 'Facturation GIC', icon: '💶', resource: 'pdv-stock' },
      // { path: '/base-container-stock', label: 'Stock contenants base', icon: '🏗️', resource: 'base-container-stock' },
      // { path: '/beer-consignments', label: 'Consignes biere', icon: '🍺', resource: 'beer-consignments' },
      // { path: '/container-anomalies', label: 'Anomalies contenants', icon: '⚠', resource: 'container-anomalies' },
      // { path: '/container-prep', label: 'Mise a disposition', icon: '🏗️', resource: 'base-container-stock' },
      // { path: '/bottle-sorting', label: 'Tri vidanges', icon: '🍺', resource: 'bottle-sorting' },
      // { path: '/container-report', label: 'Rapport contenants', icon: '📊', resource: 'base-container-stock' },
      // { path: '/supplier-pickups', label: 'Reprises fournisseurs', icon: '🔄', resource: 'supplier-pickups' },
    ],
  },
  {
    key: 'pdvOps',
    label: 'PDV',
    icon: '🏪',
    children: [
      { path: '/pdv-deliveries', label: 'Planning livraisons', icon: '📅', resource: 'pdvs' },
      { path: '/pickup-requests', label: 'Demandes de reprise', icon: '📋', resource: 'pickup-requests' },
      { path: '/crate-requests', label: 'Demandes de casiers', icon: '🍺', resource: 'crate-requests' },
    ],
  },
  {
    key: 'fleet',
    label: 'Flotte',
    icon: '🚛',
    hideForPdv: true,
    children: [
      { path: '/vehicles', label: 'Vehicules', icon: '🚚', resource: 'vehicles' },
      { path: '/inspections', label: 'Inspections', icon: '🔍', resource: 'inspections' },
      { path: '/fleet', label: 'Gestion flotte', icon: '📊', resource: 'fleet' },
    ],
  },
  {
    key: 'reports',
    label: 'Rapports',
    icon: '📈',
    hideForPdv: true,
    children: [
      { path: '/reports/daily', label: 'Rapport quotidien', icon: '📅', resource: 'reports' },
      { path: '/reports/driver', label: 'Rapport chauffeurs', icon: '🧑', resource: 'reports' },
      { path: '/reports/pdv', label: 'Rapport PDV', icon: '🏪', resource: 'reports' },
      { path: '/reports/vehicle', label: 'Rapport vehicules', icon: '🚚', resource: 'reports' },
    ],
  },
  {
    key: 'guardPost',
    label: 'nav.guardPost',
    icon: '🚧',
    hideForPdv: true,
    children: [
      { path: '/guard-post', label: 'Poste de garde', icon: '🚧', resource: 'guard-post' },
      { path: '/reception-booking?view=gate', label: 'Check-in/out Reception', icon: '📥', resource: 'booking-gate' },
      { path: '/guard-post-delivery', label: 'Check-in/out Livraison', icon: '🚚', resource: 'guard-post' },
    ],
  },
  {
    key: 'admin',
    label: 'nav.admin',
    icon: '⚙️',
    hideForPdv: true,
    children: [
      { path: '/admin/users', label: 'nav.users', icon: '👥', resource: 'users' },
      { path: '/admin/roles', label: 'nav.roles', icon: '🛡️', resource: 'roles' },
      { path: '/parameters', label: 'nav.parameters', icon: '⚙️', resource: 'parameters' },
      { path: '/audit', label: 'nav.auditLog', icon: '📜', resource: 'parameters', superadminOnly: true },
      { path: '/phone-setup', label: 'Guide telephones', icon: '📱', resource: 'devices' },
    ],
  },
]

/* Trouve le groupe contenant la route active / Find group containing active route */
function findGroupForPath(pathname: string): string | null {
  for (const group of navGroups) {
    if (group.children) {
      for (const child of group.children) {
        if (pathname === child.path || pathname.startsWith(child.path + '/')) {
          return group.key
        }
      }
    }
  }
  return null
}

function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { t } = useTranslation()

  return (
    <NavLink
      to={item.path}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm transition-colors ${
          isActive ? 'font-semibold' : ''
        }`
      }
      style={({ isActive }) => ({
        backgroundColor: isActive ? 'var(--bg-tertiary)' : 'transparent',
        color: isActive ? 'var(--color-primary)' : 'var(--text-secondary)',
        justifyContent: collapsed ? 'center' : undefined,
      })}
      title={collapsed ? t(item.label) : undefined}
    >
      <span className="text-base shrink-0">{item.icon}</span>
      {!collapsed && <span className="truncate">{t(item.label)}</span>}
    </NavLink>
  )
}

interface SidebarProps {
  /** Forcer le mode collapsed (ex: fullscreen) / Force collapsed mode */
  forceCollapsed?: boolean
}

export function Sidebar({ forceCollapsed = false }: SidebarProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { sidebarCollapsed, toggleSidebar } = useAppStore()
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const isSuperadmin = useAuthStore((s) => s.user?.is_superadmin ?? false)
  const isPdvUser = useAuthStore((s) => !!s.user?.pdv_id)
  const location = useLocation()

  /* En mode forceCollapsed, toujours collapsed / When forced, always collapsed */
  const isCollapsed = forceCollapsed || sidebarCollapsed

  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [showAbout, setShowAbout] = useState(false)

  /* Compteurs de tickets dans le menu : ouverts (orange, attire le regard) et
     traités (vert). / Ticket counts in the menu: open (orange) + done (green). */
  const [doneTickets, setDoneTickets] = useState(0)
  const [openTickets, setOpenTickets] = useState(0)
  const fetchTicketCounts = () => {
    api.get<{ status: string }[]>('/tickets/')
      .then(({ data }) => {
        const done = data.filter((t) => t.status === 'RESOLVED' || t.status === 'CLOSED').length
        setDoneTickets(done)
        setOpenTickets(data.length - done)
      })
      .catch(() => { /* non-bloquant */ })
  }
  useEffect(() => { fetchTicketCounts() }, [])
  useEffect(() => { if (location.pathname === '/tickets') fetchTicketCounts() }, [location.pathname])

  /* Popover pour groupes en mode collapsed / Popover for groups in collapsed mode */
  const [popoverGroup, setPopoverGroup] = useState<string | null>(null)
  const [popoverY, setPopoverY] = useState(0)
  const popoverRef = useRef<HTMLDivElement>(null)

  /* Auto-détection du groupe actif au montage et à chaque changement de route */
  useEffect(() => {
    const groupKey = findGroupForPath(location.pathname)
    if (groupKey) {
      setActiveGroup(groupKey)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /* Fermer popover sur navigation ou clic en dehors / Close popover on nav or outside click */
  useEffect(() => {
    setPopoverGroup(null)
  }, [location.pathname])

  useEffect(() => {
    if (!popoverGroup) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverGroup(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverGroup])

  /* Filtrage RBAC + superadmin / RBAC filtering + superadmin-only items */
  const canSeeItem = (child: NavItem) => {
    const canRead = child.resources
      ? child.resources.some((r) => hasPermission(r, 'read'))
      : hasPermission(child.resource, 'read')
    return canRead && (!child.superadminOnly || isSuperadmin)
  }

  const visibleGroups = navGroups.filter((group) => {
    if (isPdvUser && group.hideForPdv) return false
    if (group.children) {
      return group.children.some(canSeeItem)
    }
    return group.resource ? hasPermission(group.resource, 'read') : true
  })

  /* Groupe actuellement ouvert / Currently open group */
  const currentGroup = activeGroup ? navGroups.find((g) => g.key === activeGroup) : null
  const visibleChildren = currentGroup?.children?.filter(canSeeItem) ?? []

  /* Groupe popover visible / Popover group children */
  const popoverGroupObj = popoverGroup ? navGroups.find((g) => g.key === popoverGroup) : null
  const popoverChildren = popoverGroupObj?.children?.filter(canSeeItem) ?? []

  /* Gestion du clic sur un groupe L1 / Handle L1 group click */
  const handleGroupClick = (group: NavGroup, e: React.MouseEvent) => {
    if (group.path) {
      return // NavLink gère la navigation
    }
    if (group.children) {
      if (isCollapsed) {
        /* En mode collapsed : afficher popover / In collapsed mode: show popover */
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        setPopoverY(rect.top)
        setPopoverGroup(popoverGroup === group.key ? null : group.key)
      } else {
        setActiveGroup(group.key)
      }
    }
  }

  /* Navigation depuis le popover / Navigate from popover */
  const handlePopoverNav = (path: string) => {
    navigate(path)
    setPopoverGroup(null)
  }

  return (
    <aside
      className="h-screen flex flex-col border-r transition-all duration-300 shrink-0 relative"
      style={{
        width: isCollapsed ? '56px' : '240px',
        backgroundColor: 'var(--sidebar-bg)',
        borderColor: 'var(--border-color)',
      }}
    >
      {/* Logo + toggle */}
      <div className={`${isCollapsed ? 'px-1 py-2' : 'p-3'} flex items-center justify-between border-b transition-all`} style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center gap-2 overflow-hidden">
          <img src="/LogoCMRO.png" alt="CMRO" className="shrink-0 rounded" style={{ width: '48px', height: '48px' }} />
          {!isCollapsed && (
            <div className="flex flex-col items-center leading-tight">
              <span className="font-bold text-base" style={{ color: 'var(--color-primary)' }}>CMRO</span>
              <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>Chaos Manager</span>
              <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Route Optimizer</span>
            </div>
          )}
        </div>
        {/* Masquer toggle en forceCollapsed / Hide toggle when forceCollapsed */}
        {!forceCollapsed && (
          <button
            onClick={toggleSidebar}
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
            title={sidebarCollapsed ? 'Expand' : 'Collapse'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        )}
      </div>

      {/* Navigation glissante / Sliding navigation */}
      <nav className="flex-1 overflow-hidden relative">
        <div
          className="flex h-full"
          style={{
            width: '200%',
            transform: activeGroup && !isCollapsed ? 'translateX(-50%)' : 'translateX(0)',
            transition: 'transform 0.25s ease',
          }}
        >
          {/* Panel L1 — Liste des groupes / Group list */}
          <div className="w-1/2 overflow-y-auto p-1.5">
            {visibleGroups.map((group) =>
              group.path ? (
                /* Lien direct / Direct link */
                <NavLink
                  key={group.key}
                  to={group.path}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm transition-colors ${
                      isActive ? 'font-semibold' : ''
                    }`
                  }
                  style={({ isActive }) => ({
                    backgroundColor: isActive ? 'var(--bg-tertiary)' : 'transparent',
                    color: isActive ? 'var(--color-primary)' : 'var(--text-secondary)',
                    justifyContent: isCollapsed ? 'center' : undefined,
                  })}
                  title={isCollapsed ? t(group.label) : undefined}
                >
                  <span className="text-base shrink-0 relative">
                    {group.icon}
                    {group.key === 'tickets' && (openTickets > 0 || doneTickets > 0) && isCollapsed && (
                      /* Menu réduit : pastille orange si tickets ouverts (prioritaire), sinon verte */
                      <span
                        className="absolute -top-1 -right-1 w-2 h-2 rounded-full"
                        style={{ backgroundColor: openTickets > 0 ? '#f97316' : 'var(--color-success)' }}
                      />
                    )}
                  </span>
                  {!isCollapsed && <span className="truncate">{t(group.label)}</span>}
                  {group.key === 'tickets' && !isCollapsed && (openTickets > 0 || doneTickets > 0) && (
                    <span className="ml-auto shrink-0 inline-flex items-center gap-1">
                      {openTickets > 0 && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ backgroundColor: 'rgba(249,115,22,0.15)', color: '#f97316' }}
                          title={`${openTickets} ticket(s) ouvert(s) ou en cours — cliquez pour les consulter`}
                        >
                          ● {openTickets}
                        </span>
                      )}
                      {doneTickets > 0 && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ backgroundColor: 'rgba(34,197,94,0.15)', color: 'var(--color-success)' }}
                          title={`${doneTickets} ticket(s) résolu(s) ou clôturé(s)`}
                        >
                          ✓ {doneTickets}
                        </span>
                      )}
                    </span>
                  )}
                </NavLink>
              ) : (
                /* Bouton de groupe / Group button */
                <button
                  key={group.key}
                  onClick={(e) => handleGroupClick(group, e)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm transition-colors text-left"
                  style={{
                    backgroundColor: (activeGroup === group.key || popoverGroup === group.key) ? 'var(--bg-tertiary)' : 'transparent',
                    color: (activeGroup === group.key || popoverGroup === group.key) ? 'var(--color-primary)' : 'var(--text-secondary)',
                    justifyContent: isCollapsed ? 'center' : undefined,
                  }}
                  title={isCollapsed ? t(group.label) : undefined}
                >
                  <span className="text-base shrink-0">{group.icon}</span>
                  {!isCollapsed && (
                    <>
                      <span className="truncate flex-1">{t(group.label)}</span>
                      <span className="text-xs opacity-50 shrink-0">›</span>
                    </>
                  )}
                </button>
              )
            )}
          </div>

          {/* Panel L2 — Items du groupe actif / Active group items */}
          <div className="w-1/2 overflow-y-auto p-1.5">
            {currentGroup && (
              <>
                {/* Bouton retour + en-tête groupe / Back button + group header */}
                <button
                  onClick={() => setActiveGroup(null)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg mb-1 text-sm transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <span className="text-base shrink-0">←</span>
                  <span className="truncate">{t('nav.back')}</span>
                </button>
                <div
                  className="flex items-center gap-2 px-3 py-1.5 mb-1 text-xs font-semibold uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <span>{currentGroup.icon}</span>
                  <span className="truncate">{t(currentGroup.label)}</span>
                </div>
                {/* Items L2 */}
                {visibleChildren.map((item) => (
                  <NavItemLink key={item.path} item={item} collapsed={false} />
                ))}
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Bouton À propos / About button */}
      <div className="border-t p-1.5" style={{ borderColor: 'var(--border-color)' }}>
        <button
          onClick={() => setShowAbout(true)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors hover:opacity-80"
          style={{ color: 'var(--text-muted)', justifyContent: isCollapsed ? 'center' : undefined }}
          title={isCollapsed ? 'À propos' : undefined}
        >
          <span className="text-base shrink-0">ℹ️</span>
          {!isCollapsed && <span className="truncate">À propos</span>}
        </button>
      </div>

      <AboutDialog open={showAbout} onClose={() => setShowAbout(false)} />

      {/* Popover flottant pour groupes en mode collapsed / Floating popover for collapsed groups */}
      {popoverGroup && popoverChildren.length > 0 && (
        <div
          ref={popoverRef}
          className="fixed z-50 rounded-lg border shadow-xl py-1 min-w-[180px]"
          style={{
            left: '60px',
            top: `${popoverY}px`,
            backgroundColor: 'var(--bg-secondary)',
            borderColor: 'var(--border-color)',
          }}
        >
          <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            {popoverGroupObj && t(popoverGroupObj.label)}
          </div>
          {popoverChildren.map((item) => {
            const isActive = location.pathname === item.path
            return (
              <button
                key={item.path}
                onClick={() => handlePopoverNav(item.path)}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left hover:opacity-80"
                style={{
                  backgroundColor: isActive ? 'var(--bg-tertiary)' : 'transparent',
                  color: isActive ? 'var(--color-primary)' : 'var(--text-secondary)',
                }}
              >
                <span className="text-base shrink-0">{item.icon}</span>
                <span className="truncate">{t(item.label)}</span>
              </button>
            )
          })}
        </div>
      )}
    </aside>
  )
}
