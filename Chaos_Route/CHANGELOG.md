# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Tickets #7–#12 — Encodage de retours PDV (app mobile + web)
- **#8 — Restriction des supports de retour.** L'inventaire PDV mobile
  (`/driver/inventory-lookup` + `/driver/inventory`) n'accepte plus que les
  supports de retour autorisés : préfixes `CO`/`PA`/`PL`/`RE` et `SF 40040` /
  `SF 40104` / `SF 40204`. Les casiers à bière (`SF 3xxxx`), qui relèvent du flux
  consignes dédié, sont exclus. Règle centralisée dans
  `app/utils/support_rules.py`. Côté app : recherche d'un support en tapant son
  nom (inventaire PDV + inventaire base) et affichage du **libellé seul** (plus le
  code) sur l'écran inventaire PDV.
- **#10 / #7 — Création de la demande CMRO + impression à la validation.** À la
  validation d'un inventaire PDV, l'app affiche un **récapitulatif** puis crée les
  **demandes de reprise** correspondantes (une par ligne, visibles dans CMRO web)
  et **imprime les étiquettes** générées sur l'imprimante Bluetooth (Zebra ZPL).
  Nouveau champ `create_requests` sur `POST /driver/inventory` ; réponse enrichie
  des demandes créées et de leurs étiquettes.
- **#11 — Sécurisation du scan chauffeur.** Les endpoints
  `pickup-labels/{code}/scan`, `.../scan-arrival` et `standalone-pickup/{code}`
  acceptent un paramètre `pdv_code` et **refusent (409)** une étiquette
  n'appartenant pas au PDV scanné (message explicite). L'app transmet le code du
  PDV actif. Le double-scan reste neutralisé (anti-rebond 3 s + idempotence
  serveur).
- **#12 — Palette support obligatoire pour les balles.** La déclaration de balles
  (`CARDBOARD`) exige désormais une palette support (ex. `PA 22020` — Pal Loc
  80*120), contrôlée côté serveur (`_do_create_pickup_request`) et exposée dans
  les formulaires web et mobile ; l'inventaire PDV l'affecte automatiquement aux
  lignes balles.
- **#9 — Bouton « Enregistrer » remonté.** Marge basse augmentée sur les écrans
  d'inventaire (PDV + base) pour que le bouton ne soit plus masqué par la barre
  système du téléphone.

### Ticket #13 — App PDV : mises à jour + sécurité
- **Auto-update stabilisé.** `expo-updates` (OTA) était compilé mais inutilisé et
  entrait en conflit avec l'updater APK → l'app repartait sur le bundle embarqué
  (« retour à la v1.9.0 à la réouverture »). `expo-updates` désactivé
  (`app.json` → `updates.enabled: false`) : l'app exécute toujours son bundle
  embarqué, de façon déterministe. Runbook de release ajouté
  (`docs/operations/RUNBOOK_MISE_A_JOUR_MOBILE.md`) : versionCode + keystore
  uniques, synchro de la version côté backend.
- **Intégrité des mises à jour (sécurité).** `GET /app/version` expose désormais
  l'empreinte **SHA-256** de l'APK servi ; l'app vérifie le fichier téléchargé
  **avant** de lancer l'installeur et **refuse** l'installation en cas d'écart
  (hachage par blocs, mémoire bornée). Cleartext coupé
  (`usesCleartextTraffic: false`) → APK et API en **HTTPS** uniquement.
- **Enregistrement d'appareil durci (sécurité).** Un `registration_code` est lié à
  **un seul appareil physique** : `POST /devices/register` **refuse (409)** de
  ré-enregistrer un autre appareil au lieu d'écraser silencieusement l'identité
  (ce qui permettait à n'importe quel téléphone possédant le code de se faire passer
  pour la tablette d'un PDV). Le re-binding exige une réinitialisation admin
  (`reset-identity`) ; tentatives et liaisons tracées à l'audit.

### Security
- **Isolation multi-tenant — correctif critique du filtre central.** Le filtre
  `do_orm_execute` utilisait `with_loader_criteria(..., lambda cls, tid=tenant_id: …)`.
  L'argument par défaut `tid=` est traité comme une CONSTANTE par le cache de
  lambda-SQL de SQLAlchemy : la valeur du tenant du **premier** appel était figée
  et réutilisée pour toutes les requêtes suivantes. Invisible avec un seul tenant
  (Belgique), mais aurait cassé l'isolation dès l'ajout de la France (fuite ou 0
  résultat). Passage à une variable de **closure** (suivie et re-liée en bindparam
  par requête). Couvert par des tests d'isolation multi-tenant en un seul process.
- **Distancier (`distance_matrix`) et taxe km (`km_tax`) cloisonnés par tenant**
  (`TenantMixin`) : `GET /distance-matrix/` ne renvoyait pas de scope tenant →
  fuite cross-pays potentielle des distances/temps. Colonne `tenant_id`
  auto-migrée + backfill Belgique=1.
- **KPI** : `region_id` fourni par le client est désormais refusé (403) s'il est
  hors du périmètre de régions de l'utilisateur (`/kpi/punctuality`,
  `/kpi/pickup-rate`).
- Nouveaux **tests d'isolation au niveau API** (`tests/test_reference_data_isolation.py`) :
  un tenant ne lit pas les données d'un autre via l'endpoint distancier ; un KPI
  refuse une région hors périmètre.

### Fixed
- Ticketing : `create_ticket` et `update_status` ne chargeaient pas la relation
  `photos` (ajoutée pour les pièces jointes) → `ResponseValidationError` à la
  sérialisation de `TicketDetail`. Ajout du `selectinload(Ticket.photos)`.

### Added
- Ticketing — **pièces jointes photo / capture d'écran** : à la création d'un
  ticket (modale « Nouveau ticket » / bouton « Signaler ») on peut joindre
  jusqu'à 5 images (≤ 5 Mo) avec aperçu ; et on peut aussi ajouter des photos à
  un ticket existant depuis son détail. Affichage en grille + visionneuse plein
  écran. Stockage disque (`data/photos/tickets/`), table `ticket_photos`
  (tenant-scopée), endpoints `POST/GET /tickets/{id}/photos`. Images servies via
  le client authentifié (blob), pas d'endpoint ouvert.
- Création de tours — **Enlèvement dédié** (sous le mode *Mouvement*) : nouvelle
  nature `ENLEVEMENT_DEDIE` permettant de choisir un **fournisseur** (point
  d'enlèvement déjà dans le distancier, ex. e066 = AVION — fonctionne comme un
  PDV), un **chauffeur PARC** (chauffeur Base, commentaire « Chauffeur PARC » par
  défaut) et un créneau **heure de début → heure de fin** (saisis à la main). Le
  km aller-retour base ↔ fournisseur est repris du distancier. Nouvelle colonne
  `tours.supplier_id` (migration auto : colonne + FK + valeur d'enum PG ajoutées).
- Création de tours — **Tour surprise** : tour attribué à un transporteur sans PDV
  au moment de la création (les PDV sont ajoutés plus tard depuis l'ordonnancement).
  Saisie base + transporteur + heure de départ.
- Ordonnancement — bouton **Confirmation Mail** : génère, transporteur par
  transporteur, le récapitulatif des tournées attribuées du jour (tableau Code Ch.
  | H.Départ | N° Mission | Chauffeurs | Observations/Enlèvement | Départ | Retour
  | PDV 1..N), avec aperçu validé « prêt à être transféré » puis envoi manuel à
  l'adresse e-mail enregistrée dans la fiche transporteur (endpoints
  `GET/POST /tours/transporter-confirmation`).

### Changed
- Ordonnancement : barre d'actions compactée sur une seule ligne — boutons à
  hauteur unique (32px), *Recalculer* et *Imprimer* en icône seule (infobulle),
  *Valider* et *WMS* en libellé court + icône. Évite le débordement sur une 2ᵉ
  ligne apparu avec l'ajout de l'export, et gagne de la hauteur d'écran.
- Ordonnancement : barre dissociée en 2 zones — filtres à gauche (se replient
  entre eux si besoin) et actions ancrées en haut à droite (`shrink-0`), pour que
  le bloc compteurs+boutons ne bascule plus jamais sur une 2ᵉ ligne pleine largeur.
- Bandeau (Header) : refonte géométrique — hauteur unique (32px) pour tous les
  contrôles, sélecteur de langue segmenté d'un bloc, séparateurs verticaux entre
  groupes, icônes SVG (épingle/soleil/lune/cadenas) au lieu des emojis. Alignement
  et rythme homogènes.

### Fixed
- Ordonnancement (tours Mouvement) : (1) un mouvement affecté à un seul chauffeur
  Base était classé sans mode → invisible au filtre « Propre » ; désormais classé
  *propre* dès qu'il y a une ressource propre (véhicule, tracteur ou chauffeur).
  (2) Le chauffeur Base s'affiche dans le **badge vert** (même emplacement que les
  transporteurs) au lieu du petit texte gris. (3) Le **commentaire** du tour et la
  **destination** apparaissent désormais sur la carte.
- Ordonnancement (Gantt) : un tour livré le jour B (départ/retour après minuit,
  ex. 00h01→05h15 le 05/06) s'affichait à gauche sur le jour A. Le Gantt positionne
  désormais les barres en **temps absolu** (offset du jour de livraison + heure),
  étend l'axe pour couvrir le jour B et marque la frontière de minuit (« J+1 »).
- Aide à la décision : erreur 500 (niveaux 1 et 2) quand la durée totale calculée
  tombait fractionnaire (ex. 133.08 min) — `SuggestedTour.total_duration_minutes`
  (typé `int`) rejetait le float (Pydantic `int_from_float`). Les champs minutes
  (`total_duration_minutes`, `duration_from_previous_minutes`) arrondissent
  désormais float→int via un validator. Tests de régression ajoutés.

### Added
- Ordonnancement : **permutation des PDV** en mode « Modifier » — flèches ↑/↓ sur
  chaque arrêt pour réordonner la tournée, avec recalcul serveur des temps, km et
  coût (`PUT /tours/{id}/reorder-stops`). « Modifier » déplie le tour pour exposer
  la liste des PDV.
- Construction (Exploitation transport) : nouvelle nature **Transfert PDV à PDV**
  (mode « Mouvement ») — origine (chargement) → destination (dépose), sans
  quantité. Champ **Commentaire** ajouté au mode Mouvement (transfert +
  déplacement base + garage), persisté dans `tours.remarks`. Nouveau type
  `TourType.TRANSFERT_PDV` (migration enum PG incluse).

### Fixed
- Ordonnancement : faux chevauchement (overlap) entre deux tours d'une même
  répartition livrés des jours différents (ex. tour livré le 04/06 09:00-15:53
  vs tour livré le 05/06 05:00). La détection backend comparait uniquement
  l'heure ; elle compare désormais sur une timeline absolue (jour de livraison
  + heure), comme le frontend. Logique extraite en `tours_time_overlap()` + tests.

### Added
- Ordonnancement : export « Infolog (WMS) » (TMS_vers_wms) — génère le fichier
  Excel attendu par la macro d'encodage Infolog (une ligne par arrêt PDV, tours
  rangés par priorité ERT, PDV de chaque tour en ordre inverse, index global).
  Code transporteur configurable via le paramètre `wms_infolog_carrier_code`.
  Le code chauffeur Infolog (`code_infolog`) est figé sur le tour au moment de
  la planification (nouvelle colonne `tours.driver_code_infolog`).
- Project structure and documentation
- Backend skeleton: FastAPI + SQLAlchemy models + Alembic migrations
- Frontend skeleton: React + Vite + TypeScript + TailwindCSS + Shadcn/ui
- Internationalization setup (FR, EN, PT, NL)
- Dark/Light theme system
