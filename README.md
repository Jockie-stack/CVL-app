# CVL Secure (PWA + API)

Application PWA (mobile-first) pour :
- centraliser les idées / retours envoyés par les élèves,
- publier des actualités,
- proposer un sondage,
- exposer un bloc **Infos lycée** (JPO, mini-stages, info scientifique, cycle, aides région),
- permettre à l'admin de consulter / gérer le tout via une connexion sécurisée.

> Le projet sert la partie *centralisation + renvoi à l’admin* via un backend (API) :
> toutes les idées / votes / actus sont stockés côté serveur (SQLite), pas dans `localStorage`.

## Démarrage (local)

### 1) Installer les dépendances
```bash
cd server
npm install
```

### 2) Configurer l’admin
Générer un hash bcrypt (à partir d’un mot de passe) :
```bash
cd server
node tools/make-admin-hash.js "TonMotDePasseFort"
```

Copier `.env.example` en `.env` puis coller le hash dans `ADMIN_PASSWORD_HASH`.

### 3) Lancer
```bash
cd server
npm start
# puis ouvrir http://localhost:3000
```

## Sécurité (résumé)
- **Pas de mot de passe en dur** dans le front (auth via cookie httpOnly + JWT).
- **Rate limiting** sur les routes publiques + login.
- **Cooldown par appareil** sur l’envoi d’idées.
- **Validation stricte** (express-validator) + **sanitization** (suppression des balises HTML).
- Cookies `httpOnly` (et `secure` en production HTTPS).
- `helmet` (headers de sécurité) + `nosniff`.
- Prévention du multi-vote : contrainte unique `(poll_id, voter_hash)`.

## Production
- Mettre `NODE_ENV=production`.
- Servir en **HTTPS** (sinon cookies `secure` impossibles).
- Mettre un `JWT_SECRET` fort.
- Si derrière un reverse proxy (Nginx), mettre `TRUST_PROXY=1`.

## Structure
- `public/` : PWA (HTML/CSS/JS, service worker, manifest)
- `server/` : API + serveur statique + base SQLite



## Push notifications (Web Push)

### Générer des clés VAPID
Le serveur attend `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` dans `server/.env`.

Pour générer des clés via la lib `web-push` :
```bash
cd server
npm install
node -e "import webpush from 'web-push'; console.log(webpush.generateVAPIDKeys())"
```

> Le serveur charge `web-push` en *lazy import*. Si la dépendance n'est pas installée, l'API push renverra `501`.

### Activer côté client
Dans la PWA : écran **Contact** → section **Préférences** → bouton **Activer**.

## Dashboard admin

- URL : `/admin/dashboard`
- Nécessite d’être connecté en admin (cookie httpOnly).
