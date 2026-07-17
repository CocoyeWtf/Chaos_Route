# Runbook — Mise à jour de l'app mobile CMRO Driver

Objectif : **stabiliser durablement** la distribution des mises à jour de l'app Android
(tablettes PDV + chauffeurs) et supprimer les régressions récurrentes
(« la MAJ disparaît à la réouverture », « il faut désinstaller/réinstaller/reparamétrer »).

## 1. Décision d'architecture — un SEUL mécanisme

La distribution se fait **par APK** (page `/app/setup/<code>` + updater intégré). En conséquence :

- **`expo-updates` (OTA) est DÉSACTIVÉ** (`app.json` → `"updates": { "enabled": false }`).
  Raison : `expo-updates` était compilé mais **inutilisé**, et pilotait quand même le
  choix du bundle JS au démarrage. Avec `runtimeVersion: appVersion`, chaque bump de
  version rendait les bundles incompatibles → le runtime **retombait sur le bundle
  embarqué de l'APK** (l'ancienne 1.9.0). C'est la cause du « retour en arrière à la
  réouverture ». Désactivé, l'app exécute **toujours** son bundle embarqué, de façon
  déterministe.
- Toute mise à jour = **nouvel APK**. Il n'y a plus de mise à jour « OTA JS » silencieuse.
  (Si un jour on veut de l'OTA, ce sera une décision séparée : réactiver expo-updates,
  fixer `runtimeVersion` sur une chaîne stable — pas `appVersion` — et publier via
  `eas update --channel production`. Ne PAS mélanger les deux.)
- **Mise à jour non refusable.** Quand `FORCE_UPDATE = True` et qu'un build supérieur
  est servi, l'app **démarre automatiquement** le téléchargement + l'installation dès la
  détection (modale bloquante, sans oui/non). L'équipier est notifié mais ne peut pas
  refuser (une MAJ poussée est obligatoire — évite les écarts de process). Seule reste
  l'**invite système Android** d'installation (non contournable sans MDM). En cas
  d'échec, la modale propose « Réessayer » et l'app reste inutilisable tant que la MAJ
  n'est pas faite.

## 2. Source de vérité unique pour la version

Trois endroits doivent rester **synchronisés à chaque release** :

| Emplacement | Champ | Rôle |
|---|---|---|
| `mobile/app.json` | `expo.version` (ex. `1.9.4`) | version affichée |
| `mobile/app.json` | `expo.android.versionCode` (ex. `15`) | **entier** comparé par l'updater |
| `backend/app/api/mobile_setup.py` | `APP_VERSION` / `APP_BUILD_NUMBER` | ce que le serveur annonce |

Règle d'or : **`APP_BUILD_NUMBER` (backend) == `android.versionCode` de l'APK servi**.
L'updater intégré compare `versionCode` natif au `build_number` serveur et ne déclenche
que si `serveur > local`. Toute désynchro = mises à jour incohérentes (le bug historique :
serveur=11 alors que l'APK installé était 14).

## 3. Signature — la clé DOIT être identique à chaque build

La cause de « désinstaller/réinstaller/reparamétrer » est un **changement de clé de
signature** entre deux APK : Android refuse alors la mise à jour sur place et impose une
désinstallation (qui efface la config SecureStore → reparamétrage).

- Utiliser **toujours le même keystore** (recommandé : credentials gérés par EAS, ou un
  keystore unique conservé de façon sûre). Ne jamais livrer un APK *debug* puis un
  *release*, ni régénérer le keystore.
- Toujours **incrémenter `versionCode`** (Android refuse d'installer un versionCode ≤).

Avec clé stable + versionCode croissant, la mise à jour se fait **sur place**, sans
désinstallation, la config des tablettes est préservée.

## 4. Checklist de release (à suivre à chaque MAJ)

1. `mobile/app.json` : incrémenter `expo.version` **et** `expo.android.versionCode`.
2. Build APK release avec le **keystore habituel** :
   `eas build -p android --profile preview` (profil `preview` = APK, cf. `eas.json`).
3. Récupérer l'APK, le renommer `cmro-driver.apk`, le placer dans **`backend/apk/cmro-driver.apk`**
   (ce dossier est actuellement vide → `download_url` est `null` tant qu'aucun APK n'y est).
4. `backend/app/api/mobile_setup.py` : mettre `APP_VERSION` et `APP_BUILD_NUMBER` égaux à
   la nouvelle version / au nouveau `versionCode`. Passer `FORCE_UPDATE = True` **seulement
   après** avoir vérifié que le nouvel APK démarre correctement (pas d'écran blanc).
5. Déployer le backend. Vérifier `GET /app/version` renvoie les bons numéros + un
   `download_url` non nul.
6. Test terrain sur **une** tablette déjà en service : la modale « Mise à jour obligatoire »
   s'affiche, le téléchargement + installation se font **sans désinstaller**, la config est
   conservée, l'app redémarre sur la nouvelle version **et y reste après fermeture/réouverture**.
7. Si OK, laisser `FORCE_UPDATE = True` pour propager au parc. Sinon, repasser à `False`
   (coupe-circuit) et corriger.

## 5. Coupe-circuit / rollback

- `FORCE_UPDATE = False` dans `mobile_setup.py` **désarme** l'auto-update pour tout le parc
  (utile si un build casse). Les tablettes gardent leur version installée.
- Pour revenir à un APK sain : remettre l'ancien APK (versionCode supérieur !) dans
  `backend/apk/`, resynchroniser `APP_BUILD_NUMBER`, `FORCE_UPDATE = True`. Comme Android
  refuse un versionCode inférieur, un « vrai » rollback nécessite un versionCode plus haut
  contenant l'ancien code.

## 6. Sécurité de la mise à jour (intégrité + transport)

- **Empreinte SHA-256** : `GET /app/version` renvoie désormais le hash SHA-256 de l'APK
  servi (`backend/apk/cmro-driver.apk`), calculé automatiquement. L'app **vérifie** que
  l'APK téléchargé correspond à cette empreinte **avant** de lancer l'installeur, et
  **refuse** l'installation en cas d'écart (anti-altération). Aucune action manuelle : le
  hash suit l'APK déposé.
- **HTTPS obligatoire** : le cleartext est désactivé (`app.json` →
  `usesCleartextTraffic: false`). L'APK et l'API ne sont plus accessibles qu'en **HTTPS**.
  Toute URL serveur en `http://` (écran « Serveur ») ne fonctionnera plus — utiliser
  exclusivement `https://…`.
- **Signature Android (keystore)** = l'identité « officielle » de l'app (cf. §3). Garder
  la clé unique protège aussi contre le remplacement par un APK tiers.
- *Niveau supérieur (non implémenté)* : signer la réponse `/app/version` (ou l'APK) avec une
  clé privée serveur + clé publique embarquée dans l'app = garantie cryptographique de bout
  en bout de « mise à jour officielle ». À envisager si le modèle de menace l'exige.

## 7. Rappels

- `backend/apk/` doit contenir l'APK servi. Les APK dans `mobile_build/` (historique) ne
  sont **pas** servis automatiquement.
- L'updater ne concerne qu'**Android** (`Platform.OS === 'android'`).
- L'app affiche toujours version + build (écran d'erreur `ErrorBoundary`, réglages) : s'y
  fier pour diagnostiquer « quelle version tourne réellement ».
