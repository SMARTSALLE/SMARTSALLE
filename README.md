# SmartSalle ISPITS

**Gestion intelligente des salles, des emplois du temps et des réservations — ISPITS Laâyoune**

Application web full-stack complète : base de données SQLite persistante, authentification réelle par sessions,
permissions contrôlées côté serveur, protection anti-conflit garantie **par la base de données**, synchronisation
temps réel (SSE), interface responsive (ordinateur, tablette, mobile), impression A4 paysage, exports Excel/CSV
et QR codes par salle.

📄 **Rapport détaillé : [RAPPORT-CONTROLE.md](RAPPORT-CONTROLE.md)** — 152 / 152 tests réussis.

---

## Démarrage

```bash
npm start          # = infisical run --env=dev -- node server/index.js  →  http://localhost:3000
```

Sous Windows : double-cliquer sur `start.bat` (un runtime Node portable est fourni dans `.tools/`).

**Compte initial :** `admin@ispits.ma` / `Smartsalle@2026`
(également écrit dans `data/initial-admin.txt` — à changer dès la première connexion)

## Secrets (Infisical)

Les secrets ne sont **plus** stockés dans un `.env` local : ils sont centralisés dans
[Infisical](https://infisical.com), projet `smartsalle-ispits`, environnements
**Development / Staging / Production**. L'application lit toujours `process.env` exactement comme
avant — aucun code applicatif n'a changé.

Mise en route (local / Development) :

1. Créer un compte puis un projet `smartsalle-ispits` sur <https://app.infisical.com>.
2. Importer les clés : glisser-déposer [`.env.example`](.env.example) sur la page *Secrets Overview*,
   puis saisir les vraies valeurs **dans Infisical** (jamais sur le disque).
3. Installer le CLI : `winget install infisical`
   (macOS : `brew install infisical/get-cli/infisical`).
4. Se connecter : `infisical login` — ou `infisical login -i` sans navigateur (WSL 2, SSH distant).
5. Lier le dépôt : `infisical init` → écrit `.infisical.json` (paramètres locaux sans secret, à committer).
6. Lancer : `npm start` (ou `start.bat` sous Windows).

Pour lancer **sans** Infisical (mise au point, valeurs par défaut du code) : `npm run start:local`.

Variables lues par l'application :

| Variable | Rôle |
|---|---|
| `PORT` | port HTTP (défaut 3000) |
| `HOST` | interface d'écoute (défaut 0.0.0.0) |
| `LOG_REQUESTS` | `1` pour tracer les requêtes |
| `NODE_ENV` | `production` désactive l'affichage local des codes email |
| `SMARTSALLE_DB` | chemin de la base SQLite |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | compte administration créé au premier démarrage |

Les paramètres SMTP se configurent dans la page **Paramètres** de l'application (table `settings`),
pas via des variables d'environnement.

### CI/CD, Kubernetes, production

Pas de `infisical login` interactif dans ces contextes : créer une *machine identity* avec
**Universal Auth** et stocker son Client ID / Client Secret dans le magasin de secrets de la
plateforme, en limitant l'identité au strict nécessaire (projet + environnement).
Voir <https://infisical.com/docs/documentation/platform/identities/machine-identities>

## Tests

```bash
npm test           # 152 tests API/base + les 25 tests obligatoires du cahier des charges
```

Le rapport est écrit dans `data/test-report.json`.

## Architecture

| Dossier | Contenu |
|---|---|
| `server/` | Backend Node.js pur (aucune dépendance native) : `db.js` (schéma + déclencheurs + seed), `auth.js`, `mail.js`, `realtime.js`, `services.js`, `routes/*` |
| `public/` | Frontend SPA sans build : `styles.css` (design system + impression), `js/app.js` (routeur/coque), `js/views/*` |
| `tests/` | Suite automatisée |
| `data/` | Base persistante `smartsalle.db`, logo, outbox email, rapport de tests |

**81 routes API · 17 tables · 5 déclencheurs SQL · 20 écrans.**

### Garanties clés

- **Anti-chevauchement** : table `reservation_locks` + déclencheurs → toute réservation qui chevauche une autre échoue
  au niveau SQLite (`409` renvoyé à l'utilisateur). Aucune double réservation possible, même en simultané.
- **S12-1ER = MASTER MANAGEMENT** : `is_available_for_normal_booking = 0` + déclencheur `RAISE(ABORT)` → jamais
  proposée ni réservable normalement ; visible par l'administration, statut visible par les coordinateurs.
- **Aucune capacité de salle** : le nombre d'étudiants est purement informatif, jamais un filtre.
- **Permissions serveur** : rôles `admin` / `coordinateur` / `enseignant` vérifiés sur chaque endpoint.
- **Catalogue des filières** : les 18 options officielles de l'ISPITS (IP, ISM, IPAR/IDAR, ISUSI, ISF, RAD, LAB,
  PREP, DN, SE, SS, KINE, ORTHO, ERGO, PSYCHOM, SF, AS + IBO) sont seedées avec leur filière (`category`) et
  affichées groupées sur les pages **Connexion** et **Créer un compte** (source : `GET /api/options`, public).
- **Mot de passe oublié** : `#/forgot` → code par email (scrypt, 15 min, cooldown 60 s, 6 tentatives) → nouveau
  mot de passe ; réponses génériques (pas d'énumération de comptes) et révocation de toutes les sessions.

## Rôles

| Rôle | Accès |
|---|---|
| Administration | comptes, demandes, options, groupes, modules, enseignants, salles, équipements, réservations, planning global, audit, paramètres, exports |
| Coordinateur | consultation de toutes les disponibilités, réservations/modifications **uniquement pour ses options approuvées**, notes et tâches |
| Enseignant | consultation seule : planning, modules, réservations, salles, horaires |

## Email (vérification)

Sans serveur SMTP configuré, les codes sont écrits dans `data/outbox/*.eml` et affichés en mode local
(`expose_dev_codes`). Renseignez SMTP dans **Paramètres** pour l'envoi réel, puis désactivez cette option.

## Déploiement public

Voir la section 8 de [RAPPORT-CONTROLE.md](RAPPORT-CONTROLE.md) : HTTPS/domaine via Caddy ou Nginx
(ex. `smartsalle-ispits.ma`), sauvegarde de `data/`, exécution continue (systemd / pm2 / service Windows).
