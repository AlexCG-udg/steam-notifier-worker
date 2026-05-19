# Steam Notifier – Cloudflare Worker

Migració de la Pràctica 1 (PHP/Python + SQLite + Apache) a **Cloudflare Workers + KV**.

Els usuaris poden gestionar una llista de videojocs de Steam i rebre notificacions diàries per correu electrònic amb el nombre de jugadors actius en temps real.

---

## Tecnologies

| Capa | Pràctica 1 | Pràctica 3 |
|---|---|---|
| Execució | Apache + PHP/Python | Cloudflare Workers (edge) |
| Base de dades | SQLite | Cloudflare KV |
| Autenticació | bcrypt + token 24 h | PBKDF2 (Web Crypto) + token 24 h |
| Email | Resend API | Resend API |
| Cron | crontab del servidor | Workers Cron Trigger |

---

## Prerequisits

- [Node.js](https://nodejs.org/) ≥ 18
- Compte a [Cloudflare](https://dash.cloudflare.com/)
- Compte a [Resend](https://resend.com/) (pla gratuït: 3 000 correus/mes)

---

## Configuració inicial

### 1. Clonar el repositori i instal·lar dependències

```bash
git clone https://github.com/el-teu-usuari/steam-notifier-worker.git
cd steam-notifier-worker
npm install
```

### 2. Autenticar Wrangler

```bash
npx wrangler login
```

### 3. Crear el namespace de KV

```bash
# Namespace de producció
npx wrangler kv namespace create STEAM_KV

# Namespace de preview (per a `wrangler dev`)
npx wrangler kv namespace create STEAM_KV --preview
```

Wrangler mostrarà els IDs. Copia'ls al `wrangler.toml`:

```toml
[[kv_namespaces]]
binding    = "STEAM_KV"
id         = "abc123..."          # ← ID de producció
preview_id = "def456..."          # ← ID de preview
```

### 4. Configurar el secret de Resend

**Per a producció:**
```bash
npx wrangler secret put RESEND_API_KEY
# Enganxa la teva clau quan et la demani
```

**Per a desenvolupament local** – crea `.dev.vars` (mai commitegis aquest fitxer):
```
RESEND_API_KEY=re_xxxxxxxxxxxx
```

---

## Execució local

```bash
npm run dev
# → Servidor disponible a http://localhost:8787
```

---

## Desplegament

```bash
npm run deploy
# → https://steam-notifier.<el-teu-subdomini>.workers.dev
```

---

## Endpoints de l'API

Tots els endpoints retornen JSON.

> **Nota sobre els tokens:** el login retorna `token:XXXXXXXX...`. A les crides
> següents, passa el valor sencer com a query param `?token=XXXXXXXX...`
> (sense el prefix `token:`) o inclou-hi el prefix – els dos formats funcionen.

### Registre

```bash
curl -X POST http://localhost:8787/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alex","password":"1234"}'
```

### Login

```bash
curl -X POST http://localhost:8787/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alex","password":"1234"}'
# Resposta: { "token": "token:5361198920f5cc6f3d6f510e431362a8" }
```

### Associar correu

```bash
curl -X PUT "http://localhost:8787/email?token=TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"el_teu_correu@gmail.com"}'
```

### Afegir joc

| Videojoc | AppID |
|---|---|
| Counter-Strike 2 | 730 |
| Rust | 252490 |
| Dota 2 | 570 |
| Elden Ring | 1245620 |

```bash
curl -X POST "http://localhost:8787/games?token=TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"appid":730}'
```

### Veure llista de jocs

```bash
curl "http://localhost:8787/games?token=TOKEN"
```

### Eliminar joc

```bash
curl -X DELETE "http://localhost:8787/games/730?token=TOKEN"
```

### Notificar manualment (sense esperar el cron)

```bash
curl -X POST "http://localhost:8787/notify?token=TOKEN"
```

### Logout

```bash
curl -X POST "http://localhost:8787/logout?token=TOKEN"
```

---

## Cron automàtic

El Worker s'executa automàticament cada dia a les **20:00 UTC** gràcies al trigger definit a `wrangler.toml`:

```toml
[triggers]
crons = ["0 20 * * *"]
```

Pots provar el cron manualment des del Dashboard de Cloudflare → Workers → el teu worker → **Triggers** → **Test**.

---

## Estructura del projecte

```
steam-notifier-worker/
├── src/
│   └── index.js        ← Tot el codi del Worker
├── wrangler.toml        ← Configuració de Cloudflare
├── package.json
├── .gitignore
├── .dev.vars.example    ← Exemple de secrets locals (no commitegis .dev.vars!)
└── README.md
```

---

## Notes de seguretat

- Les contrasenyes es desen hashejades amb **PBKDF2-SHA256** (100 000 iteracions) – equivalent a bcrypt.
- Els tokens expiren automàticament a les **24 hores**; KV els elimina via TTL.
- La clau de Resend es gestiona com a **secret** de Wrangler, mai en el codi.

---

## LLM utilitzat i procés

Veure el document de la pràctica per als prompts utilitzats, errors trobats i iteracions fetes amb l'LLM.
