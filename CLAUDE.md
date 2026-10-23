# Addon Stremio de Doramas

Cloudflare Worker que sirve el protocolo de addon de Stremio (`com.doramas.stremio`,
v1.0.0) para **fuentes de doramas**: doramaslat.com, doramedplay.net,
kdramasplay.com (WordPress + tema DooPlay), doramasflix.in (GraphQL), tudorama.com, pandrama.tv, doramasyt.com y doramasub.com. Archivo
principal: `src/index.ts`, más un servicio auxiliar `deno/fetch.ts` que corre en
**Deno Deploy** (ver notas del proxy abajo; `deno.json` fija su entrypoint). El
Worker se despliega con **Cloudflare Workers Builds** (integración Git del dashboard)
en cada push a `main`; el proxy se despliega con la integración Git de Deno Deploy.
No hay suite de tests: `npx tsc --noEmit` (que solo cubre `src/`) es la única puerta.

## Estructura invariante

Contratos estables. Cambiarlos es trabajo de protocolo y debe cumplir la spec
(https://github.com/Stremio/stremio-addon-sdk/tree/master/docs):

- **Rutas**: `/manifest.json`, `/catalog/...`, `/meta/...`, `/stream/...`, más
  `/proxy/m3u8` + `/proxy/seg` (proxy de reescritura HLS) y los endpoints `/debug*`.
  Toda respuesta JSON pasa por `json()` y lleva cabeceras CORS.
- **Esquema de IDs** (prefijos `idPrefixes: ["dlat:", "dsub:", "kplay:", "dflix:", "tudorama:", "pandrama:", "dyt:", "doramasub:"]`):
  - `dlat:{slug}` / `dsub:{slug}` — meta de serie.
  - `dlat:{slug}-1x{N}` / `dsub:{slug}-1x{N}` — streams de episodio
    (validado con `/-\d+x\d+$/`, página fuente `/episodes/{slug}-1xN/`).
  - `kplay:series:{slug}` / `kplay:movie:{slug}` — meta (páginas `/series/` y `/peliculas/`).
  - `kplay:ep:{epSlug}` / `kplay:movie:{slug}` — streams de episodio/película
    (páginas `/episodios/{epSlug}/` y `/peliculas/{slug}/`).
  - `dflix:{slug}` — meta; `dflix:{slug}-1x{N}` — streams/episodios.
  - `tudorama:{slug}` — meta; `tudorama:{slug}-s{S}x{E}` — streams de episodio.
  - `pandrama:{id}:{slug}` — meta; `pandrama:{titleId}:ep:{videoId}` — streams de episodio.
  - `dyt:{slug}` — meta/streams.
  - `doramasub:{slug}` — meta/streams.
- **Los objetos stream llevan `title` O `description`, nunca ambos**: stremio-core
  (el núcleo Rust detrás de Android + Web) deserializa `title` como alias serde de
  `description`, así que un objeto con ambos falla como campo duplicado y el cliente
  descarta en silencio todos esos streams ("No streams were found" mientras curl
  muestra la respuesta completa). Verificado en vivo contra web.stremio.com.
- **Cache**: solo KV (`STREAM_CACHE`), nunca estado en memoria — un `Map` a nivel
  de módulo creció sin límite y causó crashes 1101. Los TTLs viven en `TTL`.
- **Presupuesto de tiempo**: el Worker tiene 30s de muro; `fetchHtml` impone 25s.
  Toda llamada de red nueva necesita un `AbortSignal.timeout` explícito.
- **Ruta de fetch de HTML**: los sitios de doramas bloquean el egress del Worker
  a level de red, así que el `fetch` directo desde el Worker no es fiable.
  `fetchHtml` **racea** el directo contra `FETCH_PROXY_URL` (el proxy de Deno
  Deploy `deno/fetch.ts`, la ruta fiable) y toma el primer HTML válido; después
  cae a Browser Rendering (si está configurado) → proxies CORS gratuitos (casi
  todos muertos). Si direct o el relay obtienen **404/410** del upstream
  (`SiteNotFoundError`), `fetchHtml` no prueba ni render ni proxies: la página no
  existe y reintentarla solo quemaría ~16s (esto es el común en streams con slug
  de episodio inexistente en un sitio). Los 403/5xx sí reintentan (bloqueo de CF
  que un proxy puede salvar). El proxy permite solo los dominios de dorama
  integrados (allowlist en `deno/fetch.ts`).
- **Slug mapping entre sitios** (`src/sources/slugmap.ts`): el fan-out de
  `getStreams` reutiliza el epSlug del sitio origen en los otros, pero cada
  sitio nombra sus episodios con su propio slug. Si a doramaslat.com,
  kdramasplay.com o doramedplay.net les da 404, se resuelve el slug correcto:
  buscar la serie por título (`?s=`, scoring de tokens ≥ 0.5 con exigencia de
  ≥2 hits para títulos multi-palabra, stopwords en limpio) → raspar la lista
  de episodios de la página de serie → tomar el slug del SxE pedido; los DOS
  prefijos DooPlay resuelven (`dlat`/`dsub` en `doramas.ts`) — p.ej. un id
  de kplay también puede encontrar su episodio en doramaslat. Se reusa
  con `getKplayStreams`/`getDoramaStreams`. Cache: `epmap:v1:{site}:{titleKey}`
  (mapa `{SxE: epSlug}` de toda la serie, TTL 24h — episodios siguientes salen
  de una lectura de KV) y cache negativa `epmap:v1nx:{site}:{titleKey}` (1h;
  el timeout de resolución NO la escribe). Presupuesto: el resolve entero va
  en carrera contra 12s y solo corre en el camino de fallo (404), así que el
  camino feliz no paga nada. doramasflix (`dflix`) SÍ participa, con un adapter
  propio NO-DooPlay: la búsqueda es su GraphQL `searchFullDoramas` (por nombre,
  variable `String!`) en vez de HTML, y su `fetchEpisodes` reusa
  `getDoramasflixMeta` (sin TMDB) porque sus slugs de episodio se recomponen
  aritméticamente como `{serieSlug}-{s}x{e}` (detalle: `detailEpisode` valida
  la existencia real después del resolve). Espejo de cabeceras: `fetchGql`
  prueba `Origin/Referer` de doramasflix.in y, ante fallo (red/timeout/HTTP),
  reintenta secuencialmente con doramasia.com, doramasflix.io y
  doramasmp4.io — los 4 son la misma plataforma con el mismo backend
  (`user-api.seriesapi.co`, verificado in-vivo: misma BD, mismos `_id`),
  así que el fallback es de cabeceras, no de URL.
- **Extracción manual-first**: fetch HTTP directo más parse/unpack dentro del
  Worker — sin puente de navegador headless (el puente Render y el import de
  `@cloudflare/puppeteer` causaron caídas/crashes 1101 y ya no existen). La única
  escalada opcional es **Cloudflare Browser Rendering** vía la API REST `/content`
  (`renderPage`), activada por `CF_ACCOUNT_ID` + `CF_API_TOKEN`; renderiza la
  página en el edge de Cloudflare (sin import de puppeteer) como fallback de
  `fetchHtml` cuando el challenge de Cloudflare bloquea el egress directo, y para
  hosts que necesitan JS. Sin variables ⇒ extracción 100% manual; un host sin
  resolver se expone como `externalUrl` (lo abre el cliente del usuario).

## Capa volátil (cambio esperado)

Todo lo que toca el markup de los sitios o un host de video es código de scrape
y se rompe cuando el upstream cambia. Cuando se rompa, arréglalo in situ — no
dejes la variante vieja detrás:

- `parseDoramaCards` / `parseKplayCards` — scrape HTML por regex (catálogo DooPlay).
  El patrón de episodios es idéntico en los 3 sitios WordPress:
  `<li class="dooplay_player_option" data-post data-nume data-type>` → POST a
  `admin-ajax.php` con `action=doo_player_ajax` → `{"embed_url": "…"}` → resolver
  el host del embed (`resolveDoramaEmbed` / `resolveKplayEmbed`).
- Extractores por host en `src/extractors.ts` (`extractMp4upload`, `extractHexload`,
  `extractSavefiles`, `extractMixdrop`, `extractStreamwish`).
  Añade un host nuevo escribiendo otro extractor manual, no buscando un navegador.
  **Ojo**: los extractores Worker-side de hosts IP-bound (`extractSavefiles`,
  `extractStreamwish`, `extractMixdrop`) existen SOLO para los endpoints
  `/debug-savefiles`, `/debug-streamwish` y `/debug-mixdrop`. Nunca los uses como
  camino primario de streams — producen streams muertos (las URLs firmadas que
  acuñan quedan atadas a la IP del Worker y Stremio, con otra IP, recibe 403).
- **Hosts IP-bound**: savefiles/streamhls y StreamWish se resuelven y se sirven
  íntegramente desde el Deno service (`/savefiles`, `/streamwish`, `/hls` en
  `deno/fetch.ts`), así la extracción y cada segmento comparten la única IP estable
  de Deno; el Worker solo apunta a Stremio hacia `${denoBase}/savefiles?code=…` o
  `${denoBase}/streamwish?url=…` (`denoBase` se deriva recortando `/fetch` del
  final de `FETCH_PROXY_URL`). mixdrop queda como `externalUrl` (la IP del usuario
  lo resuelve). El CDN HLS de StreamWish (`premilkyway.com`) ya está en la
  allowlist de `/hls`.
- `unpackPacker` revierte el packing `eval(function(p,a,c,k,e,d){…})` de Dean
  Edwards — reúsalo para cualquier host que mande su config así. Existe una copia
  en `deno/fetch.ts` para StreamWish; las dos copias hoy no resuelven el diccionario
  igual (uno usa `words[i] || k`, el otro encadena fallbacks) — unificarlas antes
  de fiarse del caso límite.
- `findMediaUrl` + `decodeVoe` + `isDecoyUrl` — detección de MP4/HLS directo y de
  enlaces señuelo dentro del HTML de un embed; los usan `/debug-host` y el filtro
  de streams de `src/index.ts`.
- `/debug-extract?id=…` corre los extractores con medidas de tiempo, y
  `/debug-host?url=` / `/debug-mixdrop?url=` / `/debug-streamwish?url=` /
  `/debug-savefiles?code=` sondean un embed concreto — úsalos para diagnosticar
  fallos de extracción en el Worker desplegado.
- `/debug-all` (src/index.ts, `DEBUG_SOURCES`) es el chequeo dinámico de las 7
  fuentes: por fuente toma las series recientes de su propio catálogo
  (`getCatalog`), las expande a episodios vía `getMeta` (los catálogos traen
  ids de serie; `debugIsEpisodeId` valida el formato por fuente) y llama al
  getter de esa fuente con esos IDs reales — a diferencia de
  `/debug-extract`, que mezcla el fan-out de todas. Default `n=10`
  episodios/fuente (≈5 series × 2 eps), expansión y checks con tope de
  concurrencia (`DEBUG_CONCURRENCY=3`) y techo de 45 s por chequeo. Salida
  plana: una fila por episodio con `sample` (`debugServerOf`: `title` →
  `externalUrl` → hostname de `url`; `debugTipoOf`) siempre; `?ids=` hace
  override manual. Cuidado en CF Workers free: ~100 subrequests/invocación de
  este chequeo. Los hosts de la familia Cloudflare-challenge
  (`CHALLENGE_HOSTS_RE` en utils.ts: dsvplay/do7go/playmogo) van por fast
  path directo sin cascada de proxies; `extractMp4upload` descarta sin fetch
  los `embed-undef.html` (archivo borrado upstream).
  `/debug-dood?url=` sondea la rama Dood de `extractDood`.

## Familia Dood (do7go/playmogo/dood.*) — NO es StreamWish

Son MP4 progresivos, no HLS. Verificado con el embed `/e/iw92kudnsi8r`:
el HTML server-side del embed trae en claro la llamada
`$.get('/pass_md5/<hash>/<code>')` (con expiry horneado); ese GET devuelve
texto plano con la base del CDN (ej. `https://xx.cloudatacdn.com/path/foo~`) y
el player le concatena 10 chars random + `?token=<code>&expiry=<ms>` (función
`makePlay()`). El MP4 final **exige `Referer` del propio host del embed y NO
es IP-bound** (con Referer responde 206 sin token query). Flujo:
`extractDood` (src/extractors.ts, usa `fetchHtml` que cae a Browser Rendering
si hay challenge) → rama `DOOD_HOSTS_RE` en `addEmbedStreams` y en el loop de
pandrama → stream `url = ${denoBase}/mp4?url=…&r=<origin>` → relay `/mp4` en
deno/fetch.ts (pasa el `Range` del cliente, sin timeout para no cortar el
body; allowlist `doodMp4HostAllowed`). Sin denoBase queda como externalUrl.
Sincronizado con la allowlist de /mp4 en deno/fetch.ts.

## Allowlist de StreamWish (un contrato, 2 copias)

La regex canónica vive en `STREAMWISH_HOSTS_RE` (`src/utils.ts`) y las fuentes
la comparten (directamente `pandrama.ts` o vía `addEmbedStreams`). Debe
quedarse idéntica a la allowlist de `/streamwish` en `deno/fetch.ts`:

```
streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|lulustream|luluvdo|lulu\.st
```

(`do7go|playmogo` salieron — son familia Dood, van por `/mp4` con
`DOOD_HOSTS_RE`; `dsvplay` también es Dood.)

Un host que el Worker enruta al proxy pero que Deno rechace muere con un 403
silencioso (stream muerto sin log en el Worker) — históricamente pasó con
`streamaly|streamis|flaswish` y fue la causa del bug de `kplay`. Si añades un
host, complétalo en las 2 copias en el mismo commit (el Worker y el Proxy se
despliegan por separado).

**Gates de la familia filelions (lulu)**, verificados con sondas reales:
el master m3u8 vive en `cdn-tnmr.*` (también permitido en `hlsHostAllowed`
del `/hls` de Deno), y variantes/segmentos exigen **Referer = la URL del
embed exacta** (`https://luluvdo.com/e/<code>`) con **UA Chrome desktop** —
por eso `handleStreamwish` pasa `r=<embed>` en el rewrite y `handleHls`
reintenta con UA Chrome si el móvil recibe 403. Los espejos "clásicos" de
StreamWish siguen con `Referer: streamwish.top` y UA móvil.

## Problema conocido (no "arreglar" a ciegas)

**[Resuelto el Código oct. 2026]**: el antiguo bug de `kplay` sin streams
(`do7go.com` → `playmogo.com`, espejo de StreamWish con challenge de Cloudflare,
ausente en ambas allowlists) se cerró unificando las 4 copias de la allowlist
(los 3 sites + Deno Proxy ya aceptan `do7go|playmogo` junto a
`streamaly|streamis|flaswish`). **Aún falta validar en producción** tras ambas
redespecies (Worker + Deno Deploy): si el edge de Deno recibe el challenge
Cloudflare de do7go/playmogo, la playlist no se resolverá y hará falta
Browser Rendering como último recurso. Y limpiar la caché afectada con
`/cache-clear?key=stream:v3:kplay:ep:{slug}` (las entradas viejas guardan el
fallback `externalUrl`).

## Reglas

- Un solo deployer: Cloudflare Workers Builds (integración Git del dashboard).
  No añadir un workflow de GitHub Actions con `wrangler deploy` — haría
  doble-deploy en cada push a `main`.
- Sin archivos de backup commiteados (`*.bak`); el historial de git es el backup.
- Eliminar el código reemplazado — extractores muertos y variables de entorno sin
  uso son ruido, no redes de seguridad.
- Bump de `MANIFEST.version` en cambios visibles para el usuario.
