# Configuración y despliegue

Este proyecto **no incluye ningún secreto ni dato de infraestructura personal**.
Toda la configuración privada vive en ficheros locales que `.gitignore`
excluye del repositorio.

## 1. Variables locales de desarrollo

```sh
cp .dev.vars.example .dev.vars   # Windows: copy .dev.vars.example .dev.vars
```

Edita `.dev.vars` y rellena los valores que necesites: `TMDB_KEY`,
`CF_ACCOUNT_ID`, `CF_API_TOKEN`. Ninguno es obligatorio salvo que quieras
esas integraciones (TMDB, Browser Rendering).

Arranque local:

```sh
npm install
wrangler dev      # http://localhost:8787
```

## 2. wrangler.toml

El `wrangler.toml` versionado es una plantilla. Antes de desplegar,
ajusta en **tu copia local**:

| Campo | Qué poner |
|---|---|
| `kv_namespaces.id` | Tu propio namespace KV (binding: `STREAM_CACHE`) |
| `FETCH_PROXY_URL` | URL de tu proxy de fetch (ver sección 3) |
| `CF_ACCOUNT_ID` | Déjalo vacío o pon tu account id |

> Consejo: no hagas commit de esos valores. Puedes sobreescribir el
> account id por entorno con `CLOUDFLARE_ACCOUNT_ID` al usar `wrangler`.

## 3. Proxy de fetch (Deno Deploy)

Opcional: solo es necesario si la fuente `latanime.org` bloquea el egreso
de Cloudflare Workers. Despliega tu propio proxy con el contenido de
[`deno/`](../deno/README.md) en Deno Deploy y apunta `FETCH_PROXY_URL`
a `https://<tu-app>.deno.dev/fetch`.

## 4. Despliegue en Cloudflare Workers

```sh
wrangler login
wrangler deploy
```

Secretos de producción (nunca en el fichero de configuración):

```sh
wrangler secret put CF_API_TOKEN   # y/o
wrangler secret put TMDB_KEY
```

## 5. Despliegue del proxy (opcional)

Ver [`deno/README.md`](../deno/README.md) para publicar el relay de fetch
en Deno Deploy.

## Checklist antes de publicar forks o cambios

- [ ] `.dev.vars` no está trackeado (`git status` no debe mostrarlo)
- [ ] No hay URLs de tus despliegues reales (workers.dev / deno.net) en el código
- [ ] No hay account ids ni ids de namespace reales en el repo
