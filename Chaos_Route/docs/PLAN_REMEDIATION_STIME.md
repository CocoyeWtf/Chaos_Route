# Plan d'exécution — Remédiation STIME « tout au vert »

**Objet :** transformer chaque écart du [BILAN_STIME_CHAOS_ROUTE.md](BILAN_STIME_CHAOS_ROUTE.md) en réponse « au vert », avec ordre d'exécution, effort, dépendances, responsable et critère d'acceptation.
**Date :** 2026-07-06. **Pilote :** Dominic. **Exécution code/scripts :** Claude Code.

## Suivi d'exécution (MàJ 2026-07-08)

| Réf. | État | Détail |
|---|---|---|
| **A1** | ✅ **Vert** | Seed env-only, refus de démarrer sans mdp fort, rotation forcée 1er login. Tests auto. Compte `admin` historique **neutralisé en prod** le 2026-07-08 (désactivé + rétrogradé + mdp invalidé ; suppression physique impossible — FK historiques). Vérifié : `admin/admin` → 401. |
| **A2** | ✅ **Vert** | `validate_password_strength` (12/14, 3 classes, liste noire) branché sur les 5 flux. Tests auto. |
| **A3** | ✅ **Vert (déployé)** | 308 HTTPS vérifié en prod le 2026-07-08 ; healthcheck `/caddy-health` sain ; vhost mexprt préservé et versionné. |
| **B1/B2** | ✅ Installé (S3 restant) | **Audit : la sauvegarde nocturne était CASSÉE** (backup.sh absent, échecs silencieux chaque nuit — cf. `ops/backup/AUDIT_2026-07-08.md`). Chaîne chiffrée installée + cron 02:30 + backup réel + **restauration testée** (21 s, 187 users). Reste : choix S3 UE (D) + clé privée au coffre. |
| **A4** | ✅ **Vert** | Cookies HttpOnly/SameSite (plus aucun jeton en JS), logout à révocation serveur (jti), refresh rotatif usage unique. Tests auto. |
| **A5** | ✅ **Vert** | Audit ORM généralisé (59 modules couverts), acteur + tenant + diff. Tests auto. |
| **A6** | ✅ **Vert** | Table `retention_policies` + purge quotidienne + API + plancher 6 mois audit. Registre Art. 30 à jour. |
| **A7** | ✅ **Vert** (code) | **Information GPS, pas consentement** (révision 2026-09) : l'opt-out en libre-service a été retiré — il contredisait la base légale déclarée au registre (intérêt légitime, art. 6.1.f) et un seul bouton suffisait à rendre un véhicule invisible. Reste : notice versionnée (v2.0-2026-09) + **accusé de lecture** horodaté et journalisé (preuve de l'information individuelle, L.1222-4) + écran mobile permanent (bouton Confidentialité) + export Art. 20. Contrepartie opérationnelle : alerte `NO_GPS` nominative dès qu'une tournée en cours cesse d'émettre. |
| **B3** | 🟡 Secrets ✅ / disque ⬜ | **SOPS exécuté en prod (2026-07-09)** : plus de `.env.production` en clair au repos, déchiffrement éphémère dans deploy.sh (testé E2E), wrapper compose, clé au coffre. Reste : chiffrement LUKS du volume base (fenêtre de maintenance à planifier). |
| **B7** | ✅ MFA en service | TOTP déployé + QR d'enrôlement ; Dominic enrôlé et flux 2 étapes validé en prod (2026-07-08). **Reste** : enrôlement d'Estelle → puis activer `REQUIRE_MFA_SUPERADMIN=true` ; allowlist IP (gabarit Caddy prêt, IP à fournir). |
| **B8** | ✅ **Vert** | CI `security.yml` (pytest 105 ✅, bandit, semgrep, pip-audit, npm audit) + Dependabot. Deps vulnérables purgées (PyJWT, shell-quote). |
| **B4** | ✅ **Vert (déployé)** | Loki+Promtail (logs 180 j, 6 conteneurs) + Grafana (`/grafana`) + watchdog 2 min → push ntfy (canal testé). Reste : abonner l'app ntfy (2 min) + sonde externe UptimeRobot (10 min, D). |
| **B5** | 🟡 Décision D | Note de décision `ops/waf/README.md` — recommandation Cloudflare Free (WAF OWASP + anti-DDoS), exécution ~1 h après migration DNS. |
| **B6** | 🟡 PRA livré | `docs/operations/PLAN_REPRISE_ACTIVITE.md` (4 scénarios, RTO/RPO, exercice consigné du 2026-07-08). Reste : S3 externe (dépend B2), exercice annuel scénario 3, 2ᵉ VPS si exigé. |
| **C1** | 🟡 Trame livrée | `DPO_ANALYSE_DESIGNATION.md` : analyse Art. 37 (pas d'obligation stricte, référent recommandé) + trame de désignation à signer + checklist de publication. |
| **C2** | 🟡 Registre livré | `REGISTRE_SOUS_TRAITANTS_DPA.md` : tableau des 6 ST actuels + 3 futurs, checklist de signature. Signatures : Dominic. |
| **C3** | 🟡 Trames livrées | `PSSI_CHAOS_PLATFORM.md` (classification + règles adossées à l'implémenté) + `CHARTE_BON_USAGE.md` (avec volet géoloc/tablettes). À approuver/diffuser. |
| **C4** | ⬜ Si demandé | SSO OIDC/SAML — uniquement si STIME l'exige. |

### Prochaines actions (dans l'ordre)

1. **Dominic (cette semaine)** : app ntfy + abonnement topic (2 min) · sonde UptimeRobot (10 min) · clés age au coffre (`~/.chaos-secrets/`) · approuver PSSI/charte/désignation référent · DPA Hostinger.
2. **Semaine du 2026-07-13** : point Estelle → enrôlement MFA → CC active `REQUIRE_MFA_SUPERADMIN`.
3. **Décisions à prendre** : contrat S3 UE (→ CC branche l'upload + périmètre photos) · Cloudflare (→ CC exécute le WAF en ~1 h) · fenêtre maintenance LUKS (→ CC pilote).
4. **Après validation build 12 mobile** : build 13 avec l'écran de consentement GPS → test 1 tablette → flotte.
5. **Ensuite** : exercice PRA scénario 3 (après S3) · pentest externe (hors périmètre code, une fois Sprint 0/1 stabilisés en audit).

## Légende

- **Resp.** : `CC` = Claude Code (autonome) · `CC→D` = Claude livre, Dominic déploie sur le VPS · `D` = Dominic seul (organisationnel/juridique).
- **Effort** : estimation en demi-journées de travail effectif (0,5 = ~½ j).
- **« Vert »** = critère d'acceptation objectif prouvant que le point est traité.
- Familles : **A** = code applicatif · **B** = infra/scripts serveur · **C** = organisationnel.

---

## Vue d'ensemble — ordre recommandé

```
SPRINT 0 (jours)      SPRINT 1 (S+1→S+4)        SPRINT 2 (S+4→S+10)
─────────────────     ──────────────────────    ──────────────────────
A1 admin/admin   ──▶  A4 jetons cookies         B4 monitoring/alerting
A2 politique mdp ──▶  A5 audit log complet      B5 WAF
A3 vhost HTTPS   ──▶  A6 rétention consolidée    B6 HA + PRA testé
B1 vérif backup  ──▶  A7 portabilité RGPD        C3 PSSI / charte
                      B2 backup chiffré+externe   C4 SSO (si demandé)
                      B3 chiffrement au repos
                      C1 DPO désigné
                      C2 DPA signés
                      B7 MFA + IP admin
                      B8 CI/CD + SAST
```

Règle : **A1→A3 (Sprint 0) d'abord et sans dépendance** — ce sont les 3 rouges/oranges les plus visibles en audit, chacun < 1 j. Rien d'autre ne les bloque.

---

## SPRINT 0 — Correctifs immédiats (Famille A, code pur)

### A1 — Supprimer le compte `admin/admin` par défaut 🔴
- **Bilan :** Q37, 40, 130 · **Resp. :** CC · **Effort :** 0,5 · **Dép. :** aucune
- **État :** `seed.py:23` hache `"admin"` en dur, appelé inconditionnellement (`main.py:44`).
- **Action :**
  1. Le seed lit `ADMIN_USERNAME` + `ADMIN_PASSWORD` depuis l'environnement.
  2. Si `ADMIN_PASSWORD` absent **et** base vide → **refus de démarrer** (log explicite) plutôt que créer un compte faible.
  3. Le mot de passe fourni passe par le validateur de politique (cf. A2) — refus si faible.
  4. Supprimer le `print("... admin / admin")`.
  5. Alternative retenue : au 1er login superadmin, forcer `must_change_password=True`.
- **Vert :** impossible de démarrer une prod avec un mot de passe superadmin par défaut ou faible ; test automatisé qui vérifie le refus.

### A2 — Durcir la politique de mot de passe 🔴
- **Bilan :** Q40, 50 · **Resp. :** CC · **Effort :** 0,5 · **Dép. :** aucune (A1 la réutilise)
- **État :** `min_length=4` sur `auth.py:30,41` uniquement ; **aucune** validation sur `UserCreate`/`UserUpdate` (`user.py:63,77`).
- **Action :**
  1. Fonction centrale `validate_password_strength(pwd, privileged=False)` : ≥ 12 car. (≥ 14 si privilégié), au moins 3 des 4 classes (min/maj/chiffre/symbole), rejet des mots de passe courants (liste top-N).
  2. Brancher sur **tous** les flux : `UserCreate`, `UserUpdate`, `ChangePasswordRequest`, `ResetPasswordRequest`, seed A1.
  3. Messages d'erreur explicites (FR) renvoyés au front.
- **Vert :** un mot de passe de 11 car. ou sans complexité est rejeté partout ; tests unitaires couvrant les 5 flux.

### A3 — Supprimer le vhost HTTP en clair (mobile) 🟠
- **Bilan :** Q48, 137 · **Resp. :** CC→D · **Effort :** 0,5 · **Dép. :** app mobile doit pointer HTTPS
- **État :** `Caddyfile:13-16` proxifie `http://76.13.58.182` en clair.
- **Action :**
  1. Remplacer le bloc `http://` par une **redirection 308 vers HTTPS**, ou mieux : faire pointer l'app mobile sur le domaine TLS.
  2. Mobile : `API_BASE_URL` → `https://chaosroute.chaosmanager.tech/api` (`mobile/services/api.ts` / config Expo).
  3. Rebuild APK (profil `preview`) + test sur 1 tablette avant flotte.
- **Vert :** `curl http://76.13.58.182/api/...` renvoie une redirection 30x/refus ; plus aucun jeton Bearer en clair ; app mobile fonctionnelle en HTTPS.
- **⚠️ Coordination :** ne pas déployer le Caddyfile avant que l'APK HTTPS soit installé, sinon coupure mobile. Séquence : build APK HTTPS → valider 1 tablette → déployer Caddyfile.

### B1 — Vérifier & tracer la sauvegarde nocturne existante
- **Bilan :** Q94 · **Resp. :** CC→D · **Effort :** 0,5 · **Dép. :** accès VPS
- **Action :** auditer le cron réel sur le VPS, versionner le script de backup dans le dépôt (`ops/backup/`), documenter fréquence/emplacement/rétention actuels. Base de départ pour B2.
- **Vert :** script de backup présent dans le dépôt + preuve d'exécution (log horodaté).

**Bilan Sprint 0 :** ~2,5 j · fait basculer Q37/40/48/50/130/137 + prépare Q94.

---

## SPRINT 1 — Réponse crédible (4 à 6 semaines)

### A4 — Migrer les jetons web hors `localStorage` 🟠
- **Bilan :** Q54, 140, 141 · **Resp. :** CC · **Effort :** 2 · **Dép. :** aucune (mais touche front + back)
- **Action :** access token en cookie `HttpOnly`/`Secure`/`SameSite`, refresh token idem ; endpoint `/logout` qui **révoque** côté serveur (blacklist/rotation jti) ; adapter le front (retrait de la lecture `localStorage`) et CORS/CSRF.
- **Vert :** aucun jeton lisible en JS ; un logout invalide réellement le token côté serveur (test) ; XSS ne peut plus exfiltrer la session.

### A5 — Étendre l'audit log à tous les modules CRUD 🟠
- **Bilan :** Q15, 60 · **Resp. :** CC · **Effort :** 2 · **Dép. :** décision rétention (A6)
- **État :** 11/59 modules audités.
- **Action :** décorateur/middleware d'audit générique sur les mutations (create/update/delete) des modules manquants ; champ acteur + tenant + horodatage ; politique de rétention ≥ 6 mois branchée sur A6.
- **Vert :** toute mutation métier produit une entrée d'audit ; requête d'extraction < 24 h ; rétention paramétrée.

### A6 — Consolider les durées de rétention 🟠
- **Bilan :** Q41, 60, 183 · **Resp. :** CC (+ validation D) · **Effort :** 1 · **Dép. :** arbitrage durées par Dominic
- **Action :** table centrale des durées (logs, audit, photos, GPS, SMS…) ; purges automatiques alignées ; mise à jour du registre Art. 30. Garantir **≥ 6 mois** pour les journaux.
- **Vert :** chaque donnée a une durée définie + purge automatique testée ; registre cohérent.

### A7 — Portabilité RGPD (Art. 20) + consentement GPS
- **Bilan :** Q185, 187, 188 · **Resp. :** CC · **Effort :** 1,5 · **Dép. :** aucune
- **Action :** endpoint export des données d'une personne (JSON/CSV) ; mécanisme de consentement/opt-out GPS (action DPIA A3) ; mentions d'information.
- **Vert :** export self-service fonctionnel ; consentement traçable.

### B2 — Sauvegardes conformes (chiffrées + externalisées + testées) 🔴
- **Bilan :** Q3, 38, 95, 120, 124, 125 · **Resp. :** CC→D · **Effort :** 2 · **Dép. :** B1 + choix stockage tiers UE
- **Action :** script `pg_dump` → chiffrement (age/gpg) → upload S3 compatible UE (ex. Scaleway/OVH/Backblaze EU) ; rétention + rotation ; **script de test-restore** + procédure documentée exécutée une fois pour de vrai.
- **Vert :** dump chiffré présent hors du VPS ; restauration testée et documentée (date, durée, RPO constaté).
- **Décision D :** choisir le fournisseur de stockage tiers UE.

### B3 — Chiffrement des données au repos 🔴
- **Bilan :** Q27, 28, 105, 114 · **Resp. :** CC→D · **Effort :** 2 · **Dép. :** fenêtre de maintenance
- **Action :** chiffrement du volume/disque de la base + secrets (`SECRET_KEY`, mdp) sortis du `.env` en clair vers un coffre (vault léger / age-encrypted secrets / SOPS). Procédure de rotation de clés.
- **Vert :** base sur volume chiffré ; secrets non stockés en clair ; procédure de rotation documentée.

### B7 — MFA sur comptes privilégiés + restriction IP admin 🟠
- **Bilan :** Q34, 53, 57, 136 · **Resp. :** CC (MFA) + CC→D (IP) · **Effort :** 2,5 · **Dép. :** aucune
- **Action :** TOTP (RFC 6238) pour superadmin/admin (enrôlement + vérif au login) ; allowlist IP ou VPN devant l'interface d'admin (Caddy matcher / firewall).
- **Vert :** login admin exige un second facteur ; `/admin` inaccessible hors IP autorisées.

### C1 — Désigner un DPO 🔴
- **Bilan :** Q6, 160, 164 · **Resp. :** D · **Effort :** — · **Dép. :** décision
- **Action :** désigner un DPO interne/externe (ou documenter l'absence d'obligation légale Art. 37). Publier ses coordonnées dans le registre + questionnaire.
- **Vert :** nom + coordonnées DPO renseignés, ou justification écrite de non-obligation.

### C2 — Signer les DPA Article 28 🔴
- **Bilan :** Q5, 26, 176, 177 · **Resp. :** D · **Effort :** — · **Dép. :** contact fournisseurs
- **Action :** signer les accords de sous-traitance avec Hostinger + passerelle SMS (récupérer leurs DPA types) ; compléter la liste des sous-traitants ultérieurs.
- **Vert :** DPA signés archivés ; liste des ST complète dans le registre.

**Bilan Sprint 1 :** ~15 j code/scripts + 2 actions juridiques (C1, C2). Fait basculer la majorité des rouges restants.

---

## SPRINT 2 — Maturité « groupe » (2 à 3 mois)

| Réf. | Action | Bilan | Resp. | Effort | Dép. | « Vert » |
|---|---|---|---|:--:|---|---|
| **B4** | Supervision & alerting (Loki + Prometheus + alerte down) | Q15, 138, 139, 154 | CC→D | 3 | — | Alerte reçue en < 5 min si service down ; logs agrégés 6 mois |
| **B5** | WAF devant Caddy (Cloudflare / Caddy-security) | Q36, 138 | CC→D | 1,5 | DNS | Règles OWASP actives ; anti-DDoS en place |
| **B6** | HA + PRA testé (2e VPS, réplication PostgreSQL, exercice annuel) 🔴 | Q91, 92, 93, 143, 145 | CC→D | 5 | 2e VPS | Bascule testée ; PRA écrit + exercé (RTO/RPO mesurés) |
| **B8** | CI/CD + SAST + scan deps (bandit/semgrep + pip-audit/Dependabot) | Q39, 67, 69, 131 | CC→D | 2,5 | runner | Pipeline bloque si vuln critique ; revue sécu avant prod |
| **C3** | PSSI + classification + charte bon usage | Q7, 11, 29, 169 | D (trames CC) | — | — | Documents rédigés et approuvés |
| **C4** | SSO/fédération OIDC/SAML (si demandé par STIME) | Q53, 68, 135 | CC→D | 3 | demande client | Connexion via IdP du client |

**Bilan Sprint 2 :** ~15 j + rédaction documentaire. Traite les derniers rouges (HA/PRA) et oranges (WAF, CI/CD, monitoring).

---

## Récapitulatif effort

| Sprint | Code (CC) | Infra (CC→D) | Orga (D) | Total ~jours |
|---|:--:|:--:|:--:|:--:|
| Sprint 0 | 1,5 | 1,0 | — | ~2,5 |
| Sprint 1 | 6,5 | 6,5 | C1, C2 | ~13 + juridique |
| Sprint 2 | — | 15 | C3, (C4) | ~15 + doc |
| **Total** | **~8 j** | **~22 j** | **4 actions** | **~30 j** ouvrés |

> L'essentiel de la valeur d'audit se joue sur **Sprint 0 + Sprint 1** : à leur issue, les 7 rouges sont traités ou en cours documenté, et la réponse au questionnaire passe de « jeune SaaS » à « SaaS en remédiation active pilotée ».

## Ce qui reste hors périmètre code

- **Certifications** (ISO 27001 / SOC 2 / HDS) : décision stratégique, plusieurs mois-hommes, non couverte ici.
- **Pentest externe** : à commander à un tiers une fois Sprint 0/1 fait.

---

*Plan à mettre à jour à chaque action clôturée (cocher « Vert »). Référence : BILAN_STIME_CHAOS_ROUTE.md.*
