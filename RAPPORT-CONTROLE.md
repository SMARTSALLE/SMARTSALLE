# RAPPORT DE CONTRÔLE — SMARTSALLE ISPITS

**Application :** SmartSalle ISPITS — Gestion intelligente des salles, des emplois du temps et des réservations (ISPITS Laâyoune)
**Date du contrôle :** 05/10/2026
**Résultat global :** ✅ **152 / 152 tests automatisés réussis** — 20 écrans contrôlés sans erreur JavaScript
**Rapport machine détaillé :** `data/test-report.json`

---

## 1. Fonctionnalités créées

### Authentification & comptes
- Inscription (Nom, Prénom, Email, Mot de passe, Confirmation, Rôle souhaité).
- Coordinateur : choix de **1 à 3 options maximum** (4ᵉ option refusée côté serveur ET côté base).
- **Code de vérification par email** : 6 chiffres, hashé (scrypt), expiration 15 min, anti-renvoi 60 s, 6 tentatives max.
- Compte bloqué tant que : ① email non vérifié ② administration non validée.
- Connexion / déconnexion, sessions en base (30 j, jeton hashé, cookie `HttpOnly`), changement de mot de passe, réinitialisation par l'admin.
- **Mot de passe oublié** (`#/forgot`) : demande de code par email → nouveau mot de passe. Mêmes protections que la vérification email (code hashé scrypt, expiration 15 min, anti-renvoi 60 s, 6 tentatives max) ; réponses génériques quand le compte est inconnu ou l'email non vérifié (aucune énumération de comptes) ; à la réinitialisation, **toutes les sessions existantes sont révoquées** et l'utilisateur reçoit une notification.
- Page **DEMANDES DE COMPTES** : Nom, Prénom, Email, Rôle, Options demandées, Email vérifié, Date, Statut (EN ATTENTE / VALIDÉ / REFUSÉ) + actions [VALIDER] [REFUSER].

### Options & coordinateurs
- Table `options` (code, nom, description, statut) entièrement gérée par l'administration.
- Table `coordinator_options` : `user_id, option_id, status (REQUESTED / APPROVED / REJECTED), requested_at, approved_at, approved_by`.
- Une option demandée n'est **jamais** active automatiquement : approbation admin obligatoire.
- Écran **« Sélectionnez votre option »** si plusieurs options approuvées ; ouverture directe si une seule ; écran de demande si aucune.
- Changement d'option active impossible sans approbation (403 `OPTION_NOT_APPROVED`).
- Le changement d'option met à jour groupes, modules, réservations, statistiques et planning instantanément.

### Salles & recherche
- **TROUVER UNE SALLE** : date + heure début/fin (+ équipement, étage) → toutes les salles disponibles.
- **SMART SEARCH** : « trouve-moi une salle mardi de 10h à 12h » ; si une information manque, seule celle-ci est redemandée.
- **Recherche globale** : salle, option, groupe, module, enseignant, réservation.
- Page publique en lecture seule par **QR code** (statut, planning, prochaine réservation).

### Réservations & planning
- Création complète : Option, Groupe, Module, Enseignant (+ saisi manuelle `teacher_name_override` / `module_name_override`), Date, Début, Fin, **Nombre d'étudiants (informatif)**, Salle, Équipement, Notes.
- Modification, annulation, **REPROGRAMMATION** (nouvelle vérification des conflits).
- **COPIER LA JOURNÉE / COPIER LA SEMAINE** : conflits détectés et ignorés, aucun doublon.
- Planning hebdomadaire lundi→samedi 08:00→18:00 (dimanche fermé), vues « Par jour » et « Par salle ».
- **PLANNING GLOBAL** avec filtres option / groupe / module / enseignant / salle / date / étage.
- **Impression A4 paysage** : en-tête ROYAUME DU MAROC → MINISTÈRE → ISPITS LAÂYOUNE → SMARTSALLE ISPITS → EMPLOI DU TEMPS, semestre, année, option, groupe, + 4 signatures (Coordinateur d'Option, Coordinateur de Filière, DAC, Directeur) ; boutons Aperçu / Imprimer / Enregistrer en PDF.
- **Exports** : Excel `.xls` et CSV pour planning, réservations, salles, groupes, modules, enseignants, options, utilisateurs, historique.
- **VIDER LE PLANNING** (admin, confirmation saisie « VIDER ») : supprime uniquement les réservations.
- **Historique / audit** : utilisateur, action, date, élément, valeur avant / valeur après.

### Temps réel & multi-utilisateurs
- **Server-Sent Events** (`/api/events`) : création / modification / annulation / copie de réservation, comptes, options, salles, paramètres, notifications.
- Présence : « N utilisateurs en ligne » dans la barre supérieure.
- Notifications (réservation créée/annulée, compte validé/refusé, nouvelle demande d'option, etc.).

### Tables de travail personnelles
- **MES NOTES** (privées), **MES TÂCHES** (LOW/NORMAL/HIGH/URGENT × À FAIRE/EN COURS/TERMINÉE), **NOTIFICATIONS**.

### Paramètres (§54)
Nom de l'établissement, logo (upload), horaires, jours de travail/fermeture, semestre, année universitaire, texte d'en-tête PDF, texte complémentaire, 4 signatures, paramètres de notifications, configuration SMTP.

**Volumes :** 81 routes API · 20 écrans SPA · 17 tables · 5 déclencheurs SQL.

---

## 2. Base de données créée

Moteur : **SQLite réel** (`node:sqlite`), fichier persistant `data/smartsalle.db` en mode **WAL** — aucune donnée principale en localStorage.

| # | Table | Rôle |
|---|-------|------|
| 1 | `users` | comptes, rôles, statuts, email vérifié, option active, fiche enseignant |
| 2 | `sessions` | sessions serveur (jeton hashé, expiration) |
| 3 | `email_codes` | codes de vérification hashés, expiration, tentatives |
| 4 | `options` | options de formation |
| 5 | `coordinator_options` | demandes/approbations d'options (REQUESTED/APPROVED/REJECTED) |
| 6 | `rooms` | 15 salles, statut, réservée-pour, réservable, équipements, QR |
| 7 | `groups` | groupes (option, semestre, année, nb étudiants *informatif*) |
| 8 | `modules` | modules (option, groupe, enseignant, semestre, volume horaire) |
| 9 | `teachers` | enseignants (aucune donnée fictive initialisée) |
| 10 | `reservations` | réservations (jour, créneau aligné 30 min, statut) |
| 11 | `reservation_locks` | **verrous de créneau** — garantie anti-chevauchement |
| 12 | `slot_grid` | grille des demi-heures utilisée par les déclencheurs |
| 13 | `notifications` | notifications |
| 14 | `notes` | notes privées |
| 15 | `tasks` | tâches |
| 16 | `audit_log` | historique / audit |
| 17 | `settings` | paramètres de l'établissement |

**Déclencheurs (garanties appliquées PAR LA BASE, pas par le frontend) :**

| Déclencheur | Effet |
|---|---|
| `trg_res_lock_insert` | pose un verrou par demi-heure occupée à l'insertion |
| `trg_res_lock_update` | rejoue les verrous à la reprogrammation (la libère en cas d'annulation) |
| `trg_res_lock_delete` | libère les verrous à la suppression |
| `trg_res_restricted_insert` | **refuse** toute réservation sur `is_available_for_normal_booking = 0` (S12-1ER) sauf rôle admin |
| `trg_res_restricted_update` | idem en modification |

Toute insertion chevauchante échoue par **`UNIQUE constraint failed: reservation_locks`** → l'API répond `409 SCHEDULE_CONFLICT`, même en cours critique ou en accès direct SQL.

---

## 3. Rôles créés

| Rôle | Accès |
|---|---|
| **ADMINISTRATION** (`admin`) | contrôle complet : comptes, options, groupes, modules, enseignants, salles, équipements, réservations, planning global, audit, paramètres, exports, vider le planning |
| **COORDINATEUR** (`coordinateur`) | consultation de **toutes** les disponibilités, réservations et modifications **uniquement pour ses options approuvées** ; groupes/modules/enseignants/salles en lecture ; notes et tâches personnelles |
| **ENSEIGNANT** (`enseignant`) | consultation seule : son planning, ses modules, ses réservations, ses salles, ses horaires ; notifications |

Auto-inscription limitée à `coordinateur` et `enseignant` (`ROLE_NOT_ALLOWED` pour `admin`). Un compte enseignant validé est automatiquement relié à sa **vraie** fiche enseignant (créée à partir de son nom réel, jamais fictive).

---

## 4. Permissions (contrôlées côté serveur / base)

Vérifiées par les tests 152 / 152 — **le frontend ne fait que masquer, le serveur refuse** :

| Contrôle | Réponse serveur |
|---|---|
| Accès anonyme à l'API | `401 UNAUTHENTICATED` |
| Compte non vérifié / non validé | `403 EMAIL_NOT_VERIFIED` / `403 ACCOUNT_PENDING` / `403 ACCOUNT_REFUSED` |
| Page réservée à un autre rôle | `403 FORBIDDEN` |
| Enseignant qui crée une réservation | `403 FORBIDDEN` |
| Coordinateur sur `/api/admin/*` (salles, paramètres, comptes, audit, vider le planning) | `403 FORBIDDEN` |
| Coordinateur qui modifie/supprime la réservation d'une autre option | `403 NOT_OWNER` |
| Coordinateur qui réserve pour une option non approuvée | `403 OPTION_NOT_ALLOWED` |
| Auto-attribution d'une option non approuvée | `403 OPTION_NOT_APPROVED` |
| Plus de 3 options demandées | `400 TOO_MANY_OPTIONS` |
| Réservation sur S12-1ER par un non-admin | `403 ROOM_RESTRICTED` (et `RAISE(ABORT)` en base) |
| Modification d'une note/tâche d'un autre utilisateur | `403 NOT_OWNER` |
| Export utilisateurs/historique par un non-admin | `403 FORBIDDEN` |
| CSRF | en-tête `X-Requested-With` exigé sur les mutations + cookie `SameSite=Lax` |
| Mots de passe | **scrypt** (salt + `timingSafeEqual`), jamais stockés en clair |
| Secrets | aucun secret côté frontend ; SMTP/JWT absents du navigateur |

---

## 5. Salles initialisées (15, exactement l'inventaire demandé)

| Étage | Salles |
|---|---|
| **Rez-de-chaussée** | S01, S02, S03, S04, S05, **S12-RDC**, S13 |
| **Premier étage** | S06, S07, S08, S09, S10, S11, **S12-1ER** |
| **Amphithéâtre** | **AMPHI** — « Entrée de l'ISPITS — à gauche » |

- `S12-1ER` : `status = RESERVED`, `reserved_for = MASTER MANAGEMENT`, `is_available_for_normal_booking = 0` → exclue des recherches, des propositions, des salles libres et des réservations normales ; visible par l'administration et statut visible par les coordinateurs.
- `S12-RDC` : `status = ACTIVE`, `is_available_for_normal_booking = 1` — **salle distincte** de S12-1ER (2 clés, 2 identifiants, jamais « Salle 12 »).
- **Aucune colonne de capacité** n'existe dans la table `rooms` (contrôle : `PRAGMA table_info(rooms)` sans `capacity`). Le nombre d'étudiants n'est jamais utilisé comme filtre.
- **Aucune donnée fictive** : 0 enseignant, 0 groupe, 0 module, 0 réservation, 0 emploi du temps initialisé (le planning démarre vide).
- **Catalogue complet des filières ISPITS** : 18 options seedées et regroupées en 4 filières (colonnes `code`, `name`, `category`) — Soins Infirmiers (IP, IBO, ISM, IPAR/IDAR, ISUSI, ISF), Techniques de Santé (RAD, LAB, PREP, DN, SE, SS), Rééducation et Réhabilitation (KINE, ORTHO, ERGO, PSYCHOM), Autres Filières (SF, AS). Insertion idempotente au démarrage (migration `ALTER TABLE` des bases existantes), entièrement modifiables par l'administration.

**Compte initial :** `admin@ispits.ma` / `Smartsalle@2026` (aussi écrit dans `data/initial-admin.txt` — à changer dès la première connexion, ou via `ADMIN_EMAIL` / `ADMIN_PASSWORD` au premier démarrage).

---

## 6. Tests effectués

**Commande :** `npm test` → `node tests/run-tests.js` (base de test dédiée `data/test-smartsalle.db`, serveur démarré en écoute réelle)
**Résultat : 152 / 152 OK** — rapport JSON : `data/test-report.json`

### Les 25 tests obligatoires du cahier des charges
| # | Test | Résultat |
|---|---|---|
| 1 | Création d'un compte | ✅ |
| 2 | Vérification email (mauvais code refusé, bon code accepté, code à usage unique, cooldown de renvoi) | ✅ |
| 3 | Validation par administration (connexion refusée avant validation) | ✅ |
| 4 | Demande de 1 option | ✅ |
| 5 | Demande de 3 options (+ refus d'une 4ᵉ) | ✅ |
| 6 | Refus d'une option (`REJECTED` + notification) | ✅ |
| 7 | Validation d'une option (`APPROVED` + `approved_by` + notification) | ✅ |
| 8 | Sélection de l'option active (+ refus d'auto-attribution) | ✅ |
| 9 | Recherche d'une salle | ✅ |
| 10 | Réservation | ✅ |
| 11 | Détection des chevauchements (08:30-09:30, 09:00-11:00, 09:30-10:30 bloqués / 10:00-12:00 autorisé) | ✅ |
| 12 | Modification | ✅ |
| 13 | Annulation (créneau redevenu libre) | ✅ |
| 14 | Reprogrammation (re-vérification des conflits) | ✅ |
| 15 | Synchronisation temps réel (événement reçu par un 2ᵉ utilisateur) | ✅ |
| 16 | Protection des réservations des autres options | ✅ |
| 17 | S12-1ER exclue des recherches (et rejet direct en base) | ✅ |
| 18 | S12-RDC disponible et distincte | ✅ |
| 19 | AMPHI disponible selon planning (occupée → absente, libre → présente) | ✅ |
| 20 | Nombre d'étudiants non utilisé comme filtre (paramètre ignoré, aucune colonne de capacité) | ✅ |
| 21 | Planning lundi-samedi (réservation du dimanche refusée) | ✅ |
| 22 | Impression PDF (en-tête configurable + vue A4 paysage) | ✅ |
| 23 | Export Excel (`.xls` valide + CSV) | ✅ |
| 24 | QR code (SVG + page publique en lecture seule, token invalide refusé) | ✅ |
| 25 | Mobile responsive (5 points de rupture `@media`, viewport, sidebar + navigation basse) | ✅ |

### Contrôles ajoutés au-delà du cahier des charges
- **Garantie DB prouvée** : insertion SQL directe chevauchante rejetée par SQLite (`reservation_locks`) — le contournement de l'API est impossible.
- **Course critique** : 2 insertions simultanées → exactement **1** réussit.
- Vider le planning : confirmation obligatoire, réservations/verrous supprimés, salles/utilisateurs/options/groupes/modules **conservés**.
- **Mot de passe oublié** : réponse générique si compte inconnu, code erroné / mot de passe trop court / confirmation différente refusés, ancien mot de passe rejeté après réinitialisation, sessions révoquées, code à usage unique.
- Persistance : fermeture/réouverture du fichier, mêmes données (DB + WAL ≈ 2,7 Mo).
- Exports : type MIME Excel, contenu, droits (utilisateurs/historique = admin).
- Contrôle serveur exhaustif (tableau ci-dessus).
- **Navigateur réel** : les 20 écrans chargés sans erreur JS, réservation créée (201) et conflit renvoyé **409** depuis l'interface, planning affichant les créneaux, notifications temps réel reçues.

---

## 7. Problèmes restants / limites connues

| # | Point | État | Impact / contournement |
|---|---|---|---|
| 1 | **Envoi d'email réel** | Aucun serveur SMTP n'est configuré sur ce poste. Les codes sont écrits dans `data/outbox/*.eml`, tracés en console et affichés en mode local (`expose_dev_codes = 1`). | Renseigner SMTP dans **Paramètres** (ou `smtp_host`) puis désactiver `expose_dev_codes` : l'envoi devient réel. |
| 2 | **PDF** | Généré via le navigateur (Imprimer → *Enregistrer en PDF*), format A4 paysage contrôlé par CSS `@page`. Pas de moteur PDF côté serveur (aucune dépendance lourde ajoutée). | Suffisant pour l'impression ; intégration `puppeteer`/`pdfkit` possible si besoin de PDF générés côté serveur. |
| 3 | **Rappel de tâches** | Les tâches affichent échéance/priorité, mais aucun job de fond n'envoie de rappel automatique. | Ajouté en option (cron/`setInterval` serveur) si vous le souhaitez. |
| 4 | **Notification « conflit détecté »** | Le conflit répond `409` + toast, sans créer de ligne de notification. | Choisi volontairement pour éviter le bruit ; modifiable. |
| 5 | **Base SQLite monoposte** | Parfait pour l'institution (WAL, une base = sauvegarde simple). | Prévoir Postgres si plusieurs sites/serveurs. |
| 6 | **Tests E2E navigateur** | 152 tests API/base automatisés ; l'interface a été contrôlée écran par écran dans un vrai navigateur, sans suite Playwright dédiée. | Peut être ajoutée. |
| 7 | **Compte initial** | Mot de passe par défaut `Smartsalle@2026` (fichier `data/initial-admin.txt`). | À changer immédiatement après la mise en production. |
| 8 | Données de démonstration | Un compte `coord1@test.ma` (refusé) et une réservation de test existent dans la base de travail. | `VIDER LE PLANNING` + suppression du compte depuis **Utilisateurs**. |

Aucun autre problème connu : aucune dépendance native, aucun build, aucune erreur console relevée.

---

## 8. Étapes pour publier l'application

1. **Prérequis** — Node.js ≥ 22.5 (un runtime portable est fourni dans `.tools/node-v24.21.0-win-x64/`).
2. **Lancer** — `npm start` (ou `start.bat` sur Windows) ; variables : `PORT=3000`, `HOST=0.0.0.0`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SMARTSALLE_DB`.
3. **Vérifier** — `npm test` → 152 / 152 avant toute mise en production.
4. **HTTPS + domaine** — placer un reverse proxy devant le serveur :
   - *Caddy* (HTTPS automatique) : `smartsalle-ispits.ma { reverse_proxy 127.0.0.1:3000 }`
   - *Nginx* : `proxy_pass http://127.0.0.1:3000;` + certificat Let's Encrypt (le serveur lit `X-Forwarded-Proto` pour le cookie `Secure`).
   - Enregistrer `smartsalle-ispits.ma` auprès de votre registrar (A/AAAA record).
5. **Base persistante** — conserver le dossier `data/` (base + WAL + logo + outbox) hors de tout `git clean` ; sauvegarde : copie de `data/smartsalle.db*` (ou `sqlite3 ... ".backup"`), idéalement planifiée chaque nuit.
6. **Sessions** — cookies `HttpOnly` + `SameSite=Lax` ; le serveur passe automatiquement `Secure` derrière HTTPS ; déconnexion automatique à 30 j, révocation possible (`logout-all`, suppression de compte).
7. **Email** — Paramètres → SMTP (hôte, port, utilisateur, expéditeur) puis décocher « afficher le code en local ».
8. **Compte admin** — changer le mot de passe par défaut, puis créer les comptes coordinateurs/enseignants réels.
9. **Exécution continue** — Linux : `systemd` ou `pm2 start server/index.js --name smartsalle` ; Windows : tâche planifiée / service NSSM ; redémarrage automatique au crash.
10. **Domaine personnalisé** — aucune modification de code : l'application se sert sur n'importe quel hôte/nom de domaine.

---

### Structure livrée

```
server/            backend (Node, zéro dépendance native)
  db.js            schéma SQLite + déclencheurs + seed
  auth.js mail.js realtime.js services.js util.js router.js index.js
  routes/          auth, catalog, reservations, admin, personal, exports
public/            frontend SPA (HTML/CSS/JS, sans build)
  styles.css       design system responsive + impression A4 paysage
  js/              api, ui, app (routeur/coque), views/*
tests/run-tests.js suite de 152 tests
data/              smartsalle.db, initial-admin.txt, outbox/, test-report.json
RAPPORT-CONTROLE.md  README.md
```
