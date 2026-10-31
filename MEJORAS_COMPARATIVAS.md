# Comparativa Técnica y Propuestas de Mejora para `stremio-doramas`

Este documento presenta un análisis comparativo exhaustivo entre el proyecto actual (**stremio-doramas**) y seis repositorios de addons de Stremio de referencia:

1. **[qwertyuiop8899/streamvix](https://github.com/qwertyuiop8899/streamvix)**: Addon multi-fuente para películas, series, anime y TV en vivo.
2. **[qwertyuiop8899/tvvoo](https://github.com/qwertyuiop8899/tvvoo)**: Addon especializado en canales en vivo vía VAVOO con resolución de streams ligada a la IP del usuario.
3. **[newman2x/WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)**: Addon de extracción de sitios web con arquitectura modular avanzada, soporte de MediaFlow Proxy e interfaz de configuración.
4. **[kunolabs/yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)**: Addon de catálogo curado de anime y doramas asiáticos, perfiles de usuario, deduplicación y stream rows de alta legibilidad.
5. **[dudu-martins/brazilcam4-nuvio](https://github.com/dudu-martins/brazilcam4-nuvio)**: Addon enfocado en streams en vivo con ordenaciones dinámicas vía extras y proxying de imágenes para evasión de restricciones.
6. **[Pigamer37/animeflv-stremio-addon (AnimES)](https://github.com/Pigamer37/animeflv-stremio-addon)**: Addon de anime en español con mapeo cruzado de metadatos (AniZip, Yuna, Kitsu, AniList), matching difuso (fuzzysort) y página de configuración EJS.

---

## 1. Diagnóstico del Estado Actual de `stremio-doramas`

### Fortalezas de tu proyecto
- **Arquitectura Serverless Edge**: Implementado en Cloudflare Workers (`src/index.ts`) con proxy auxiliar en Deno Deploy (`deno/fetch.ts`), lo que permite latencias ultrabajas globalmente y costo de infraestructura prácticamente nulo.
- **Enfoque de Nicho Muy Sólido**: Especializado en doramas y contenido asiático con audio o subtítulos en español/latino (fuentes como DoramasLat, DoramedPlay, Doramasflix, TuDorama, Pandrama, DoramaSub, KissKH, YandiSpoiler).
- **Caché Inteligente KV**: Capa de caché bien diseñada con TTLs diferenciados (`TTL.catalog`, `TTL.meta`, `TTL.stream`, `TTL.streamwish`) y control de fallbacks en `src/lib/utils.ts`.
- **Manejo de Bypass TLS / Cloudflare**: Integración de Browser Rendering (`CF_API_TOKEN`) para sortear desafíos de Cloudflare en hosts como `do7go`, `playmogo` y `dsvplay`.
- **Mapeo IMDb**: Capacidad de buscar por ID `tt...` y mapear a títulos internos para soportar la reproducción desde el catálogo global de Stremio.

### Limitaciones Identificadas
1. **Falta de página de configuración para el usuario (`/configure`)**: El usuario no puede activar/desactivar fuentes individuales, elegir servidores preferidos, ni filtrar resoluciones.
2. **Problema sin resolver en imágenes de TuDorama**: Bloqueo de pósters y miniaturas en Stremio Web por validación de cabecera `Referer`.
3. **Extractores acoplados**: Varios extractores están hardcodeados dentro de `src/lib/extractors.ts` o dispersos en las fuentes individuales (`src/sources/`), sin un registro formal independiente de extractores (`ExtractorRegistry`).
4. **Falta de integración con MediaFlow Proxy**: Usuarios con bloqueos por IP o que utilicen clientes móviles/Android TV no tienen una vía estándar para delegar la reproducción de hosts problemáticos.
5. **Falta de soporte de servicios Debrid**: Solo ofrece enlaces HTTP/HLS directos, sin integración opcional con Real-Debrid o TorBox para descargas directas a máxima velocidad.
6. **Mapeo de títulos dependiente de coincidencias exactas o normalizaciones manuales**: Si una serie asiática cambia de título en español frente al inglés/romanizado (Hangul, Romaji, Pinyin), el cruce falla sin un algoritmo de búsqueda difusa (*fuzzy matching*).
7. **Ausencia de tests automatizados con fixtures offline**: No hay suite de pruebas Jest/Vitest con respuestas mockeadas para verificar que los extractores no se rompan tras cambios de upstream.

---

## 2. Matriz Comparativa Multidimensional

| Característica / Aspecto | Tu Proyecto (`stremio-doramas`) | WebStreamrMBG | StreamViX | AnimES (AnimeFLV) | YukiStreams | BrazilCam4 | TvVoo |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Entorno de Ejecución** | Cloudflare Worker + Deno | Node.js / Docker | Node.js / Python | Node.js / Express | Servicio alojado (Edge) | Node.js / Render | Node.js / Docker |
| **Página de Configuración (`/configure`)** | ❌ No disponible | ✅ Avanzada (HTML/JS) | ✅ Sí | ✅ Sí (EJS) | ✅ Muy avanzada | ❌ No | ✅ Landing simple |
| **Arquitectura de Extractores** | Funciones utilitarias | `ExtractorRegistry` desacoplado + in-flight dedup | Proveedores y extractores modulares | Funciones en `lib/streamParsing.js` | Modular cerrado | N/A (API directa) | N/A (Vavoo resolver) |
| **Soporte MediaFlow Proxy** | ❌ No | ✅ Nativo y configurable | ✅ Nativo con wrap directo | ❌ No | ✅ Soportado | ❌ No | ✅ Empaquetado |
| **Resolución de Bloqueos de Imágenes** | ⚠️ Documentado como pendiente | N/A | N/A | Vía CDNs | Proxied artwork | ✅ Proxy `/imagem/:id.jpg` | N/A |
| **Mapeo Cruzado de IDs** | IMDb (`tt`) → TMDB / Slugmap | Cinemeta / TMDB / IMDb | TMDB / IMDb / Kitsu | AniZip / Yuna / Kitsu / AniList | Multi-ID propio | Prefijo propio | M3U / EPG |
| **Algoritmo de Búsqueda** | Normalización de cadenas | Normalización + TMDB ID | Mapping JSON estático | `fuzzysort` (Score difuso) | Búsqueda resiliente multi-idioma | Búsqueda por substring | Coincidencia de canales |
| **Presentación de Streams** | Servidor + Calidad básica | Formato limpio con banderas y resoluciones | Nombres unificados con badges y origen | Nombres de servidores limpios (`getServerTitle`) | Filas ultra limpias y legibles | Nombre y espectadores | Nombre de canal y país |
| **Manejo de IP de Usuario (IP-bound)** | Proxy Deno con IP fija | Proxy headers / MediaFlow | MediaFlow / IP forwarding | N/A | Modos Direct / Proxy | N/A | `ipLocation` (header `x-client-ip`) |
| **Pruebas y Fixtures** | Typecheck (`tsc --noEmit`) | Jest con 60+ fixtures HTML | Script `check_domains.js` | Manual | Pruebas cerradas | Manual | Manual |

---

## 3. Análisis Detallado por Proyecto de Referencia

### 3.1. WebStreamrMBG
**Qué hace:**
- Implementa una clase `ExtractorRegistry` centralizada donde cada host de video (SaveFiles, Voe, FileLions, LuluStream, DoodStream, SuperVideo, etc.) es una clase independiente que implementa una interfaz `Extractor`.
- Incluye **in-flight request deduplication**: Si diez usuarios o hilos piden el mismo episodio simultáneamente, solo se hace una petición HTTP de scraping al sitio upstream y se comparte la promesa con los demás.
- Soporta **MediaFlow Proxy** integrado de manera transparente (`supportsMediaFlowProxy`), permitiendo que usuarios detrás de IPs bloqueadas o con problemas de SSL deleguen la descarga del stream a su propia instancia de MediaFlow.
- Detección precisa de resolución de video (1080p, 720p, 480p) mediante análisis de cabeceras HLS (`#EXT-X-STREAM-INF`) o patrones de URL.
- Extensa suite de pruebas con snapshots y fixtures HTML mockeados para cada extractor, permitiendo verificar si la lógica de extracción sigue funcionando sin tocar internet.

### 3.2. StreamViX
**Qué hace:**
- Implementa un formateador visual unificado de streams (`buildUnifiedStreamName`, `mapLegacyProviderName`): muestra títulos atractivos y limpios con etiquetas informativas (ej: `[ESP] [HD] StreamWish`, `[LAT] DoodStream`).
- Cuenta con scripts de mantenimiento automatizado (`scripts/check_domains.js`) que validan la salud y los redireccionamientos de los dominios y espejos periódicamente.
- Soporte dual de resolución: resolución directa en TypeScript y fallback por scripts especializados en caso de empaquetados pesados.

### 3.3. AnimES (animeflv-stremio-addon)
**Qué hace:**
- Mapeo inteligente con **AniZip** y **relations.yuna.moe**: Convierte IDs de anime/drama entre múltiples plataformas (Kitsu, AniList, MyAnimeList, IMDb) en una sola llamada compartida (`GetAniZipMappings`).
- Usa **`fuzzysort`** para comparar los títulos originales, alternativos y traducidos con las respuestas del buscador del sitio web. Esto reduce drásticamente los episodios "no encontrados" cuando el sitio utiliza un título ligeramente diferente (ej: omisión de puntuación, año o traducción libre).
- Sanitizador de nombres de servidores (`getServerTitle`): Limpia URLs de espejos desconocidos como `dhcplay`, `movearnpre`, `bysesukior` transformándolos automáticamente en nombres reconocibles por el usuario (`Streamwish`, `Vidhide`, `Filemoon`).
- Página web interactiva (`views/config.ejs`) servida con Express y motor de plantillas para que los usuarios elijan qué sitios activar y en qué orden.

### 3.4. YukiStreams (yukistreams-addon)
**Qué hace:**
- **Filas de streams limpias (Signal over clutter)**: Elimina el ruido visual repetitivo en la lista de enlaces de Stremio. Solo muestra lo imprescindible: Fuente, Calidad, Idioma y Tipo de stream.
- **Catálogo combinado por región/variedad**: En lugar de exponer un catálogo por cada sitio web (lo que satura la pantalla inicial de Stremio), agrupa el contenido por nichos: *K-Drama*, *C-Drama*, *J-Drama*, *Tendencias* y *Últimos agregados*, unificando las series encontradas entre todas las fuentes.
- **Perfiles de usuario configurables**: El usuario puede elegir perfiles predefinidos (solo Latino, solo Subtitulado, todos, etc.).

### 3.5. BrazilCam4 (brazilcam4-nuvio)
**Qué hace:**
- **Proxy local de imágenes (`/imagem/:id.jpg`)**: Resuelve elegantemente el problema del hotlinking. El addon expone una ruta HTTP que descarga la imagen upstream con el `User-Agent` y `Referer` adecuados y la sirve al cliente de Stremio con cabeceras `Cache-Control` y CORS abiertas.
- **Uso de extras de Stremio para ordenación**: Permite al usuario ordenar el catálogo mediante el selector `genre` ("Em destaque", "Mais Espectadores", "Menos Espectadores").

### 3.6. TvVoo
**Qué hace:**
- **Manejo de IP de cliente (`ipLocation`)**: Para streams con tokens HLS enlazados a la IP de quien hace la solicitud, utiliza las cabeceras HTTP entrantes (`x-forwarded-for` o `cf-connecting-ip`) para resolver el stream a nombre del cliente final, evitando que el stream quede bloqueado a la IP del servidor.

---

## 4. Detalle de Mejoras Recomendadas para `stremio-doramas`

A continuación se detallan las mejoras técnicas recomendadas para implementar en el proyecto, organizadas por área de impacto:

---

### MEJORA 1: Proxy de Imágenes para Solucionar el Hotlink Protection de TuDorama
- **Problema actual**: En `README.md` se documenta que en Stremio Web los capítulos de `tudorama:` aparecen sin miniaturas y los pósters fallan con error HTTP 403 debido a la verificación de cabecera `Referer: https://app.stremio.com/`.
- **Inspiración**: Mecanismo implementado en **`brazilcam4-nuvio`**.
- **Solución detallada**:
  1. Agregar un endpoint en `src/routes/proxy.ts` (o `src/index.ts`): `/image-proxy?url=<encoded_url>&referer=<encoded_referer>`.
  2. Al procesar la solicitud, verificar que la URL pertenezca a dominios permitidos (como `tudorama.com`) para evitar SSRF (utilizando la función `safeProxyUrl` existente en `src/utils.ts`).
  3. Realizar la petición hacia el servidor upstream inyectando la cabecera `Referer: https://tudorama.com/` y devolver la imagen con cabeceras `Content-Type: image/jpeg` (o `image/webp`) y `Cache-Control: public, max-age=86400, s-maxage=604800`.
  4. En `src/sources/tudorama.ts`, transformar las URLs de pósters y miniaturas de episodios para que apunten a este endpoint relativo:
     ```typescript
     // Ejemplo conceptual:
     function proxiedImageUrl(rawUrl: string, origin: string): string {
       if (!rawUrl.includes("tudorama.com")) return rawUrl;
       return `${origin}/image-proxy?url=${encodeURIComponent(rawUrl)}`;
     }
     ```
- **Beneficio**: Corrige de inmediato el único problema funcional documentado y pendiente del proyecto, permitiendo que el 100% de las miniaturas se visualicen en Stremio Web y plataformas de navegador.

---

### MEJORA 2: Implementación de una Página de Configuración de Usuario (`/configure`)
- **Problema actual**: El addon tiene un `manifest.json` rígido con todas las fuentes activas de manera fija. Los usuarios no pueden ocultar catálogos que no les interesen (por ejemplo, alguien que solo quiere doblaje latino o alguien que solo quiere subtítulos), ni configurar servidores preferidos.
- **Inspiración**: **`WebStreamrMBG`** y **`animeflv-stremio-addon`**.
- **Solución detallada**:
  1. Diseñar una página HTML/CSS ligera alojada en `/configure` (utilizando Tailwind CDN o CSS puro embebido como plantilla literal de TS).
  2. Opciones a configurar por el usuario:
     - **Catálogos visibles**: Checkboxes para habilitar/deshabilitar fuentes (`dlat`, `dplay`, `kplay`, `dflix`, `tudorama`, `pandrama`, `dsub`, `dyt`, `kisskh`, `alldoramas`).
     - **Preferencia de audio**: "Solo Latino", "Solo Subtitulado", "Ambos".
     - **Filtro de servidores**: Ocultar servidores lentos o caídos (ej. ignorar Mp4Upload o Hexload).
     - **Integración opcional de MediaFlow Proxy**: Campos para `MediaFlow URL` y `API Password`.
  3. Codificar las opciones seleccionadas en un string Base64 o JSON comprimido que forme parte de la URL del manifest:
     `https://<tu-worker>.workers.dev/[CONFIG_ENCODED]/manifest.json`.
  4. En `src/index.ts`, parsear el segmento de ruta opcional `/:config/manifest.json`, `/:config/catalog/...`, etc., y adaptar el filtrado de catálogos y streams dinámicamente según la configuración de ese usuario.
- **Beneficio**: Experiencia de usuario profesional idéntica a addons de primer nivel (Torrentio, WebStreamr), menor carga innecesaria en el Worker (usuarios apagando fuentes que no consumen) y flexibilidad total.

---

### MEJORA 3: Soporte Nativo de MediaFlow Proxy
- **Problema actual**: Ciertos servidores de video (o ISPs locales) bloquean conexiones directas o limitan el bitrate de las conexiones HLS a los reproductores de Stremio en Android y Smart TVs.
- **Inspiración**: **`WebStreamrMBG`** y **`streamvix`**.
- **Solución detallada**:
  1. Si el usuario suministra credenciales de MediaFlow Proxy en la configuración, los streams de servidores IP-bound o con desafíos Cloudflare (`streamwish`, `lulustream`, `savefiles`) se pueden generar automáticamente envueltos en la API de MediaFlow:
     ```typescript
     // Ejemplo conceptual de envoltura:
     export function wrapMediaFlow(
       streamUrl: string,
       headers: Record<string, string>,
       mfpUrl: string,
       mfpPassword?: string
     ): string {
       const u = new URL("/proxy/hls", mfpUrl);
       u.searchParams.set("d", streamUrl);
       if (mfpPassword) u.searchParams.set("api_password", mfpPassword);
       for (const [k, v] of Object.entries(headers)) {
         u.searchParams.set(`h_${k.toLowerCase()}`, v);
       }
       return u.toString();
     }
     ```
  2. Se puede implementar como fallback transparente: si el proxy de Deno está saturado o da error, el addon recurre al MediaFlow Proxy del usuario si fue configurado.
- **Beneficio**: Desbloquea la reproducción en televisores y dispositivos Android que fallan al reproducir HLS con cabeceras personalizadas (`Referer`/`Origin`).

---

### MEJORA 4: Normalización y Coincidencia Difusa (*Fuzzy Matching*) en la Búsqueda
- **Problema actual**: Al buscar un drama mediante su ID IMDb (`tt...`) o por texto libre, muchas fuentes asiáticas titulan la serie de forma distinta (ejemplo: *"Boys Over Flowers"* vs *"Hana Yori Dango"* vs *"Los chicos son mejores que las flores"*). Si no existe una regla exacta en `src/lib/slugmap.ts`, la búsqueda falla y no devuelve streams.
- **Inspiración**: Algoritmo `fuzzysort` de **`animeflv-stremio-addon`** y el sistema de alias de **`yukistreams-addon`**.
- **Solución detallada**:
  1. Incorporar una utilidad ligera de distancia de Levenshtein o coincidencia difusa (ej. un algoritmo tipo Dice Coefficient o Levenshtein adaptado a TypeScript sin dependencias pesadas para Cloudflare Workers).
  2. Al resolver un ID IMDb (`getMetaFromImdb` / `searchVariants`):
     - Obtener no solo el título principal en TMDB, sino también el array `alternative_titles` (disponible en la API de TMDB: `/tv/{id}/alternative_titles`).
     - Al iterar los resultados de búsqueda de `doramasflix`, `doramaslat`, etc., calcular el puntaje de similitud entre el título buscado y los resultados obtenidos.
     - Aceptar coincidencias con puntaje superior a un umbral (ej. > 0.85) en lugar de requerir igualdad estricta de slug.
- **Beneficio**: Incremento sustancial en la tasa de éxito al reproducir doramas desde el catálogo oficial de Stremio (Cinemeta / TMDB).

---

### MEJORA 5: Estandarización y Desacoplamiento de Extractores (`ExtractorRegistry`)
- **Problema actual**: En la actualidad, la lógica de extracción de video está parcialmente en `src/lib/extractors.ts` y parcialmente en las fuentes específicas (`kdramasplay.ts`, `doramas.ts`, etc.). Si un host cambia de dominio o añade un nuevo espejo (como ocurrió recientemente con `do7go` y `playmogo`), hay que modificar múltiples archivos y sincronizar con Deno Deploy.
- **Inspiración**: Arquitectura de **`WebStreamrMBG`** (`src/extractor/`).
- **Solución detallada**:
  1. Definir una interfaz estándar `VideoExtractor`:
     ```typescript
     export interface VideoExtractor {
       name: string;
       canHandle(url: string): boolean;
       extract(url: string, env: Env): Promise<StreamResult[]>;
     }
     ```
  2. Crear una clase `ExtractorRegistry` que mantenga los extractores registrados y una caché de deduplicación en vuelo (*in-flight promises*):
     - `StreamWishExtractor` (maneja `streamwish`, `wishfast`, `do7go`, `playmogo`, `streamaly`, etc.)
     - `SaveFilesExtractor` (maneja `savefiles.com`, `streamhls.to`)
     - `LuluStreamExtractor`
     - `Mp4UploadExtractor`
     - `HexLoadExtractor`
     - `DoodExtractor`
     - `FileMoonExtractor` (para fuentes futuras como DoramasYT)
  3. Desacoplar la detección: cada fuente solo extrae la URL del iframe/embed y se la pasa a `registry.extract(embedUrl)`.
- **Beneficio**: Si un nuevo host aparece o cambia de algoritmo, se modifica un único archivo en `src/extractors/` sin alterar el código de ninguna fuente de doramas.

---

### MEJORA 6: Sanitización y Limpieza Visual de Streams (UI "Signal over Clutter")
- **Problema actual**: Dependiendo de la fuente, los títulos de los streams pueden mostrar nombres de servidores técnicos o poco amigables para el usuario final (ej. `streamaly`, `swishsrv`, `embedwish`, URLs crudas).
- **Inspiración**: Función `getServerTitle` de **`animeflv-stremio-addon`**, `buildUnifiedStreamName` de **`streamvix`** y filosofía de diseño de **`yukistreams-addon`**.
- **Solución detallada**:
  1. Crear un formateador de visualización unificado:
     - **Línea 1 (`name`)**: `[DoramaWeb] [Audio]` (ej: `[DoramasWeb] 🇪🇸 LATINO` o `[DoramasWeb] 🇯🇵 SUB`).
     - **Línea 2 (`title`)**: `Servidor • Calidad • Fuente` (ej: `StreamWish • 1080p • Doramasflix`).
  2. Mapear dominios de espejos a nombres limpios reconocibles:
     - `wishfast.top`, `playmogo.com`, `streamaly.com` → `StreamWish`
     - `luluvdo.com`, `lulustream.com` → `LuluStream`
     - `streamhls.to`, `savefiles.com` → `SaveFiles`
     - `bysesukior`, `filemoon.sx` → `Filemoon`
  3. Ordenar los streams resultantes poniendo primero las calidades más altas (1080p > 720p > SD) y agrupando por idioma según la preferencia del usuario.
- **Beneficio**: Experiencia visual limpia, profesional y fácil de entender en televisores y dispositivos móviles.

---

### MEJORA 7: Monitoreo Automatizado de Salud de Sitios y Dominios
- **Problema actual**: Los sitios de doramas cambian frecuentemente de dominio o de infraestructura anti-bot. Actualmente, las fallas se descubren de forma reactiva cuando un usuario reporta streams caídos o mediante llamadas manuales a `/debug-all`.
- **Inspiración**: Script `check_domains.js` de **`streamvix`** y pruebas con fixtures de **`WebStreamrMBG`**.
- **Solución detallada**:
  1. Crear un script en `scripts/check_sources.ts` que se pueda ejecutar manualmente (`npm run check`) o mediante una GitHub Action programada (cron cada 24-48 horas).
  2. El script debe:
     - Realizar un `HEAD` o `GET` ligero a los dominios base de cada fuente (`doramaslat`, `doramasflix`, `tudorama`, etc.).
     - Detectar redireccionamientos (código 301/302 a nuevos dominios TLD).
     - Verificar la presencia de retos de Cloudflare (código 403 o cabecera `cf-mitigated`).
     - Alertar en caso de que un dominio haya sido suspendido o bloqueado.
  3. Crear un conjunto de tests unitarios básicos en TypeScript con datos guardados (fixtures) para comprobar que las expresiones regulares y los parsers HTML siguen funcionando cuando el HTML de entrada cambia.
- **Beneficio**: Mantenimiento preventivo; permite corregir dominios en el Worker y en Deno Deploy antes de que los usuarios experimenten cortes en el servicio.

---

## 5. Hoja de Ruta Sugerida de Implementación (Priorizada)

| Prioridad | Tarea | Esfuerzo | Impacto |
| :---: | :--- | :---: | :---: |
| **P1** | **Proxy de imágenes para TuDorama**: Implementar `/image-proxy` para resolver el error 403 en Stremio Web. | Bajo | Inmediato (resuelve issue abierto) |
| **P2** | **Sanitizador y formateador de streams**: Normalizar nombres de servidores y badges (Audio / Calidad / Host). | Bajo | Alto (mejora visual directa) |
| **P3** | **Página de configuración (`/configure`)**: Permitir elegir catálogos, filtros de audio y opciones de proxy. | Medio | Muy alto (experiencia de usuario) |
| **P4** | **Arquitectura `ExtractorRegistry`**: Modularizar los extractores de video desacoplándolos de las fuentes. | Medio | Alto (mantenibilidad del código) |
| **P5** | **Búsqueda difusa (Fuzzy Matching)**: Mejorar la resolución IMDb mediante títulos alternativos de TMDB. | Medio | Alto (más streams encontrados) |
| **P6** | **Integración MediaFlow Proxy**: Permitir la configuración opcional de MFP para reproducción remota. | Bajo | Medio (beneficia a usuarios móviles/TV) |
| **P7** | **Script de comprobación de salud (`check_sources.ts`)**: Automatizar la verificación de dominios en GitHub Actions. | Bajo | Medio (mantenimiento preventivo) |

---
*Documento generado como análisis comparativo y propuesta de mejoras técnicas para el proyecto `stremio-doramas`.*
