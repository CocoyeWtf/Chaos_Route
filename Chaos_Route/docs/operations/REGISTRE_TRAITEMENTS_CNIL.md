# Registre des activites de traitement

**Article 30 du Reglement (UE) 2016/679 (RGPD)**

---

## Informations generales

| Champ | Valeur |
|---|---|
| **Organisme** | [A completer -- raison sociale, adresse, SIRET] |
| **Responsable de traitement** | [A completer -- nom, fonction, coordonnees] |
| **Delegue a la protection des donnees (DPO)** | [A designer -- obligatoire si suivi regulier et systematique des personnes a grande echelle (cf. traitement n 2)] |
| **Representant dans l'UE** (si applicable) | Non applicable (siege dans l'UE) |
| **Nom du systeme d'information** | Plateforme CHAOS (Chaos Route) |
| **Date de creation du registre** | 2026-04-03 |
| **Date de derniere mise a jour** | 2026-04-03 |
| **Version** | 1.0 |

---

## Sommaire des traitements

| N | Traitement | Sensibilite | Base legale |
|---|---|---|---|
| 1 | Gestion des tournees de livraison | Normale | Interet legitime / Execution contractuelle |
| 2 | Geolocalisation des chauffeurs | **ELEVEE** | Interet legitime (consultation employes requise) |
| 3 | Gestion des acces et authentification | Normale | Interet legitime |
| 4 | Audit et tracabilite | Normale | Interet legitime |
| 5 | Gestion des SMS operationnels | Normale | Execution contractuelle |
| 6 | Inspections vehicules | Normale | Obligation legale |
| 7 | Gestion des consignes et contenants | Normale | Execution contractuelle |
| 8 | Facturation et surcharges | Normale | Execution contractuelle |

---

## Traitement n 1 -- Gestion des tournees de livraison

### Finalite du traitement

Planification, optimisation et suivi des tournees de livraison : affectation des chauffeurs aux tournees, definition des itineraires, gestion des reservations (bookings), suivi de l'execution des livraisons.

### Base legale (article 6 du RGPD)

- **Article 6.1.b** -- Execution d'un contrat auquel la personne concernee est partie (contrat de travail pour les chauffeurs, contrat commercial pour les PDV).
- **Article 6.1.f** -- Interet legitime du responsable de traitement : optimisation logistique et reduction des couts de transport.

**Analyse de l'interet legitime** : L'optimisation des tournees de livraison est essentielle a l'activite economique de l'organisme. Le traitement est proportionne et n'entraine pas d'atteinte disproportionnee aux droits des personnes concernees.

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Chauffeurs-livreurs | Salaries ou prestataires affectes aux tournees |
| Contacts PDV (points de vente) | Personnes de contact dans les etablissements clients |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Nom, prenom du chauffeur | Identification | Affectation aux tournees |
| Matricule / identifiant interne | Identification | Gestion operationnelle |
| Numero de tournee et composition | Donnee operationnelle | Planification |
| Adresses et coordonnees des PDV | Donnee de contact | Itineraire de livraison |
| Nom et telephone du contact PDV | Donnee de contact | Communication operationnelle |
| Donnees de reservation (booking) | Donnee operationnelle | Suivi des commandes |
| Horaires prevus et effectifs | Donnee temporelle | Planification et suivi |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Service logistique interne | Planification et suivi |
| Chauffeurs (via application mobile) | Execution des livraisons |
| Points de vente (information limitee) | Suivi de leurs livraisons |

### Transferts hors Union europeenne

Aucun transfert hors UE. Les donnees sont hebergees en Union europeenne.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Tournees actives | Duree de la tournee + 30 jours | Suivi operationnel |
| Historique des tournees | **[A definir -- recommandation : 2 ans]** | Analyse et optimisation |
| Donnees de contact PDV | Duree de la relation commerciale | Execution contractuelle |

> **ACTION REQUISE** : Definir et implementer une politique de purge des donnees historiques de tournees.

### Mesures de securite

- Authentification obligatoire pour acceder aux donnees
- Controle d'acces base sur les roles (RBAC) : acces restreint par region et par fonction
- Chiffrement des communications (HTTPS/TLS)
- Journalisation des acces (cf. traitement n 4)
- Sauvegarde reguliere des donnees

---

## Traitement n 2 -- Geolocalisation des chauffeurs

> **SENSIBILITE ELEVEE** -- Ce traitement implique un suivi systematique et regulier des personnes concernees (article 35.3.c du RGPD). Une analyse d'impact relative a la protection des donnees (AIPD) est **obligatoire**.

### Finalite du traitement

Suivi en temps reel de la position des vehicules de livraison pendant les tournees : optimisation des itineraires, estimation des heures d'arrivee, gestion des incidents, preuve de passage.

### Base legale (article 6 du RGPD)

- **Article 6.1.f** -- Interet legitime du responsable de traitement : gestion de flotte, securite des biens et des personnes, optimisation operationnelle.

**Analyse de l'interet legitime** : La geolocalisation est limitee aux heures de travail et aux periodes d'activite de livraison. Le suivi est necessaire pour la gestion operationnelle de la flotte et la securite. Les chauffeurs sont informes du dispositif.

### Obligations specifiques

| Obligation | Statut |
|---|---|
| AIPD (analyse d'impact) | **[A realiser]** |
| Information des employes (article L.1222-4 du Code du travail) | **[A verifier]** |
| Consultation du CSE / representants du personnel | **[A verifier]** |
| Declaration / information de la CNIL (si AIPD revele risque eleve residuel) | **[A verifier apres AIPD]** |
| Desactivation hors heures de travail | **Implemente** -- la transmission ne se fait que pendant une tournee assignee et cesse a sa cloture |
| Information individuelle tracee (accuse de lecture de la notice) | **Implemente** -- notice versionnee + journal append-only par appareil |
| Detection des coupures de signal | **Implemente** -- alerte `NO_GPS` nominative des qu'une tournee en cours cesse d'emettre (aucune application ne peut empecher la desactivation de la permission systeme : seul un MDM le pourrait) |

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Chauffeurs-livreurs | Salaries ou prestataires en activite de livraison |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Position GPS (latitude, longitude) | Localisation | Suivi de flotte en temps reel |
| Vitesse du vehicule | Localisation | Securite routiere, estimation d'arrivee |
| Cap (heading) | Localisation | Representation cartographique |
| Precision du signal GPS | Donnee technique | Fiabilite du positionnement |
| Horodatage de la position | Donnee temporelle | Historique de trajet |
| Identifiant du chauffeur | Identification | Association position/personne |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Service logistique interne (dispatching) | Suivi en temps reel |
| Encadrement operationnel | Gestion de flotte |

Les donnees de geolocalisation ne doivent en aucun cas etre utilisees pour le controle du temps de travail des salaries (recommandation CNIL).

### Transferts hors Union europeenne

Aucun transfert hors UE.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Positions GPS en temps reel | 30 jours (purge automatique) | Periode operationnelle raisonnable |

La purge automatique a 30 jours est implementee dans le systeme.

### Mesures de securite

- Authentification obligatoire
- Controle d'acces restreint aux operateurs habilites
- Chiffrement des communications (HTTPS/TLS)
- Purge automatique des donnees a 30 jours
- Journalisation des acces aux donnees de geolocalisation
- Pas de geolocalisation en dehors des periodes de travail

---

## Traitement n 3 -- Gestion des acces et authentification

### Finalite du traitement

Gestion des comptes utilisateurs de la plateforme CHAOS : creation, modification et suppression des comptes, authentification, gestion des droits d'acces, securite du systeme d'information.

### Base legale (article 6 du RGPD)

- **Article 6.1.f** -- Interet legitime du responsable de traitement : securite du systeme d'information, protection des donnees.

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Chauffeurs-livreurs | Utilisateurs de l'application mobile |
| Personnel administratif | Utilisateurs du back-office |
| Administrateurs systeme | Gestion de la plateforme |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Nom d'utilisateur (username) | Identification | Authentification |
| Adresse email | Contact | Communication, recuperation de compte |
| Mot de passe (hache) | Securite | Authentification (stocke uniquement sous forme de hash) |
| Roles et permissions | Autorisation | Controle d'acces (RBAC) |
| Regions assignees | Autorisation | Perimetre d'acces |
| Code badge | Identification | Authentification physique |
| Adresse IP de connexion | Donnee technique | Securite, detection d'anomalies |
| Date de derniere connexion | Donnee temporelle | Gestion des comptes inactifs |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Administrateurs systeme | Gestion des comptes |
| Service securite informatique | Detection d'incidents |

### Transferts hors Union europeenne

Aucun transfert hors UE.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Comptes actifs | Duree de la relation contractuelle / du contrat de travail | Necessaire a l'acces au systeme |
| Comptes desactives | **[A definir -- recommandation : suppression a 6 mois apres depart]** | Periode de transition |
| Journaux de connexion | **[A definir -- recommandation : 12 mois]** | Securite |

> **ACTION REQUISE** : Definir une procedure de desactivation et suppression des comptes lors du depart des collaborateurs.

### Mesures de securite

- Mots de passe haches (jamais stockes en clair)
- Politique de complexite des mots de passe
- Controle d'acces base sur les roles (RBAC)
- Journalisation des connexions et tentatives echouees
- Chiffrement des communications (HTTPS/TLS)

---

## Traitement n 4 -- Audit et tracabilite

### Finalite du traitement

Journalisation des actions effectuees sur la plateforme CHAOS : suivi des modifications, detection d'anomalies, investigation en cas d'incident de securite, conformite reglementaire.

### Base legale (article 6 du RGPD)

- **Article 6.1.f** -- Interet legitime du responsable de traitement : securite du systeme d'information, tracabilite des operations, conformite.

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Ensemble des utilisateurs | Toute personne effectuant des actions sur la plateforme |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Identifiant de l'utilisateur | Identification | Attribution de l'action |
| Type d'action effectuee | Donnee operationnelle | Tracabilite |
| Entite et champs modifies | Donnee operationnelle | Historique des changements |
| Horodatage de l'action | Donnee temporelle | Chronologie |
| Adresse IP | Donnee technique | Securite |
| Tentatives de connexion (succes/echec) | Donnee de securite | Detection d'intrusion |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Administrateurs systeme | Investigation d'incidents |
| Service securite informatique | Detection de menaces |
| Autorites competentes (sur requisition) | Obligation legale |

### Transferts hors Union europeenne

Aucun transfert hors UE.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Journaux d'audit | **12 mois glissants** (plancher technique : 6 mois, non contournable) | Securite et conformite — decision 2026-07 |
| Logs techniques (stdout Docker) | 6 mois (agregation Loki prevue, action B4) | Securite |

> **IMPLEMENTE (2026-07-08)** : politique de retention centralisee (table
> `retention_policies`, API superadmin `/api/retention`) avec purge automatique
> quotidienne et journalisation de chaque purge (`RETENTION_PURGE`).
> Categories couvertes : journaux d'audit (365 j), positions GPS brutes (60 j,
> norme CNIL geolocalisation), SMS traites (365 j), photos operationnelles
> (365 j — anomalies, declarations, inspections, tickets, preuves de controle).

### Mesures de securite

- Acces restreint aux administrateurs habilites
- Integrite des journaux (protection contre la modification)
- Chiffrement des communications
- Stockage securise

---

## Traitement n 5 -- Gestion des SMS operationnels

### Finalite du traitement

Envoi de notifications SMS aux chauffeurs pour la communication operationnelle : notifications de tournee, alertes, instructions de livraison.

### Base legale (article 6 du RGPD)

- **Article 6.1.b** -- Execution d'un contrat : les SMS sont envoyes dans le cadre de l'execution du contrat de travail ou de prestation.

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Chauffeurs-livreurs | Destinataires des notifications operationnelles |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Numero de telephone mobile | Contact | Acheminement du SMS |
| Contenu du message | Communication | Notification operationnelle |
| Statut d'envoi (envoye, delivre, echec) | Donnee technique | Suivi de delivrabilite |
| Horodatage d'envoi | Donnee temporelle | Tracabilite |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Prestataire SMS (operateur) | Acheminement technique des messages |
| Service logistique interne | Suivi des notifications |

> **NOTE** : Verifier que le contrat avec le prestataire SMS inclut une clause de sous-traitance conforme a l'article 28 du RGPD.

### Transferts hors Union europeenne

Aucun transfert hors UE. **[A verifier avec le prestataire SMS]**

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| SMS et metadonnees | 30 jours apres envoi | Suivi operationnel et resolution d'incidents |

### Mesures de securite

- Acces restreint au service habilite
- Chiffrement des communications avec le prestataire
- Purge automatique a 30 jours

---

## Traitement n 6 -- Inspections vehicules

### Finalite du traitement

Gestion des inspections de securite des vehicules de livraison : saisie de l'etat du vehicule, capture de photos, suivi de la conformite reglementaire de la flotte.

### Base legale (article 6 du RGPD)

- **Article 6.1.c** -- Obligation legale : reglementation du transport routier imposant des controles reguliers de l'etat des vehicules (Code des transports, reglement CE 561/2006).

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Chauffeurs-livreurs | Conducteurs effectuant ou soumis aux inspections |
| Inspecteurs vehicules | Personnel effectuant les controles |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Identite de l'inspecteur | Identification | Responsabilite du controle |
| Identite du chauffeur | Identification | Attribution du vehicule |
| Etat du vehicule (checklist) | Donnee operationnelle | Conformite reglementaire |
| Photos du vehicule | Image | Preuve de l'etat constate |
| Horodatage de l'inspection | Donnee temporelle | Tracabilite |
| Kilometrage | Donnee operationnelle | Suivi d'entretien |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Service maintenance / flotte | Suivi technique |
| Direction operationnelle | Conformite |
| Autorites de controle (sur demande) | Obligation legale |

### Transferts hors Union europeenne

Aucun transfert hors UE.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Rapports d'inspection | **[A definir -- recommandation : 5 ans (conformite transport)]** | Obligation reglementaire |
| Photos | **[A definir -- recommandation : 2 ans]** | Preuve en cas de litige |

> **ACTION REQUISE** : Definir la duree de conservation des rapports d'inspection en conformite avec la reglementation transport applicable.

### Mesures de securite

- Acces restreint au personnel habilite
- Chiffrement des communications
- Stockage securise des photos

---

## Traitement n 7 -- Gestion des consignes et contenants

### Finalite du traitement

Suivi des mouvements de contenants consignes (futs, caisses, palettes) : enregistrement des mouvements entre depots et points de vente, gestion des stocks, detection des anomalies et ecarts.

### Base legale (article 6 du RGPD)

- **Article 6.1.b** -- Execution d'un contrat : le suivi des contenants s'inscrit dans le cadre des relations commerciales avec les points de vente.

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Contacts des points de vente (PDV) | Personnes impliquees dans la reception/restitution de contenants |
| Chauffeurs-livreurs | Personnel effectuant les mouvements de contenants |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Identifiant du PDV et contact | Identification | Suivi des mouvements |
| Identifiant du chauffeur | Identification | Attribution des operations |
| Mouvements de contenants (quantites, types) | Donnee operationnelle | Gestion des stocks |
| Anomalies declarees | Donnee operationnelle | Resolution d'ecarts |
| Horodatage des operations | Donnee temporelle | Tracabilite |

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Service logistique | Gestion des stocks |
| Service commercial | Relation client |
| Points de vente (leurs propres donnees) | Transparence contractuelle |

### Transferts hors Union europeenne

Aucun transfert hors UE.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Mouvements de contenants | Duree de la relation commerciale + prescription legale | Execution contractuelle |
| Historique des anomalies | **[A definir -- recommandation : 2 ans]** | Resolution des litiges |

### Mesures de securite

- Controle d'acces base sur les roles
- Chiffrement des communications
- Journalisation des operations

---

## Traitement n 8 -- Facturation et surcharges

### Finalite du traitement

Gestion de la facturation liee aux operations de transport : calcul des surcharges carburant (gasoil), taxe kilometrique, generation des donnees de facturation.

### Base legale (article 6 du RGPD)

- **Article 6.1.b** -- Execution d'un contrat : la facturation s'inscrit dans le cadre des relations contractuelles avec les transporteurs et fournisseurs.
- **Article 6.1.c** -- Obligation legale : obligations comptables et fiscales.

### Categories de personnes concernees

| Categorie | Description |
|---|---|
| Transporteurs / carriers | Prestataires de transport |
| Fournisseurs | Partenaires commerciaux |

### Categories de donnees a caractere personnel

| Donnee | Caractere | Justification |
|---|---|---|
| Raison sociale, coordonnees | Identification | Facturation |
| Donnees de facturation (montants, references) | Donnee financiere | Comptabilite |
| Kilometrages et taxes associees | Donnee operationnelle | Calcul des surcharges |
| Indices de surcharge carburant | Donnee operationnelle | Ajustement tarifaire |

> **Note** : Ce traitement concerne principalement des personnes morales. Les donnees a caractere personnel sont limitees aux contacts individuels au sein de ces entites.

### Destinataires des donnees

| Destinataire | Justification |
|---|---|
| Service comptabilite | Traitement des factures |
| Transporteurs et fournisseurs (leurs propres donnees) | Relation contractuelle |
| Administration fiscale (sur demande) | Obligation legale |

### Transferts hors Union europeenne

Aucun transfert hors UE.

### Duree de conservation

| Donnee | Duree | Justification |
|---|---|---|
| Pieces comptables | 10 ans (article L.123-22 du Code de commerce) | Obligation legale |
| Donnees de facturation | 10 ans | Obligation legale |

### Mesures de securite

- Acces restreint au service comptabilite
- Chiffrement des communications
- Sauvegardes regulieres

---

## Mesures de securite transversales

Les mesures de securite suivantes s'appliquent a l'ensemble des traitements de la plateforme CHAOS :

### Securite technique

| Mesure | Description |
|---|---|
| Chiffrement en transit | HTTPS/TLS pour toutes les communications |
| Authentification | Systeme d'authentification par identifiant/mot de passe avec hachage |
| Controle d'acces | Modele RBAC (Role-Based Access Control) avec segmentation par region |
| Journalisation | Enregistrement des acces et actions (audit trail) |
| Sauvegardes | Sauvegardes regulieres des bases de donnees |

### Securite organisationnelle

| Mesure | Description |
|---|---|
| Politique de mots de passe | Exigences de complexite pour les mots de passe |
| Gestion des habilitations | Revue periodique des droits d'acces **[A mettre en place]** |
| Sensibilisation | Formation des utilisateurs aux bonnes pratiques **[A mettre en place]** |
| Gestion des incidents | Procedure de notification en cas de violation de donnees **[A formaliser]** |

---

## Sous-traitants (article 28 du RGPD)

| Sous-traitant | Traitement concerne | Localisation | Contrat art. 28 |
|---|---|---|---|
| Prestataire SMS | Envoi de notifications (traitement n 5) | **[A completer]** | **[A verifier]** |
| Hebergeur infrastructure | Ensemble des traitements | **[A completer -- confirmer UE]** | **[A verifier]** |

> **ACTION REQUISE** : Identifier l'ensemble des sous-traitants au sens du RGPD et s'assurer que des contrats conformes a l'article 28 sont en place.

---

## Exercice des droits des personnes concernees

Conformement aux articles 15 a 22 du RGPD, les personnes concernees disposent des droits suivants :

| Droit | Applicable | Modalites |
|---|---|---|
| Droit d'acces (art. 15) | Oui | Sur demande aupres du responsable de traitement |
| Droit de rectification (art. 16) | Oui | Sur demande ou en libre-service selon le traitement |
| Droit a l'effacement (art. 17) | Sous conditions | Sauf obligation legale de conservation |
| Droit a la limitation (art. 18) | Oui | Sur demande motivee |
| Droit a la portabilite (art. 20) | Selon base legale | Applicable si consentement ou contrat |
| Droit d'opposition (art. 21) | Oui (interet legitime) | Examen au cas par cas |

**Point de contact pour l'exercice des droits** : [A completer -- adresse email dediee recommandee]

**Delai de reponse** : 1 mois maximum a compter de la reception de la demande (article 12.3 du RGPD).

---

## Plan d'actions de mise en conformite

Les actions suivantes ont ete identifiees lors de la redaction du present registre :

| Priorite | Action | Traitement(s) | Echeance |
|---|---|---|---|
| **CRITIQUE** | Realiser une AIPD pour la geolocalisation des chauffeurs | n 2 | **[A definir]** |
| **CRITIQUE** | Designer un DPO (suivi systematique a grande echelle) | Tous | **[A definir]** |
| **HAUTE** | Verifier la consultation des representants du personnel pour la geolocalisation | n 2 | **[A definir]** |
| **HAUTE** | Formaliser les durees de conservation manquantes | n 1, 4, 6 | **[A definir]** |
| **HAUTE** | Implementer la purge automatique des journaux d'audit | n 4 | **[A definir]** |
| **HAUTE** | Verifier les contrats sous-traitants (article 28) | n 5 | **[A definir]** |
| MOYENNE | Mettre en place une procedure de gestion des droits des personnes | Tous | **[A definir]** |
| MOYENNE | Formaliser la procedure de notification de violation de donnees | Tous | **[A definir]** |
| MOYENNE | Mettre en place la revue periodique des habilitations | n 3 | **[A definir]** |
| NORMALE | Former les utilisateurs a la protection des donnees | Tous | **[A definir]** |

---

## Historique des modifications du registre

| Date | Version | Auteur | Description |
|---|---|---|---|
| 2026-04-03 | 1.0 | [A completer] | Creation initiale du registre |

---

*Ce registre est tenu conformement a l'article 30 du Reglement (UE) 2016/679 relatif a la protection des personnes physiques a l'egard du traitement des donnees a caractere personnel. Il doit etre mis a jour a chaque modification des traitements et tenu a la disposition de la CNIL sur demande.*
