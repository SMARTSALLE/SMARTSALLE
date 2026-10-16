# SmartSalle ISPITS — Rapport de tests finaux

**Date :** 8 octobre 2026 · **Node :** v24.21.0 · **Serveur :** `http://localhost:3000` (PID démarré avec `PORT=3000` explicite)
**Périmètre :** correction du client SMTP, statut de livraison email, écran de vérification, page principale.

> ⚠️ **Rapport historique (8 octobre 2026).** Depuis le **16 octobre 2026**, l'étape de vérification par code
> email à l'inscription a été supprimée (compte créé « en attente de validation administrative », SMTP non requis)
> et une navigation commune a été ajoutée (barre principale publique, menu latéral par rôle, retour en haut).
> Les contrôles 3, 4, 7 et l'écran de vérification mentionnés ci-dessous décrivent l'application telle qu'elle
> était à cette date. Le référentiel actuel est `npm test` → **305 / 305 tests réussis**.

---

## 1. Résumé exécutif

| # | Contrôle | Résultat |
|---|---|---|
| 1 | Syntaxe `node --check` (6 fichiers JS modifiés) | **OK** — 0 erreur |
| 2 | Suite de tests `tests/run-tests.js` | **152/152**, `EXIT=0` |
| 3 | E2E SMTP « plain » (faux serveur local, AUTH + DATA) | **14/14**, exit 0 |
| 4 | E2E SMTP **STARTTLS** (mode par défaut, port 587, TLS réel) | **11/11**, exit 0 |
| 5 | Page principale `public/index.html` + 11 ressources | **200**, bons `Content-Type` |
| 6 | Navigateur : rendu, console, réseau (rechargement à froid) | **0 erreur console**, tout en 200 |
| 7 | Inscription réelle → écran de vérification → code accepté | **ok:true** (chaîne complète) |
| 8 | Bouton « 📧 Tester l'envoi SMTP » (admin) | **200** — message honnête « SMTP non configuré » |

**Aucune régression, aucun nouveau correctif nécessaire pendant cette passe.**

---

## 2. Détail des vérifications

### 2.1 Syntaxe
`node --check` sur `server/mail.js`, `server/routes/auth.js`, `server/routes/admin.js`,
`public/js/views/admin.js`, `public/js/views/auth.js`, `public/js/app.js` → tous OK.

### 2.2 Suite de tests complète
```
RÉSULTAT : 152/152 tests réussis   (TESTS_EXIT=0)
```
Journal : `/tmp/tests-final.log` (173 lignes). Couvre comptes, sessions, options,
réservations, verrous, réinitialisation de mot de passe, persistance SQLite.

### 2.3 E2E SMTP — chemin « plain » (14/14)
Faux serveur SMTP local captant le dialogue :
- `AUTH LOGIN` reçu, utilisateur `demo` + mot de passe `secret` transmis correctement ;
- `MAIL FROM:<no-reply@test.local>`, `RCPT TO:<destinataire>` ;
- code de vérification **présent dans le `DATA`** ;
- **le code reçu par email vérifie le compte** (`ok:true`) ;
- SMTP injoignable → repli `delivery:"outbox"`, compte toujours créé.

### 2.4 E2E SMTP — chemin STARTTLS (11/11) — mode par défaut
Dialogue observé sur le canal chiffré (certificat auto-signé côté test uniquement) :
```
220 → EHLO → STARTTLS → 220 → (TLS) → EHLO → 250
→ AUTH LOGIN → 334 → utilisateur base64 → 334 → mot de passe base64 → 235
→ MAIL FROM → RCPT TO → DATA → « code … : 819345 » → 250 → QUIT
```
Le code extrait du message chiffré vérifie réellement le compte (`ok:true`).

### 2.5 Page principale `public/index.html`
- Fichier présent et intact (SPA + 8 scripts, favicon, `styles.css`) ;
- `GET /` → **200 text/html** ; les 11 ressources citées dans la page → **200**
  (`text/css`, `application/javascript`, `image/png`) ;
- Rendu navigateur : écran « Bienvenue » (Connexion / Créer un compte) correct ;
- **Rechargement à froid : 0 message console, 0 requête en échec** (hors `ERR_ABORTED`
  d'une requête annulée par la navigation, bénin).

### 2.6 Parcours réel de bout en bout (navigateur + API)
1. Connexion admin (session persistée) → **Paramètres** :
   select « Chiffrement SMTP » (`starttls` / `smtps` / `none`, défaut `starttls`) et
   bouton « 📧 Tester l'envoi SMTP » présents.
2. `POST /api/admin/settings/smtp-test` → **200**
   `{"ok":true,"delivered":"outbox","message":"SMTP non configuré (hôte vide) — message conservé dans data/outbox, aucun envoi réel."}`.
3. Inscription réelle (`POST /api/auth/register` → **201**) avec champ `delivery:"outbox"`
   et message honnête ;
4. Écran **Vérification email** : avertissement affiché
   « SMTP non configuré : aucun email n'a réellement été envoyé (copie locale dans data/outbox) »
   + code de test affiché en dev ;
5. `POST /api/auth/verify` avec le code → **`ok:true` — « Adresse email vérifiée. »**
   (compte `email_verified=1`, code consommé en base, audit `EMAIL_VERIFIE` journalisé).

---

## 3. Anomalies observées et conclusions

| Observation | Conclusion |
|---|---|
| `POST /api/auth/verify-email` → 404 | Erreur de nom de route **dans mon test** : la route réelle est `/api/auth/verify`. Aucun bug applicatif. |
| `POST /api/admin/accounts/6/validate` → 404 (×2) | **Comportement correct** : il s'agissait d'un compte de test que j'ai supprimé en base pendant que la liste admin affichait encore l'ancien état → `404 USER_NOT_FOUND « Utilisateur introuvable »`. La route existe et fonctionne (4 validations réussies dans la suite de tests). |
| Double réponse `already_verified:true` sur `/api/auth/verify` | Idempotence voulue : un second appel sur un compte déjà vérifié ne consomme pas de code et répond proprement. |

**Nettoyage effectué :** les 2 comptes de test (`finaltest…@test.ma`, `apitest…@test.ma`)
ont été supprimés de la base ; les comptes réels (admin, coordinateur) sont intacts.

---

## 4. État livré

- **Serveur** : lancé sur `http://localhost:3000`, base `data/smartsalle.db`, journal `/tmp/smartsalle-final.log`.
- **Fichiers de la correction SMTP** (inchangés pendant cette passe, tous vérifiés) :
  `server/mail.js`, `server/routes/auth.js`, `server/routes/admin.js`,
  `public/js/views/admin.js`, `public/js/views/auth.js`, `.env.example`.
- **Page principale** : `public/index.html` sauvegardé et vérifié en l'état.

## 5. Limites restantes

1. **Aucun envoi réel possible sans identifiants SMTP** : `smtp_host` est vide dans
   Paramètres → tant que l'hôte + `SMTP_PASSWORD` (Infisical) ne sont pas renseignés,
   les codes vont dans `data/outbox/`. Renseigner puis cliquer « 📧 Tester l'envoi SMTP ».
2. **Certificats** : le banc de test utilisait un certificat auto-signé
   (`NODE_TLS_REJECT_UNAUTHORIZED=0` **dans le processus de test uniquement**) ; en
   production le client valide normalement le certificat du serveur SMTP.
3. Les scripts de banc SMTP vivent dans `%LOCALAPPDATA%\Temp\smtp-*.js` (hors dépôt).

---

## 6. Suite — impression de l'emploi du temps (8 octobre 2026, même session)

Demande : *« impression total de tableau même si est vide sans programmation »* et
*« corriger mise en page, doit être [la même] que la photo »* (photo = logo SMART SALLE,
identique octet à octet à `public/assets/logo-ispits.png`).

| Contrôle | Avant | Après |
|---|---|---|
| Bandes horaires imprimées (08:00→18:00) | **1** (`08:00-10:00`, seulement les bandes habitées) | **5** — tableau total (`timeBands(..., true)`) |
| Option sans séance (IP, 0 réservation) | quasi-vide | grille complète **5 bandes × 6 jours = 30 cellules vides** + en-tête + 4 signatures |
| En-tête de la page | bloc officiel seul | **logo SMART SALLE centré** (56 px, couleurs conservées à l'impression) **au-dessus** du bloc Royaume du Maroc, puis « EMPLOI DU TEMPS » |
| Note de bas de page | `1 bande(s) horaire(s) de 08:00-10:00` | `5 bande(s) horaire(s) de 08:00 à 18:00` |
| `node --check public/js/views/planning.js` | — | **OK** |
| `tests/run-tests.js` (après éditions) | 152/152 | **152/152, EXIT=0** |
| Fichiers modifiés | — | `public/js/views/planning.js`, `public/styles.css` |

**Non vérifiable ici :** la pagination papier réelle (aucun aperçu d'impression papier
disponible dans les outils) — les contrôles `@page landscape` / `@media print` de la
suite restent verts. Copies temporaires des photos utilisées pour la comparaison :
supprimées de `public/`.

---

## 7. Suite — modifier / supprimer une séance en un clic dans le planning (8 octobre 2026)

Demande : *« ET AUSSI DANS PLANNING EMPLOI LA POSSIBILITÉ D'APPUI SUR UN COURS DANS
LE TABLEAU ET LE SUPPRIMER OU MODIFIER UN CLIC »*.

### Ce qui a été ajouté

- **Actions au survol de la séance** (`.slot-quick`, `no-print`) : boutons **✏️**
  (reprogramme : ouvre le formulaire « Reprogrammer ») et **🗑** (supprime après
  confirmation) affichés en haut à droite de chaque séance — un clic direct.
- **Modale de détail enrichie** (`showReservation`) : clic sur la séance →
  **✏️ Modifier · 🗑 Supprimer · 🖨 Imprimer · Fermer**.
- **Contrôle d'accès client** `canManageReservation(r)` : miroir exact de
  `assertCanManage` serveur — admin ✓, coordinateur uniquement pour ses options
  approuvées ✓, enseignant/invité ✗. Les boutons n'apparaissent pas sinon ; le
  serveur re-vérifie de toute façon (DELETE = `requireCoordinator` + `assertCanManage`).
- Légende du planning mise à jour (« ✏️/🗑 Au survol d'une séance : modifier ou
  supprimer en un clic »).
- Après suppression : `del(/api/reservations/:id)` (annulation = `status=CANCELLED`,
  verrous libérés par le trigger) + `window.onReservationChanged()` → rafraîchissement
  automatique de la grille.

### Vérifications (navigateur, session admin)

| Contrôle | Résultat |
|---|---|
| `node --check` planning.js + reservations.js | **OK** |
| `tests/run-tests.js` (après éditions) | **152/152, EXIT=0** |
| Modale détail (clic sur séance) | 4 boutons : `✏️ Modifier`, `🗑 Supprimer`, `🖨️ Imprimer`, `Fermer` |
| Clic ✏️ au survol | ouvre « Reprogrammer S01 » (13 champs), enregistrement réel OK (17:00→18:00, toasts + grille mise à jour) |
| Clic 🗑 au survol | boîte « Supprimer la séance » → `Annuler` : aucune donnée touchée ; `Supprimer` : séance retirée de la grille |
| Chemin modale → ✏️ / 🗑 | ouvre le formulaire / la confirmation, `Annuler` sans effet, grille intacte |
| Matrice de permissions | admin ✓ · coordinateur option 7 ✓ · coordinateur option 99 ✗ · coordinateur sans option ✗ · enseignant ✗ · invité ✗ |
| Console navigateur | aucun message d'erreur |
| Fichiers servis | `planning.js` (`slot-quick`), `reservations.js` (`canManageReservation`), `styles.css` (5 règles `.slot-quick`) — OK |
| Route impression | `.slot-quick` marqué `no-print` : absent du papier |

### Données de test

Réservation factice `SCRATCH-TEST-E2E` (créée pour le banc) : créée → reprogrammée →
supprimée, puis **purge `hard=1`** — aucune ligne de test ne subsiste en base.
Réservation réelle n°2 (`COURS`, S01) : **jamais modifiée** (`updated_at = NULL`).
Note : la réservation n°1 (S03, « Cours UI ») apparaît `CANCELLED` en base —
annulée à 16:57:41 par **un autre utilisateur (youssef.idouaziz, session distincte,
`audit_log` n°62)**, pas par ce banc de test (notre session = admin n°1, entrées 59–61).

---

## 8. Suite — grille du planning en bandes de 2 h, 5 lignes (9 octobre 2026)

Demande : *« RESPECTER LA MARGE DES HEURES CHAQUE CASE — EXEMPLE 8-10 H, 10-12 H,
12-14 H, 14-16 H, 16-18 H, DONC 5 LIGNES EN TOTAL »*.

| Contrôle | Avant | Après |
|---|---|---|
| Lignes de la grille « Par jour » | **10 lignes d’1 h** (08:00, 09:00, … 17:00) | **5 lignes de 2 h** : `08:00-10:00`, `10:00-12:00`, `12:00-14:00`, `14:00-16:00`, `16:00-18:00` |
| Bandes de la vue impression | 5 (déjà) | **5** — inchangé, mêmes libellés |
| Case libre → nouvelle réservation | départ à l’heure de la ligne | départ en **début de bande** (`08:00`, `10:00`, …) ; vue « Par salle » : `start=08:00&room=id` |
| Séance qui occupe toute sa bande | — | `S01 08:00–10:00` remplit le 1er tiers ; rowSpan conservé pour les séances traversant une frontière |
| `node --check public/js/views/planning.js` | — | **SYNTAX_OK** |
| `tests/run-tests.js` (après édition) | 152/152 | **152/152, EXIT=0** |
| Console navigateur | — | **aucun message** |
| Fichiers modifiés | — | `public/js/views/planning.js` (grille : `hourMatrix`/`hourLabel` remplacés par `timeBands(..., true)` ; `newSessionUrl` reçoit désormais des **minutes**) |

La longueur de bande reste pilotée par le paramètre `session_hours` (2 h par défaut) :
si l’administrateur change la durée d’une bande, grille écran **et** impression suivent
tous les deux.

---

## 9. Suite — page d’impression officielle ISPITS : 4 signatures sous le tableau et tenue de la page A4 (9 octobre 2026)

Demande : *supprimer le logo Smart Salle, infos Filière/Option/Année sans cadre,
déplacer coordinateur d’option + coordinateur de filière sous le tableau avec DAC
et Directeur sur une seule ligne, préserver le tableau, tout tenir sur A4 paysage
à l’impression comme dans le PDF*.

### Modifications appliquées (composant réel d’impression, aucune 2e page créée)

- `public/js/views/planning.js` : les deux notes N.B (« programme peut subir des
  changements » + « N.B des études / Semaine du … ») sont **fusionnées en une seule
  ligne** sous les signatures ; variable `adminNote` supprimée (aucune référence résiduelle).
- `public/styles.css` : compacité de la feuille (marges des blocs resserrées,
  `.pg-sig-space` à 40 px, note de bas de page sur une seule ligne, titre/en-tête
  resserrés), cellules du tableau **compactées en impression uniquement**
  (police 10 px, interligne 1,22, marges internes réduites — contenu identique),
  et `@media print { .print-sheet { zoom: 0.92 } }` : la pagination voit la hauteur
  réduite, donc **une seule page A4 paysage** même semaine chargée.
- Inchangé : `@page { size: A4 landscape; margin: 10mm }`, en-tête/pied officiels,
  filtres, tableau (contenu, couleurs, bandes), permissions, écran (`zoom` = 1 hors
  impression).

### Vérifications

| Contrôle | Résultat |
|---|---|
| Logo Smart Salle sur la feuille | **absent** — seules images : `entete-officielle.png`, `pied-officielle.png` (officielles conservées) |
| Infos admin | `Filière : … · Option : … · Année universitaire 2026/2027` — bordure `0px none`, fond transparent, **valeurs dynamiques** (testé « Toutes les filières » et « Soins Infirmiers / IBO — … ») |
| 4 blocs de signature | alignés (même `top`), largeurs égales (170 px print / 158 px écran), gouttières régulières, **aucun chevauchement**, tous **sous le tableau**, intitulés + espace blanc 40 px conservés même sans nom |
| Nom dynamique | `Coordinateur d’Option : IDOUAZIZ Youssef` affiché ; blocs sans nom : intitulé + espace conservés |
| Tableau | inchangé : Lundi→Samedi + dates (12/10→17/10 sur la semaine test), 5 bandes `08:00-10:00` → `16:00-18:00`, modules/enseignants/salles présents |
| Tenue de page (émulation print, largeur A4 utile 1047 px) | 690 px (semaine courante), **702 px (semaine chargée, 10 séances)**, 678 px (IBO + S3) — toutes ≤ 718 px ; aucun débordement horizontal |
| **PDF réels** (Edge headless, `preferCSSPageSize`, login admin) | **3/3 : 1 page unique, 841,9 × 595 pt = A4 paysage** : `#/print`, `#/print?week=2026-10-12` (10 séances), `#/print?week=2026-10-12&option_id=2&semester=S3` |
| `node --check public/js/views/planning.js` | **SYNTAX_OK** (après toutes les éditions du fichier) |
| `tests/run-tests.js` | **152/152, EXIT=0** (après toutes les éditions) |
| Console navigateur | **aucun message** |
| Fichiers temporaires de vérification | purgés de `public/` (le dossier redevient `assets/ index.html/ js/ styles.css`) |

### Limites

- Le panneau d’aperçu de l’application a arrêté de produire des images en cours de
  session (défaut côté client, sans rapport avec le code) : la vérification visuelle
  s’appuie sur l’audit DOM en émulation `@media print` + les **PDF réels** produits
  par Edge headless, qui font foi.
- Une semaine où **plusieurs cellules empileraient 2 séances à la fois** (grille non
  filtrée multi-options très dense) peut encore dépasser 718 px — cas non couvert
  par la demande ni par la capture de référence ; ajouter un filtre (option/semestre)
  ou un sélecteur d’impression par option reste la parade (pages « Toutes les pages »).
