# stremio-doramas — Addon de Doramas para Stremio

Addon de Stremio para ver **doramas en español** (sub español/latino), corriendo como Cloudflare Worker. Agrega catálogos, metadatos y streams de varios sitios de doramas.

> Basado en el addon original de anime
> [Vegettoson83-latanime-stremio-addon](https://github.com/Vegettoson83/Vegettoson83-latanime-stremio-addon),
> cuya arquitectura (Cloudflare Worker + proxy Deno) se adapta aquí a fuentes de doramas.

## Fuentes implementadas

| Prefijo del ID | Sitio | Archivo | Tecnología | Estado |
|---|---|---|---|---|
| `dorama:` | [doramaslat.com](https://doramaslat.com) | `src/sources/doramas.ts` | WordPress + tema DooPlay | ✅ Funcional |
| `dsub:` | [doramedplay.net](https://doramedplay.net) | `src/sources/doramas.ts` | WordPress + tema DooPlay | ✅ Funcional |
| `kplay:` | [kdramasplay.com](https://kdramasplay.com) | `src/sources/kdramasplay.ts` | WordPress + tema DooPlay | ⚠️ Episodios sin streams (ver problema conocido) |
| `dflix:` | [doramasflix.in](https://doramasflix.in) | `src/sources/doramasflix.ts` | App propia (GraphQL) | ✅ Funcional |
| `tudorama:` | [tudorama.com](https://tudorama.com) | `src/sources/tudorama.ts` | WordPress + tema WStream | ⚠️ Miniaturas/pósters en blanco en Stremio Web (ver problema conocido) |
| `pandrama:` | [pandrama.tv](https://www.pandrama.tv) | `src/sources/pandrama.ts` | App propia (Laravel + React) | ✅ Funcional |

Todas exponen catálogo (directorio + búsqueda), meta con episodios (pósteres vía TMDB) y streams.

### Espejos de cabeceras para `dflix` (failover de `fetchGql`)

Los siguientes dominios son **la misma plataforma que doramasflix**: comparten el
backend GraphQL `https://user-api.seriesapi.co/graphql` (verificado in-vivo:
misma BD, mismos `_id` y posters TMDB; y `doramasmp4.io` lo declara literal en
su bundle con Apollo). No se exponen como fuentes separadas ni agregan catálogo
propio: el addon usa `doramasflix.in` como origen primario y, ante un fallo de
petición (red, timeout, HTTP ≠ 2xx), reintenta con las cabeceras `Origin/Referer`
de cada espejo, uno a uno:

| Dominio | Papel |
|---|---|
| [doramasflix.in](https://doramasflix.in) | Origen primario |
| [doramasia.com](https://doramasia.com) | Espejo (skin Next.js de la plataforma) |
| [doramasflix.io](https://doramasflix.io) | Espejo (misma marca, web alternativa, con SSR de episodios en `/capitulos/{slug}-SxE`) |
| [doramasmp4.io](https://doramasmp4.io) | Espejo (otra marca de la plataforma) |

En el camino feliz cuesta 1 petición; los espejos solo se consultan de forma
secuencial cuando el intento anterior falla (timeout, HTTP ≠ 2xx). **Límite**:
al ser 1 solo backend, si `seriesapi.co` cae, caen los 4 a la vez — el failover
protege contra dominio confiscado o validación de `Origin` bloqueada, no contra
la caída total del backend.

> Nota de investigación (oct. 2026) — si algún día los backends divergen: la
> plataforma expone además queries GraphQL no usadas por `dflix`
> (`MovieLinks`, `NextPrevEpisode`, `EpisodesPagination`) y sus skins
> personalizan servidores como Streamwish, Dood, Mixdrop, Mp4Upload,
> Streamtape, Filemoon, Mega, Ok, Primeload, Uqload. `doramasia.com` tiene
> además SSR de episodios en `/capitulos/{slug}-SxE` (fallback HTML posible).

### Cómo funciona la extracción (sitios DooPlay)

Los tres sitios WordPress usan el tema **DooPlay**, cuyo patrón es idéntico:

1. Página de episodio (`/episodios/{slug}-SxE/`, `/episodes/{slug}-SxE/`) → parsear `<li class="dooplay_player_option" data-post data-nume data-type>`.
2. POST a `/wp-admin/admin-ajax.php` con `action=doo_player_ajax&post=…&nume=…&type=…` → devuelve `{"embed_url": "…"}`.
3. Resolver el embed según el host de video.

### Hosts de video soportados

| Host / familia | Resolución | Vía |
|---|---|---|
| StreamWish y espejos (`streamwish`, `embedwish`, `wishfast`, `sfastwish`, `swishsrv`, `streamaly`, `streamis`, `flaswish`, `do7go`, `playmogo`) | HLS `.m3u8` | Proxy Deno `/streamwish` |
| `savefiles.com`, `streamhls.to` | HLS `.m3u8` | Proxy Deno `/savefiles` |
| `mp4upload.com` | MP4 directo | `extractMp4upload` (`src/extractors.ts`) |
| `hexload.com` | MP4 directo | `extractHexload` (`src/extractors.ts`) |
| `pixeldrain.com` | MP4 directo | API pública de pixeldrain |
| Cualquier otro | — | Fallback `externalUrl` (abrir en navegador) |

## ✅ Problema conocido, resuelto: `kplay` sin streams en episodios

**Síntoma** (histórico): al abrir un episodio de `kplay:series:…` no aparecía ningún stream reproducible, y en las otras fuentes los embeds de `streamaly`/`streamis`/`flaswish` morían en silencio.

**Causa raíz verificada** (oct. 2026): kdramasplay migró su host de video a **`do7go.com`, que redirige a `playmogo.com`** (espejo de StreamWish) y responde **403 con challenge de Cloudflare** a IPs de datacenter. Ese dominio no estaba en ninguna de las dos allowlists:

1. Regex de StreamWish en el Worker (`kdramasplay.ts` y `doramas.ts`): no incluían `do7go|playmogo` → el embed caía al fallback `externalUrl` (no reproducible en Stremio).
2. Allowlist del proxy Deno (`deno/fetch.ts`): `/streamwish` no aceptaba `do7go|playmogo` — y tampoco `streamaly|streamis|flaswish`, que sí estaban en las regex del Worker → **403 silencioso** (stream muerto sin log en el Worker).

**Fix aplicado** (oct. 2026): la misma regex canónica en los 4 puntos — la 3 fuentes del Worker y el `/streamwish` de Deno — ahora comparten la lista completa:

```
streamwish|embedwish|wishfast|sfastwish|swishsrv|streamaly|streamis|flaswish|do7go|playmogo
```

**Pendiente tras el deploy** (no es código, es validación en producción):

- Redesplegar **ambos** servicios: el Worker (push a `main`) **y** el proyecto de Deno Deploy (la allowlist vive en su edge; un push del Worker no la actualiza).
- Si el edge de Deno también recibe el challenge de Cloudflare de do7go/playmogo, la playlist no se resolverá: ahí haría falta Cloudflare Browser Rendering como último recurso.
- Limpiar la caché KV afectada: `/cache-clear?key=stream:v3:kplay:ep:{slug}` (las entradas viejas guardan el fallback `externalUrl`).

## ⚠️ Problema conocido, sin tratar de momento: tudorama oculta sus imágenes por Referer

**Síntoma** (oct. 2026): en Stremio Web, los capítulos de `tudorama:` aparecen
sin miniaturas y las imágenes de la fuente (`/serie/{slug}` y catálogo) tampoco
cargan. Los metas están bien (in-vivo: `/meta/series/tudorama:…` sirve
`thumbnail` en el 100% de los episodios) — lo que falla es la **descarga** de la
imagen en el navegador.

**Causa raíz verificada**: tudorama.com aplica **hotlink protection por
Referer** a todas sus imágenes (miniaturas de episodio, pósters del catálogo,
póster del meta). La misma URL devuelve:

| Referer | Resultado |
|---|---|
| `https://app.stremio.com/` (Stremio Web) | **403** |
| ninguna | 200 |
| `tudorama.com` (propio sitio) | 200 |

El resto de hosts del addon no bloquean por Referer (doramaslat, doramedplay,
shortpixel, TMDB — todos 200 con Referer de Stremio), así que las miniaturas
funcionan en Stremio Web para los otros prefijos (`dorama:`, `dsub:`, `kplay:`,
`dflix:`, `pandrama:`).

**Decisión (oct. 2026)**: documentado y **no se hace nada de momento**. En
Stremio Desktop el problema suele no darse; la miniatura tiene fallback al
póster solo si el dato del episodio viene vacío, no si falla la descarga
cliente-side.

## Fuentes futuras (investigadas, pendientes de integrar)

| Sitio | Tecnología | Hallazgos | Esfuerzo |
|---|---|---|---|
| **[doramasyt.com](https://www.doramasyt.com)** | App propia (no WP), carga dinámica | Episodios `/ver/{slug}-episodio-N`; servidores DooD, StreamTape, Filemoon → requiere extractores nuevos (DooD/StreamTape son duros; Filemoon viable). | Alto |
| **[seriesbl.net](https://seriesbl.net)** | WordPress + DooPlay | Patrón DooPlay estándar: basta añadir una entrada a `DORAMA_SOURCES`. Nicho: series/pelis Boys Love. | Bajo |

Descartados: `doramedplay.com` (misma marca que doramedplay.net, ya integrada como `dsub:`), `doramasmp4.com` (muerto, redirige a la alianza antipiratería; **no confundir con `doramasmp4.io`, espejo vivo de la plataforma doramasflix** — ver arriba) y `doramasia.com` como fuente independiente (es espejo de la plataforma dflix, ver arriba; su contenido ya se sirve bajo `dflix:`).

Orden de integración sugerido: `doramasyt.com` → `seriesbl.net` (nicho). (El fix de `kplay` está aplicado — ver arriba.)

## Añadir a Stremio

El addon desplegado vive en:

```
https://stremio-doramas.jbr1989-b26.workers.dev/manifest.json
```

En Stremio → **Addons** → **Community Addons** → pegar la URL → Instalar 🎉

> El nombre del Worker en el dashboard de Cloudflare es `123456`, que es lo que
> determina la URL de `workers.dev`. Si renombras el Worker, la URL cambia y toda
> instalación existente en Stremio se rompe — actualiza `name` en `wrangler.toml`
> y este README a la vez si algún día lo haces.

## Cómo se despliega

**No hay workflow de despliegue en GitHub Actions** — añadirlo provocaría un doble despliegue.

- **Worker** (`src/index.ts`): desplegado por **Cloudflare Workers Builds** (la
  integración Git del dashboard) en cada push a `main`.
- **Proxy de fetch/HLS** (`deno/fetch.ts`): desplegado por la **integración Git
  de Deno Deploy** (entrypoint fijado por `deno.json`). Los sitios de doramas
  bloquean el egress del Worker de Cloudflare, así que el Worker relay el HTML por
  este proxy (`FETCH_PROXY_URL` en `wrangler.toml`); además, los hosts IP-bound
  (StreamWish, savefiles/streamhls) se resuelven y sirven íntegramente desde la
  IP estable de Deno. Ver `deno/README.md` para las rutas y allowlists.
  Nota: cambiar la allowlist del proxy requiere *redeploy de Deno Deploy*, no
  basta con un push del Worker.

## Despliegue manual (solo emergencias)

```bash
npm install
npx wrangler login
npx wrangler deploy
```

`name` en `wrangler.toml` debe seguir siendo `123456` (el Worker en producción);
si no, esto crea un segundo Worker en otra URL en vez de actualizar el real.

`npx tsc --noEmit` es la única verificación del proyecto (cubre `src/`).

## Comprobaciones de salud

- `https://123456.vegettoson83.workers.dev/_health` — versión + binding KV
- `https://123456.vegettoson83.workers.dev/debug` — config (proxy, rendering)
- `/debug-streamwish?url=<embed>` — resuelve un embed de StreamWish (m3u8 + URL Deno)
- `/debug-savefiles?code=<code>` — resuelve un código savefiles/streamhls
- `/debug-host?url=<embed>` — trae la página de un embed y vuelca las URLs de medios
- `/debug-mixdrop?url=<embed>` — resuelve un embed de Mixdrop
- `/debug-render?url=<url>` — prueba de Cloudflare Browser Rendering
- `/debug-dood?url=<embed>` — resuelve un embed de la familia Dood (do7go/playmogo/dood.*) a un MP4 provisional vía `pass_md5`; devuelve el MP4 final y la URL del relay Deno `/mp4`
- `/debug-all` — chequea las 7 fuentes a la vez (una llamada, un episodio de muestra por fuente; `?ids=id1,id2` usa otros IDs). Devuelve por fuente: `streamsCount`, `totalMs`, reparto por tipo (hls/mp4/external) y todas las opciones con `servidor`, `tipo`, `name` y `url` (la URL reproducible para HLS/MP4, el link al embed para 🌐). Streams crudos: sin caché ni filtro de señuelos.
- `/cache-clear?key=<clave KV completa>` — limpia una entrada de caché

## Ejecución local

1. Arranca el proxy local:
   ```
   deno run -A deno\fetch.ts
   ```
2. Apunta el Worker al proxy local — en `wrangler.toml`, cambia temporalmente:
   ```
   FETCH_PROXY_URL = "http://localhost:8000/fetch"
   ```
   (⚠️ recuerda restaurar el valor de producción `https://doramas-stremio.jbr1989.deno.net/fetch`
   antes de hacer push, o el addon desplegado perderá el relay).
3. Arranca el Worker en local:
   ```
   npx wrangler dev
   ```
