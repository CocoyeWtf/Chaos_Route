/* En-tête de l'application / Application header */

import { useState, useMemo, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/useAppStore'
import { useAuthStore } from '../../stores/useAuthStore'
import { useMapStore } from '../../stores/useMapStore'
import { MfaDialog } from '../auth/MfaDialog'
import { ReportButton } from '../support/ReportButton'
import { useApi } from '../../hooks/useApi'
import api from '../../services/api'
import type { Country, Region, PDV, BaseLogistics } from '../../types'

const languages = [
  { code: 'fr', label: 'FR' },
  { code: 'en', label: 'EN' },
  { code: 'pt', label: 'PT' },
  { code: 'nl', label: 'NL' },
]

export function Header() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { theme, toggleTheme, setLanguage, selectedCountryId, selectedRegionId, setSelectedRegion, setScope } = useAppStore()
  const { user } = useAuthStore()
  const { setCenter, setZoom } = useMapStore()
  const [showScope, setShowScope] = useState(false)
  const scopeRef = useRef<HTMLDivElement>(null)
  const [showPwdDialog, setShowPwdDialog] = useState(false)
  const [showMfaDialog, setShowMfaDialog] = useState(false)
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdConfirm, setPwdConfirm] = useState('')
  const [pwdLoading, setPwdLoading] = useState(false)
  const [pwdError, setPwdError] = useState<string | null>(null)
  const [pwdSuccess, setPwdSuccess] = useState(false)

  const { data: countries } = useApi<Country>('/countries')
  const { data: allRegions } = useApi<Region>('/regions')
  const { data: pdvs } = useApi<PDV>('/pdvs')
  const { data: bases } = useApi<BaseLogistics>('/bases')

  /* Fermer le popup si clic en dehors / Close popup on outside click */
  useEffect(() => {
    if (!showScope) return
    const handleClick = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) setShowScope(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showScope])

  /* Régions filtrées par pays / Regions filtered by country */
  const regions = useMemo(() => {
    if (!selectedCountryId) return allRegions
    return allRegions.filter((r) => r.country_id === selectedCountryId)
  }, [allRegions, selectedCountryId])

  /* Cohérence du périmètre persisté : si la région choisie n'appartient pas au
     pays sélectionné (ou n'est plus visible par l'utilisateur), on réaligne le
     pays dessus ou on réinitialise. Évite l'état "pays sans région cohérente"
     (cause de listes/carte vides). / Keep persisted scope coherent. */
  useEffect(() => {
    if (selectedRegionId == null || allRegions.length === 0) return
    const region = allRegions.find((r) => r.id === selectedRegionId)
    if (!region) {
      setScope(null, null)            // région inconnue (autre tenant) -> reset
    } else if (region.country_id !== selectedCountryId) {
      setScope(region.country_id, selectedRegionId)  // aligner le pays sur la région
    }
  }, [allRegions, selectedRegionId, selectedCountryId, setScope])

  /* Noms pour l'indicateur / Names for the indicator */
  const countryName = countries.find((c) => c.id === selectedCountryId)?.name
  const regionName = allRegions.find((r) => r.id === selectedRegionId)?.name
  const scopeLabel = regionName || countryName || t('parameters.global')

  /* Calculer le centre et zoom d'un groupe de points / Compute center & zoom for a set of points */
  const zoomToPoints = (points: { latitude?: number | null; longitude?: number | null }[]) => {
    const valid = points.filter((p) => p.latitude && p.longitude) as { latitude: number; longitude: number }[]
    if (valid.length === 0) return
    const lats = valid.map((p) => p.latitude)
    const lngs = valid.map((p) => p.longitude)
    setCenter([(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2])
    const maxRange = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs))
    setZoom(maxRange > 10 ? 5 : maxRange > 5 ? 6 : maxRange > 2 ? 7 : maxRange > 1 ? 8 : maxRange > 0.5 ? 9 : maxRange > 0.1 ? 11 : 13)
  }

  const handleCountryChange = (countryId: number | null) => {
    if (!countryId) {
      setScope(null, null)
      return
    }
    // Imposer une région cohérente avec le pays : auto-sélection si une seule
    // région, sinon laisser vide (l'utilisateur DOIT en choisir une). /
    // Force a region coherent with the country.
    const countryRegions = allRegions.filter((r) => r.country_id === countryId)
    const autoRegionId = countryRegions.length === 1 ? countryRegions[0].id : null
    setScope(countryId, autoRegionId)
    const ids = new Set(countryRegions.map((r) => r.id))
    zoomToPoints([...pdvs.filter((p) => ids.has(p.region_id)), ...bases.filter((b) => ids.has(b.region_id))])
  }

  const handleRegionChange = (regionId: number | null) => {
    if (!regionId) {
      // Ne pas casser la cohérence : garder le pays courant / Keep current country
      setSelectedRegion(null)
      return
    }
    // La région porte son pays : on aligne le pays sélectionné dessus. /
    // Keep country aligned with the chosen region.
    const region = allRegions.find((r) => r.id === regionId)
    setScope(region?.country_id ?? selectedCountryId ?? null, regionId)
    zoomToPoints([...pdvs.filter((p) => p.region_id === regionId), ...bases.filter((b) => b.region_id === regionId)])
  }

  const handleLogout = async () => {
    /* Révocation serveur des jetons (STIME A4) puis nettoyage local */
    const { logoutEverywhere } = await import('../../services/api')
    await logoutEverywhere()
    navigate('/login')
  }

  const closePwdDialog = () => {
    setShowPwdDialog(false)
    setPwdCurrent('')
    setPwdNew('')
    setPwdConfirm('')
    setPwdError(null)
    setPwdSuccess(false)
  }

  const handleChangePassword = async () => {
    setPwdError(null)
    if (pwdNew.length < 12) {
      setPwdError('Le nouveau mot de passe doit contenir au moins 12 caractères (14 pour un administrateur)')
      return
    }
    if (pwdNew !== pwdConfirm) {
      setPwdError('Les mots de passe ne correspondent pas')
      return
    }
    setPwdLoading(true)
    try {
      await api.put('/auth/change-password', {
        current_password: pwdCurrent,
        new_password: pwdNew,
      })
      setPwdSuccess(true)
      setTimeout(closePwdDialog, 1500)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setPwdError(msg || 'Erreur lors du changement de mot de passe')
    } finally {
      setPwdLoading(false)
    }
  }

  return (
    <header
      className="h-14 flex items-center justify-between px-4 border-b"
      style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
    >
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('app.title')}
        </h1>

        {/* Séparateur / Divider */}
        <div className="h-5 w-px" style={{ backgroundColor: 'var(--border-color)' }} />

        {/* Indicateur périmètre compact / Compact scope indicator */}
        <div className="relative" ref={scopeRef}>
          <button
            onClick={() => setShowScope((v) => !v)}
            className="h-8 inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors hover:opacity-80"
            style={{
              backgroundColor: (selectedCountryId || selectedRegionId) ? 'rgba(249,115,22,0.1)' : 'var(--bg-tertiary)',
              borderColor: (selectedCountryId || selectedRegionId) ? 'var(--color-primary)' : 'var(--border-color)',
              color: (selectedCountryId || selectedRegionId) ? 'var(--color-primary)' : 'var(--text-secondary)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            {scopeLabel}
          </button>

          {showScope && (
            <div
              className="absolute left-0 top-full mt-1 z-50 rounded-lg border shadow-lg p-3 min-w-[220px] space-y-3"
              style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
            >
              {/* Pays / Country */}
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
                  {t('common.country')}
                </label>
                <select
                  value={selectedCountryId ?? ''}
                  onChange={(e) => handleCountryChange(e.target.value ? Number(e.target.value) : null)}
                  className="w-full rounded-lg border px-2 py-1.5 text-sm"
                  style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                >
                  <option value="">— {t('parameters.global')} —</option>
                  {countries.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Région / Region */}
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
                  {t('common.region')}
                  {selectedCountryId != null && <span style={{ color: 'var(--color-danger)' }}> *</span>}
                </label>
                <select
                  value={selectedRegionId ?? ''}
                  onChange={(e) => handleRegionChange(e.target.value ? Number(e.target.value) : null)}
                  className="w-full rounded-lg border px-2 py-1.5 text-sm"
                  style={{
                    backgroundColor: 'var(--bg-primary)',
                    /* Bordure d'alerte tant qu'aucune région n'est choisie pour le pays / Warn until a region is picked */
                    borderColor: selectedCountryId != null && selectedRegionId == null ? 'var(--color-danger)' : 'var(--border-color)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {/* Pas de pays : la région agit comme filtre libre. Pays choisi :
                      une région est obligatoire (placeholder explicite). */}
                  <option value="">
                    {selectedCountryId != null ? `— ${t('common.region')} ? —` : `— ${t('common.filter')} —`}
                  </option>
                  {regions.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
                {selectedCountryId != null && selectedRegionId == null && (
                  <p className="text-[10px] mt-1" style={{ color: 'var(--color-danger)' }}>
                    Choisissez une région pour afficher les données de ce pays.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        {/* Bouton « Signaler » + enregistrement (ticket #16 : déplacé ici, à
            gauche du sélecteur de langue, depuis l'ancien cluster flottant). */}
        <ReportButton />

        {/* Séparateur / Divider */}
        <div className="h-5 w-px" style={{ backgroundColor: 'var(--border-color)' }} />

        {/* Sélecteur de langue segmenté / Segmented language selector */}
        <div
          className="flex h-8 items-center rounded-lg border overflow-hidden"
          style={{ borderColor: 'var(--border-color)' }}
        >
          {languages.map((lang, i) => {
            const active = i18n.language === lang.code
            return (
              <button
                key={lang.code}
                onClick={() => { i18n.changeLanguage(lang.code); setLanguage(lang.code) }}
                className="h-full px-2.5 text-xs font-semibold transition-colors"
                style={{
                  backgroundColor: active ? 'var(--color-primary)' : 'transparent',
                  color: active ? '#fff' : 'var(--text-muted)',
                  borderLeft: i > 0 ? '1px solid var(--border-color)' : undefined,
                }}
              >
                {lang.label}
              </button>
            )
          })}
        </div>

        {/* Séparateur / Divider */}
        <div className="h-5 w-px" style={{ backgroundColor: 'var(--border-color)' }} />

        {/* Aide / Help */}
        <button
          onClick={() => navigate('/help')}
          className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-sm font-bold transition-colors hover:opacity-80"
          style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--color-primary)' }}
          title={t('help.title')}
        >
          ?
        </button>

        {/* Toggle clair/sombre / Theme toggle */}
        <button
          onClick={toggleTheme}
          className="h-8 w-8 inline-flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
          style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
          title={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
        >
          {theme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          )}
        </button>

        {/* Utilisateur + mot de passe + déconnexion / User + password + logout */}
        {user && (
          <>
            <div className="h-5 w-px" style={{ backgroundColor: 'var(--border-color)' }} />
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                {user.username}
              </span>
              <button
                onClick={() => setShowPwdDialog(true)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                title="Modifier mon mot de passe"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </button>
              <button
                onClick={() => setShowMfaDialog(true)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
                style={{
                  backgroundColor: 'var(--bg-tertiary)',
                  color: user.mfa_enabled ? 'var(--color-primary)' : 'var(--text-secondary)',
                }}
                title={user.mfa_enabled ? 'MFA actif — gérer' : 'Activer la double authentification (MFA)'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              </button>
              <button
                onClick={handleLogout}
                className="h-8 inline-flex items-center px-3 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                title={t('auth.logout')}
              >
                {t('auth.logout')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Dialog MFA (STIME B7) */}
      {showMfaDialog && <MfaDialog onClose={() => setShowMfaDialog(false)} />}

      {/* Dialog changement de mot de passe / Change password dialog */}
      {showPwdDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={closePwdDialog}>
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative rounded-xl border shadow-2xl w-full max-w-sm"
            style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                Modifier mon mot de passe
              </h3>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Mot de passe actuel
                  </label>
                  <input
                    type="password"
                    value={pwdCurrent}
                    onChange={(e) => setPwdCurrent(e.target.value)}
                    autoFocus
                    className="w-full px-3 py-2 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Nouveau mot de passe
                  </label>
                  <input
                    type="password"
                    value={pwdNew}
                    onChange={(e) => setPwdNew(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
                    Confirmer le nouveau mot de passe
                  </label>
                  <input
                    type="password"
                    value={pwdConfirm}
                    onChange={(e) => setPwdConfirm(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleChangePassword()}
                    className="w-full px-3 py-2 rounded-lg border text-sm"
                    style={{ backgroundColor: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              {pwdError && (
                <p className="text-xs mt-3" style={{ color: 'var(--color-danger)' }}>{pwdError}</p>
              )}
              {pwdSuccess && (
                <p className="text-xs mt-3" style={{ color: 'var(--color-success)' }}>Mot de passe modifie avec succes !</p>
              )}

              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={closePwdDialog}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleChangePassword}
                  disabled={pwdLoading || !pwdCurrent || !pwdNew || !pwdConfirm}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--color-primary)' }}
                >
                  {pwdLoading ? t('common.loading') : 'Modifier'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
