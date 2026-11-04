# ERRORES.md

Registro de errores conocidos del addon **Stremio Doramas**.

- **Fecha:** 2026-11-04
- **Rama:** `feat/add-kisskhorg-source-15045266342975164957`
- **Últimos commits relevantes:** `44f4809` (fix catalogId), `118cfbb` (fix MP4 relay zudrama)
- **Contexto:** revisión de la fuente nueva `korg:` (kisskh.org) y del proxy Deno.
- **Segunda pasada (2026-11-04):** análisis a fondo de la fuente, helpers compartidos y proxy → errores **E-15 … E-24**.

Escala de severidad:

| Nivel | Significado |
|---|---|
| **Crítico** | Rompe la reproducción o contamina a todas las fuentes. |
| **Alto** | Una función entera no funciona (p. ej. todas las películas de una fuente). |
| **Medio** | Funciona a medias, se pierden resultados o hay riesgo de fallo intermitente. |
| **Bajo** | Calidad, documentación, mantenimiento. |

---

## Resumen

| ID | Severidad | Estado | Título |
|---|---|---|---|
| [E-01](#e-01) | Crítico | ✅ Arreglado | `catalogId` colisionaba por prefijo (`kisskhorg-directory` → fuente `kisskh`) |
| [E-02](#e-02) | Crítico | ✅ Arreglado | `/mp4` rechazaba `zudrama.top` (403) |
| [E-03](#e-03) | Alto | ⚠️ Pendiente | `FETCH_PROXY_URL` apunta a `localhost` en `wrangler.toml` |
| [E-04](#e-04) | Alto | ⚠️ Pendiente | Películas de korg: 0 streams (la rama `isMovie` no parsea Blogger) |
| [E-05](#e-05) | Crítico | ⚠️ Pendiente | Ids de 3 segmentos (`korg:series:{slug}`) rompen la ruta IMDb y el fan-out |
| [E-06](#e-06) | Medio | ⚠️ Pendiente | Paginación con huecos: `pageSize = 24` vs 35 reales |
| [E-07](#e-07) | Medio | ⚠️ Pendiente | Películas publicadas como `type: "series"` |
| [E-08](#e-08) | Crítico | ⚠️ Pendiente | Deno Deploy desactualizado (403 en `/fetch` de kisskh.org y en `/mp4`) |
| [E-09](#e-09) | Medio | ⚠️ Pendiente | `www.blogger.com` fuera de la allowlist de `/fetch` (sin plan B) |
| [E-10](#e-10) | Alto (latente) | ⚠️ Pendiente | `kplay`/`yandi` tienen el mismo bug de ids de 3 segmentos |
| [E-11](#e-11) | Medio | ⚠️ Pendiente | `epIdPattern` permisivo: `.` casa con `:` y valida ids malformados |
| [E-12](#e-12) | Bajo | ⚠️ Pendiente | `buildPageUrl` y `getStreams` duplican la resolución de URL |
| [E-13](#e-13) | Bajo | ⚠️ Pendiente | Selector de búsqueda frágil, caché por episodio, nombre duplicado |
| [E-14](#e-14) | Bajo | ⚠️ Pendiente | Documentación y versiones desactualizadas |
| [E-15](#e-15) | **Alto** | ⚠️ Pendiente | La temporada se ignora: `S2E1`/`S3E1` devuelven el vídeo de `S1E1` |
| [E-16](#e-16) | **Alto** | ⚠️ Pendiente | `/hls` bloquea `media.dramasub.top` (403): hay episodios reales en `.m3u8` |
| [E-17](#e-17) | Medio | ⚠️ Pendiente | Fichas sin `data-post-id` → 1 episodio fantasma y 0 streams |
| [E-18](#e-18) | Medio (seguridad) | ⚠️ Pendiente | Allowlist de `/mp4` y `/hls` por subcadena + redirecciones seguidas |
| [E-19](#e-19) | Bajo | ⚠️ Pendiente | `isZudrama` cablea `.top` y es el único CDN con proxy MP4 |
| [E-20](#e-20) | Bajo | ⚠️ Pendiente | Ids sin `ep:`/`movie:` caen a `/tvshows/series:…` |
| [E-21](#e-21) | Bajo | ⚠️ Pendiente | Descripción basura cuando TMDB no matchea |
| [E-22](#e-22) | Bajo | ⚠️ Pendiente | Títulos con año (`TAMED (2026)`): el selector `<h3><a>` no casa |
| [E-23](#e-23) | Bajo | ⚠️ Pendiente | El primer blog ID devuelve 404 en todos los posts probados |
| [E-24](#e-24) | Bajo | ⚠️ Pendiente | La cabecera de idiomas del feed se descarta |

---

## Arreglados

### E-01

**`catalogId` colisionaba por prefijo: `kisskhorg-directory` caía en la fuente `kisskh`**

- **Severidad:** Crítico
- **Estado:** ✅ Arreglado en `src/resolve.ts:27-32` (commit `44f4809`)
- **Ubicación original:** `src/resolve.ts` (`getCatalog`)

**Síntoma.** El catálogo "KissKH.org — Directorio" devolvía resultados de **kisskh.co** (la fuente `kisskh`) en lugar de kisskh.org (`kisskhorg`).

**Causa.** La búsqueda de fuente usaba `startsWith` sin límite:

```ts
SOURCES.find((s) => catalogId.startsWith(s.catalogId))
// "kisskhorg-directory".startsWith("kisskh") → true
```

Como `kisskh` aparece antes que `kisskhorg` en `SOURCES` (`src/registry.ts:52-66`), ganaba la fuente equivocada.

**Arreglo aplicado.** El match exige igualdad o el separador `-`:

```ts
const def = SOURCES.find(
  (s) => catalogId === s.catalogId || catalogId.startsWith(`${s.catalogId}-`)
);
```

Un `catalogId` desconocido responde vacío en vez de recaer en otra fuente (evita además escrituras KV ilimitadas por claves nuevas).

**Verificación.** `kisskhorg-directory` → `korg:series:…`; géneros de `korg` → fuente correcta.

---

### E-02

**`/mp4` rechazaba `zudrama.top` con 403**

- **Severidad:** Crítico (ningún stream de korg era reproducible)
- **Estado:** ✅ Arreglado en `deno/fetch.ts:270-281` (commit `118cfbb`)
- **Ubicación original:** `deno/fetch.ts` (`doodMp4HostAllowed`)

**Síntoma.** Las URLs que generaba el addon devolvían:

```
GET /mp4?url=https://hlsz.zudrama.top/media/...&r=https://kisskh.org/
→ 403 {"error":"host not allowed"}
```

**Causa.** La allowlist del relay MP4 solo aceptaba la familia Dood:

```ts
return /(?:cloudatacdn|doodcdn|dscdn|dood)/i.test(host);
```

Los MP4 de kisskh.org se sirven desde `hlsz.zudrama.top` y además exigen `Referer: https://kisskh.org/` (sin él, 403 también en origen).

**Arreglo aplicado.**

```ts
return /(?:cloudatacdn|doodcdn|dscdn|dood|zudrama\.)/i.test(host);
```

**Verificación (proxy local).**

| Prueba | Resultado |
|---|---|
| `HEAD /mp4` zudrama | `200`, `video/mp4`, 383 881 706 B |
| `GET /mp4` con `Range: bytes=0-1023` | `206`, `ftypisom` |
| URL exacta generada por `getStreams` | `206`, MP4 válido |
| `/mp4` con host no permitido | `403` (la allowlist sigue filtrando) |
| `OPTIONS /mp4` | `204` |

> Requiere **reiniciar** el proxy Deno para tomar el cambio y **redesplegar** Deno Deploy (ver E-08).

---

## Abiertos

### E-03

**`FETCH_PROXY_URL` apunta a `localhost` en `wrangler.toml`**

- **Severidad:** Alto (si se despliega tal cual, todos los streams proxeados de todas las fuentes apuntan al PC del desarrollador)
- **Estado:** ⚠️ Pendiente · cambio **sin commitear** en `wrangler.toml:22-23`

```toml
FETCH_PROXY_URL = "http://localhost:8000/fetch"
# FETCH_PROXY_URL = "https://stremio-doramas.jbr1989.deno.net/fetch"
```

`denoBaseFromEnv` (`src/lib/utils.ts:583-588`) construye desde ahí las URLs de `/hls` y `/mp4`, así que afecta a **todas** las fuentes, no solo a korg.

**Arreglo.** Restaurar la URL de producción antes de cualquier `wrangler deploy` (o sobreescribirla en el dashboard / con `--var`).

---

### E-04

**Películas de korg: 0 streams**

- **Severidad:** Alto
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:247-281`

**Síntoma.**

```
getStreams("korg:movie:love-arumirai") → 0 streams
GET https://kisskh.org/movies/love-arumirai/ → 200
```

**Causa.** La rama `isMovie` solo busca un iframe `jwplayer` y otros `<iframe>`. El sitio ya no sirve así las películas: usan el **mismo** `data-post-id` + feed de Blogger que las series.

**Evidencia.**

```
data-post-id en /movies/love-arumirai/ = 3455540335662863398
feed Blogger → 1 sección con mp4 en hlsz.zudrama.top + 11 subtítulos .vtt
```

**Arreglo propuesto.** Reutilizar el parser de secciones de series (`kisskhorg.ts:284-348`) con `epNum = 1`. Es el mismo cambio que resuelve la cara A de E-05: ambas páginas se resuelven igual.

---

### E-05

**Ids de 3 segmentos (`korg:series:{slug}`) rompen la ruta IMDb y contaminan el fan-out**

- **Severidad:** Crítico
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:45-47` (`cardId`), `:202-211` (`toEpSlug`/`buildId`), `:218-233` (`getStreams`); interacción con `src/lib/imdb.ts:296-305` y `src/resolve.ts:59-76`

**Causa.** `cardId` mete el tipo en el id:

```ts
return `${this.prefix}:${entry.type}:${entry.slug}`;  // korg:series:the-remarried-empress
```

Pero el resto del addon asume `{prefijo}:{slug}` y reutiliza el slug como **epSlug compartido** entre fuentes (`src/lib/sourceBase.ts:76-89`). `imdb.ts:300` corta solo `"korg:"`, así que el tipo se cuela dentro del slug:

```ts
const seriesSlug = m.seriesId.slice(prefix.length + 1);   // "series:the-remarried-empress"
const epId = def.buildId(`${seriesSlug}-1x2`);            // "korg:ep:series:the-remarried-empress-1x2"
if (def.isEpisodeId(epId)) return epId;                   // ← pasa (ver E-11)
```

**Evidencia.**

```
getStreams("korg:ep:series:the-remarried-empress-1x2") → 0 streams
GET https://kisskh.org/tvshows/series:the-remarried-empress/ → 404
```

**Impacto real.** No se limita a korg: `resolve.ts:71-75` propaga `toEpSlug()` a las otras 12 fuentes, así que si korg gana el match de IMDb (`getImdbMatches`, ordenado por score) **el título se queda sin streams en todo el addon**.

**Dos caras del problema**

- **Cara A — películas por fan-out (`korg:ep:{slug}-1x1`)**: el epSlug compartido no lleva tipo, así que una película ajena llega a korg como episodio 1 de una serie → busca `/tvshows/` → 404. Las demás fuentes no se ven afectadas; solo se pierde la cobertura de korg.
- **Cara B — contaminación con `movie:`**: si korg gana el match con una tarjeta de película, `imdb.ts` produce `korg:ep:movie:{slug}-1x1` y `toEpSlug` propaga `movie:{slug}-1x1` a todas las fuentes.

**Arreglo propuesto**

1. **Saneamiento** (coste 0): limpiar `series:`/`movie:` residual en `toEpSlug` (rama `ep`) y en `buildId`. Cierra la cara B.
2. **Descubrimiento**: en `getStreams`, si `/tvshows/{slug}/` no trae `data-post-id`, reintentar `/movies/{slug}/` y parsear el mismo Blogger. Cierra la cara A y, de paso, **E-04**.
3. Opcional: sembrar el tipo en KV al parsear catálogos (el `href` de la tarjeta ya dice `/tvshows/` o `/movies/`), eliminando casi todos los sondeos.

**Datos medidos**

- Slugs: 109 de series vs 101 de películas en 4 páginas de cada listado → **0 colisiones** (riesgo bajo, no nulo).
- Coste del sondeo: 1 petición extra (el 404) **solo en películas**; series 0 extra. Amortiguado por `TTL.meta` 2 h y `TTL.stream` 30 min.
- Casos comprobados: `the-beauty-inside` (serie), `love-arumirai` (película), `tamed`, `reborn`, `perfect-crown`, `when-the-phone-rings`, `the-first-frost`.

**Nota:** el detalle completo está en `C:\Users\jbr1989\.opencode\plan\korg-peliculas-fan-out.md`.

---

### E-06

**Paginación con huecos: `pageSize = 24` frente a 35 reales**

- **Severidad:** Medio
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/lib/sourceBase.ts:208-210` (default 24), `src/alldoramas.ts:56` (`page: 24`); korg no define `pageSize`

**Causa.** `pageFromSkip` calcula `Math.floor(skip / pageSize) + 1`. El sitio sirve **35** tarjetas por página (tanto `/tvshows/` como los géneros). Con `skip=100` se pide la página 5 y se saltan las 2-4.

**Arreglo propuesto.** `pageSize = 35` en `kisskhorg.ts` y `page: 35` en `src/alldoramas.ts:56`.

---

### E-07

**Películas publicadas como `type: "series"`**

- **Severidad:** Medio
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/lib/utils.ts:466-478` (`toMetaPreview` hardcodea `type: "series"`), `src/manifest.ts:118-123` (solo catálogo `series`)

**Síntoma.** Las tarjetas de película se muestran como serie; Stremio abre `/meta/series/{id}` y luego `/stream/series/{id}`.

**Evidencia.**

```
Género Romance: 35 tarjetas → 11 series, 24 películas
SEARCH → { id: "korg:movie:…", type: "series" }
getMeta → type "movie"
```

**Efecto combinado con E-04.** Muchísimas fichas del catálogo "KissKH.org — Directorio" (y de "Todos los Doramas", que reutiliza el mismo `getCatalog`) no tienen ningún stream.

**Opciones.** (a) `filterCards` que descarte películas; (b) catálogo `type: "movie"` propio en el manifest; (c) arreglar E-04 y mantenerlas.

---

## Operación / despliegue

### E-08

**Deno Deploy desactualizado**

- **Severidad:** Crítico (producción no reproduce korg)
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `https://stremio-doramas.jbr1989.deno.net`

**Evidencia.** El despliegue actual devuelve `403` tanto en `/fetch` para `kisskh.org` como en `/mp4` para `zudrama.top`, es decir, no tiene ni la allowlist de kisskh.org ni el fix de E-02.

**Arreglo.** Redesplegar `deno/fetch.ts` con la versión actual. Después, restaurar `FETCH_PROXY_URL` (E-03).

---

### E-09

**`www.blogger.com` fuera de la allowlist de `/fetch`**

- **Severidad:** Medio
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `deno/fetch.ts:99-100`

**Síntoma.**

```
GET /fetch?url=https://www.blogger.com/feeds/... → 403 {"error":"host not allowed"}
```

**Causa.** La allowlist incluye `kisskh.org` pero no `www.blogger.com`. Hoy no rompe nada porque el Worker pide el feed directamente (`direct GET → 200`), pero `fetchHtml` usa `Promise.any` y **no tiene plan B** para Blogger: si el egress de Cloudflare falla, la meta y los streams de korg se quedan vacíos.

**Arreglo.** Añadir `www.blogger.com` a la allowlist de `/fetch`.

---

## Riesgos latentes

### E-10

**`kplay`/`yandi` tienen el mismo bug de ids de 3 segmentos**

- **Severidad:** Alto (latente)
- **Estado:** ⚠️ Pendiente · no introducido en esta rama
- **Ubicación:** `src/sources/yandispoiler.ts:181` (`cardId`), `:135-141` (`toEpSlug`); `kplay` lo hereda

```ts
protected override cardId(entry: SourceCard): string {
  return `${this.prefix}:${entry.type}:${entry.slug}`;   // kplay:series:{slug}
}
```

Su `toEpSlug` tampoco limpia `series:`. Es el mismo mecanismo que E-05 en la ruta IMDb. No conviene copiar ese patrón para korg; si se tocan, el arreglo correcto es el mismo (limpiar en `buildId`/`toEpSlug`).

---

### E-11

**`epIdPattern` permisivo: `.` casa con `:`**

- **Severidad:** Medio
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:21` (y el equivalente en `yandispoiler.ts:130`)

```ts
readonly epIdPattern = "(?:ep:.+-\\d+x\\d+|movie:.+)";
```

`isEpisodeId("korg:ep:series:the-remarried-empress-1x2")` → `true`, y también `korg:ep:movie:{slug}-1x1`. Un id malformado pasa la validación **en silencio** en `imdbToEpisodeId`, en vez de descartarse y probar el siguiente candidato.

**Arreglo propuesto.** Restringir el slug, p. ej. `(?:ep:[a-z0-9-]+-\d+x\d+|movie:[a-z0-9-]+)`. Ojo: el patrón es **por fuente** (kissasia usa `ep:{id}:{epId}:{n}`).

---

### E-12

**`buildPageUrl` y `getStreams` duplican la resolución de URL**

- **Severidad:** Bajo
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:23-27` y `:222-233`

`buildPageUrl` ya resuelve bien serie vs película, pero `getStreams` está sobrescrito y repite la lógica a mano con una rama `isMovie` incompleta (E-04). Dos copias de la misma decisión, una correcta y otra no.

**Arreglo.** Un helper único (`resolvePage(slug)`), usado por ambos.

---

## Menores

### E-13

| Fallo | Ubicación | Detalle |
|---|---|---|
| Títulos con año | `kisskhorg.ts:76,91` | Ver **E-22**: el selector `<h3><a>` nunca casa y el `alt` trae `TAMED (2026)`. |
| Idioma de subtítulos | `kisskhorg.ts:301-328` | Ver **E-24**: la cabecera `URL\|idiomas\|` se descarta y todo lo que no sea es/en sale `xx`. |
| 3 fetch secuenciales | `kisskhorg.ts:100-114` | Ver **E-23**: el primer blog ID devuelve 404 en todos los posts probados. |
| Episodios fantasma | `kisskhorg.ts:176-188` | Ver **E-17**: hay fichas sin `data-post-id` que generan 1 episodio inventado. |
| Caché por episodio | `kisskhorg.ts:218-242` | Cada episodio re-descarga ficha + feed (mitigado por `stream:v4:` 30 min). |
| Selector de búsqueda frágil | `kisskhorg.ts:67` | La búsqueda exige literalmente `<div class="result-item">`. |
| Nombre duplicado | `manifest.ts:103,121` | "KissKH" (kisskh.co) y "KissKH.org" conviven; fácil confundirlos en Stremio. |

---

## Documentación

### E-14

| Documento | Problema |
|---|---|
| `README.md:12-24` | No existe la fila de `korg:`. |
| `README.md:208` | `/debug-all` dice **11** fuentes; `SOURCES` tiene **13** (`registry.ts:52-66`). |
| `deno/README.md:14` | La allowlist de `/fetch` no incluye `kisskh.org` ni `kissasia.cam` (el código sí). |
| `deno/README.md` | `/mp4` no menciona `zudrama.top` ni el requisito de `Referer`. |
| `package.json:3` | `1.10.0` vs `src/manifest.ts:31` → `1.11.1`. |

---

## Segunda pasada (2026-11-04)

Análisis a fondo de `kisskhorg.ts`, los helpers compartidos (`dooplay.ts`, `utils.ts`, `sourceBase.ts`, `genres.ts`, `manifest.ts`) y `deno/fetch.ts`, con pruebas en vivo contra kisskh.org y el proxy local. Los errores E-15…E-24 son nuevos; los que ya estaban en E-13 se han sacado a su propia entrada cuando tenían entidad suficiente.

### E-15

**La temporada se ignora: `S2E1` y `S3E1` devuelven el vídeo de `S1E1`**

- **Severidad:** Alto (contenido incorrecto servido en silencio, peor que un 404)
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:228-229` (`epNum`), `:162-171` (meta con `season: 1` fijo)

**Causa.** `getStreams` calcula el episodio solo con la parte `E` del id y descarta la temporada:

```ts
const mEp = withoutPrefix.match(/-(\d+)x(\d+)$/);
const epNum = mEp ? parseInt(mEp[2], 10) : 1;   // ← la S se descarta
```

`getMeta` hace lo mismo al revés: genera **siempre** `season: 1` y `episode: idx + 1`, una por cada sección del feed.

**Evidencia medida** (`squid-game` declara `Seasons = 3`, `Episodes = 22`):

```
korg:ep:squid-game-1x1 -> https://hugh.cdn.rumble.cloud/.../uIY5v.caa.mp4
korg:ep:squid-game-2x1 -> https://hugh.cdn.rumble.cloud/.../uIY5v.caa.mp4   ← mismo vídeo
korg:ep:squid-game-3x1 -> https://hugh.cdn.rumble.cloud/.../uIY5v.caa.mp4   ← mismo vídeo
korg:ep:squid-game-1x9 -> https://hugh.cdn.rumble.cloud/.../D2Z5v.caa.mp4   ← correcto
```

El feed de Blogger de esa ficha solo trae **9 secciones** (temporada 1) de los 22 episodios que anuncia la página.

**Modelo del sitio (medido).** Las temporadas se publican como **fichas separadas**:

```
/tvshows/squid-game-season-2/          200 · postId=1454164275216928182 · 7 secciones  ✅
/tvshows/alchemy-of-souls/             200 · 20 secciones (la ficha dice 30 episodios)
/tvshows/alchemy-of-souls-season-2/    200 · SIN post-id → 0 streams (ver E-17)
/tvshows/squid-game-2/                 404 (el patrón es "-season-N")
```

**Impacto.** Si el episodio llega por IMDb/Cinemeta o por el fan-out (`korg:ep:{slug}-2x1`), el usuario ve el episodio 1 de la temporada 1 creyendo que ve el de la 2. Desde el catálogo propio la T2 aparece como otra ficha, pero la ficha de la T1 sigue anunciando 3 temporadas y mostrando 9 episodios.

**Arreglo propuesto.**

1. **Mínimo y urgente:** si `S > 1` y la ficha declara `Seasons > 1`, devolver `[]` en lugar de un vídeo equivocado.
2. **Completo:** para `S > 1`, resolver `{slug}-season-{s}` cuando exista; si no, `[]`.
3. En `getMeta`, leer `Seasons`/`Episodes` de los `custom_fields` y no prometer más de lo que el feed puede servir.

---

### E-16

**`/hls` bloquea `media.dramasub.top`: hay episodios reales en `.m3u8`**

- **Severidad:** Alto (esos episodios no reproducen)
- **Estado:** ⚠️ Pendiente · **corrige la nota de E-13** ("ningún vídeo usa `.m3u8`")
- **Ubicación:** `deno/fetch.ts:157-163` (`hlsHostAllowed`)

**Evidencia.** Muestra de 51 secciones de vídeo de 5 series:

```
43  hugh.cdn.rumble.cloud     MP4 directo · CORS * · sin referer → OK
 4  hlsz.zudrama.top          MP4 con referer → /mp4 (E-02) → OK
 4  media.dramasub.top        HLS (.m3u8) con referer · SIN CORS
```

Pruebas directas:

```
GET https://media.dramasub.top/dramahot/000023/Ep09_index.m3u8
  sin referer        → 403 text/html
  con referer kisskh → 200 audio/x-mpegurl (22950 B)

GET https://media.dramasub.top/dramahot/000023/index0.ts
  sin referer        → 403
  con referer kisskh → 200 video/vnd.dlna.mpeg-tts (1 966 668 B)

GET http://localhost:8000/hls?u=<esa playlist>&r=https://kisskh.org/
  → 403 {"error":"host not allowed"}
```

**Causa.** `hlsHostAllowed` solo admite SaveFiles/StreamHLS/premilkyway/devcorp y los CDN `cdn-tnmr`/`sprintcdn`. `media.dramasub.top` no está. La playlist es una **media playlist** con segmentos relativos (`index0.ts`), y `rewriteM3u8` (`deno/fetch.ts:368-385`) ya los resuelve y reproxa bien; el addon también genera bien la URL `/hls` (`kisskhorg.ts:368-381`). El único fallo es la allowlist.

**Arreglo.** Añadir `dramasub\.top` a `hlsHostAllowed` (playlist y segmentos comparten host). Requiere reiniciar el proxy local y redesplegar (E-08).

---

### E-17

**Fichas sin `data-post-id`: 1 episodio fantasma y 0 streams**

- **Severidad:** Medio
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:176-188` (fallback de episodios), `:284-286` (`getStreams`)

**Evidencia.**

```
/tvshows/sweet-home/                 200 · sin post-id · sin campo Episodes
/tvshows/alchemy-of-souls-season-2/  200 · sin post-id · data-id="1628"
/movies/sweet-home/                  404 (solo existe como "tvshow")
/movies/alchemy-of-souls-season-2/   404
```

**Comportamiento actual.**

- `getMeta`: el fallback busca `<b class="variante">Episodes</b>`, no lo encuentra → `totalEps = 1` → **un episodio inventado**.
- `getStreams`: `if (!postId) return { streams: [] }` → **0 streams**.

**Causa.** Son fichas que el sitio sirve con otro mecanismo: el vídeo llega por `/wp-json/dooplayer/v2/` usando el `data-id` de la página (observado `data-id="1628"`), que la fuente no implementa.

**Arreglo propuesto.** O soportar el endpoint de dooplayer, o filtrar estas fichas del catálogo (no listarlas si no tienen `data-post-id`). Mientras tanto, al menos no generar el episodio fantasma.

---

### E-18

**Allowlist de `/mp4` y `/hls` por subcadena + redirecciones seguidas**

- **Severidad:** Medio (seguridad: relay abierto de bajo impacto)
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `deno/fetch.ts:280` (`doodMp4HostAllowed`), `:157-163` (`hlsHostAllowed`), `:310` (`redirect: "follow"`)

**Causa.** El regex no está anclado al host completo:

```ts
return /(?:cloudatacdn|doodcdn|dscdn|dood|zudrama\.)/i.test(host);
```

Pasan `zudrama.atacante.com`, `dood.evil.tld`, `notdoodcdn.com`, etc. En `/hls` ocurre lo mismo con `/cdn-tnmr/` y `/(sprintcdn|owphbf24)/`. Además el `fetch` sigue redirecciones (`redirect: "follow"`), así que un host permitido puede redirigir a cualquiera sin revalidar el destino final.

**Arreglo propuesto.** Anclar a `(^|\.)host$` (como ya hace `/fetch` en `:100`) y revalidar `r.url` tras la redirección; o usar `redirect: "manual"`.

---

### E-19

**`isZudrama` cablea `.top` y es el único CDN con proxy MP4**

- **Severidad:** Bajo
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:366` (`isZudrama`), `:388-402`

```ts
const isZudrama = /zudrama\.top/i.test(url);
```

Si el CDN rota de TLD, o aparece otro host con hotlink protection (la familia Dood ya está en la allowlist de `/mp4` pero aquí no se usa), el stream va **directo** y muere con 403 sin aviso. Además, si `FETCH_PROXY_URL` está vacío, `isZudrama && denoBase` cae al `else` y también sirve directo.

**Arreglo propuesto.** Detectar por allowlist compartida (los mismos hosts de `/mp4`) en lugar de por nombre literal, o al menos cubrir `zudrama\.[a-z]+`.

---

### E-20

**Ids sin `ep:`/`movie:` caen a `/tvshows/series:…`**

- **Severidad:** Bajo
- **Estado:** ⚠️ Pendiente · misma familia que E-05
- **Ubicación:** `src/sources/kisskhorg.ts:222-233`; también `buildPageUrl` `:23-27`

**Evidencia.**

```
getStreams("korg:series:the-remarried-empress")
  → withoutPrefix = "series:the-remarried-empress"
  → GET https://kisskh.org/tvshows/series:the-remarried-empress/ → 404
```

Pasa cuando Stremio pide `/stream/series/{id}` con el id de catálogo (fichas sin `videos` o clientes que no expanden episodios).

**Arreglo.** Incluir la limpieza de `series:` también en `getStreams` y `buildPageUrl`, no solo en `buildId`/`toEpSlug` (E-05).

---

### E-21

**Descripción basura cuando TMDB no matchea**

- **Severidad:** Bajo
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/lib/dooplay.ts:54-59` (`ogMetaFromHtml`), `:163-200` (`buildSeriesMeta`)

**Evidencia.**

```
og:description de /tvshows/the-remarried-empress/
→ "The Remarried Empress | Kisskh, Vivamax, Dramacool"
```

`buildSeriesMeta` usa `tmdb?.description || p.description`. Si TMDB no matchea (o `TMDB_KEY` falta), la ficha muestra esa línea de keywords como sinopsis. `og:title` sí se limpia (`cleanTitle` corta por `\s+[–—|]\s+`), pero la descripción no.

---

### E-22

**Títulos con año: `TAMED (2026)`, y el selector `<h3><a>` nunca casa**

- **Severidad:** Bajo
- **Estado:** ⚠️ Pendiente · detalle de E-13
- **Ubicación:** `src/sources/kisskhorg.ts:76,90-91`; `src/lib/utils.ts:519-529` (`cleanTitle`)

**Evidencia (HTML real de `/tvshows/`).**

```html
<h3 class="title">TAMED (2026)</h3>
```

El selector de la línea 90 es `<h3><a…>`, que no casa con `<h3 class="title">`. El título cae al `alt` de la imagen, que también trae `"TAMED (2026)"`, y `cleanTitle` no elimina el año.

**Arreglo.** `cleanTitle` debe quitar `\s*\((?:19|20)\d{2}\)\s*$` (comprobar antes el impacto en las otras fuentes) o hacerlo en `parseCards`.

---

### E-23

**El primer blog ID devuelve 404 en todos los posts probados**

- **Severidad:** Bajo (coste, no rotura)
- **Estado:** ⚠️ Pendiente
- **Ubicación:** `src/sources/kisskhorg.ts:10-13` (`KISSKHORG_BLOG_IDS`), `:100-114`

```
blog 1057291146892246657 → 404   (siempre)
blog 7579509578995758860 → 200   (el que sirve los posts)
```

Cada `getMeta`/`getStreams` gasta una petición inútil, y encima lo intenta primero por el proxy (`/fetch`), que da 403 (E-09). Puede reordenarse la lista, lanzarse en paralelo o cachear `blogId` por post.

---

### E-24

**La cabecera de idiomas del feed se descarta**

- **Severidad:** Bajo
- **Estado:** ⚠️ Pendiente · detalle de E-13
- **Ubicación:** `src/sources/kisskhorg.ts:300-320`

Cada sección empieza por `URL|English|` (o una lista de idiomas), y el código solo usa `header.split("|")[0]`. El idioma de cada subtítulo se deduce del nombre del fichero (`spanish|spa|esp`, `english|eng`), así que todo lo demás queda `xx` con el nombre del fichero como etiqueta. La cabecera ya trae los idiomas reales.

**Arreglo.** Parsear la lista de idiomas de la cabecera y emparejarla con los `.vtt` por orden o por código.

---

## Validado en la segunda pasada (sin error)

| Comprobación | Resultado |
|---|---|
| Los 19 géneros de korg (`genreSlug("korg", …)`) | todos `200` |
| Clave de caché de catálogo (`src/routes/stremio.ts:21-23`) | incluye `search` + `genre` + `skip` ✅ |
| `withGenre` del manifest | incluye `skip` ✅ (la paginación llega bien; el problema es E-06) |
| Páginas 404 | `fetchHtml` corta y lanza; `getMeta` devuelve `null` (no fabrica fichas) ✅ |
| 12 primeras fichas de `/tvshows/` | todas con `data-post-id` (E-17 es minoritario) ✅ |
| MP4 de `rumble.cloud` | `200`, CORS `*`, sin referer → el branch directo es correcto ✅ |
| `rewriteM3u8` | resuelve segmentos relativos y los reproxa ✅ (solo falta la allowlist, E-16) |
| Feed de películas | 1 sección + subtítulos → E-04 es solo el parser ✅ |

## Prioridad sugerida

1. **E-15** — contenido incorrecto servido en silencio (mínimo: no devolver `S1E1` para `S>1`).
2. **E-16** — episodios que no reproducen (una línea en el proxy).
3. **E-04 + E-05 (cara A)** — películas y fan-out de korg.
4. **E-17** — decidir dooplayer u ocultar las fichas sin `data-post-id`.
5. **E-18** — anclar allowlists.
6. **E-06, E-07, E-19…E-24** y documentación (E-14).

---

## Notas de reproducción

- El proxy Deno local **ya está corriendo** en `http://localhost:8000`; no hay que arrancarlo ni reiniciarlo desde el agente. Tras cambiar `deno/fetch.ts` hay que reiniciarlo a mano para que cargue el código nuevo.
- Las pruebas de esta revisión se hicieron con:

```ts
const env = { FETCH_PROXY_URL: "http://localhost:8000/fetch", TMDB_KEY: "" };
```

- Verificación estática válida: `deno check deno/fetch.ts` (exit 0) y `npx tsc --noEmit`.
