# Análisis Comparativo y Propuestas de Mejora para `doramas-stremio`

Este documento presenta una comparativa técnica exhaustiva entre el proyecto actual (**`doramas-stremio`**) y 6 addons destacados del ecosistema de Stremio:

1. **[streamvix](https://github.com/qwertyuiop8899/streamvix)** (qwertyuiop8899/streamvix)
2. **[tvvoo](https://github.com/qwertyuiop8899/tvvoo)** (qwertyuiop8899/tvvoo)
3. **[WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)** (newman2x/WebStreamrMBG)
4. **[yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)** (kunolabs/yukistreams-addon)
5. **[brazilcam4-nuvio](https://github.com/dudu-martins/brazilcam4-nuvio)** (dudu-martins/brazilcam4-nuvio)
6. **[animeflv-stremio-addon](https://github.com/Pigamer37/animeflv-stremio-addon)** (Pigamer37/animeflv-stremio-addon)

---

## 1. Resumen del Proyecto Actual (`doramas-stremio`)

- **Plataforma / Runtime**: Cloudflare Worker (`@cloudflare/workers-types`, TypeScript) + Proxy complementario en Deno Deploy (`deno/fetch.ts`).
- **Enfoque**: Catálogos y streams de doramas en español / subtitulados (`dlat:`, `dplay:`, `kplay:`, `dflix:`, `tudorama:`, `pandrama:`, `dyt:`, `dsub:`, `kisskh:`, `yandi:`).
- **Resolución de Streams**: Extractores para servidores comunes de doramas (StreamWish, SaveFiles/StreamHLS, MP4Upload, Hexload, PixelDrain, LuluStream) con fallback a `externalUrl`.
- **Fortalezas Actuales**:
  - Muy bajo costo y alta concurrencia gracias a la ejecución en el Edge (Cloudflare + Deno).
  - Buena modularidad de fuentes con `sourceBase.ts` y catálogos unificados (`alldoramas.ts`).
  - Detección inteligente de hosts protegidos por Cloudflare con fast-path y timeout corto.

---

## 2. Comparativa por Proyecto y Lecciones Aprendidas

### 2.1. `WebStreamrMBG` (newman2x/WebStreamrMBG)
> *Stremio add-on enfocado en extraer URLs HTTP directas y HLS de sitios de streaming.*

- **Página de Configuración Interactiva (`/configure`)**:
  - Implementa una interfaz web limpia donde los usuarios pueden seleccionar qué extractores activar/desactivar, qué resoluciones excluir (4k, 1080p, 720p, etc.), y habilitar o deshabilitar enlaces externos (`includeExternalUrls`).
  - La configuración elegida se codifica en la URL del manifest: `/{config}/manifest.json`.
- **Integración con MediaFlow Proxy (MFP)**:
  - Permite configurar una URL y contraseña de MediaFlow Proxy para resolver y reproducir servidores que exigen headers estrictos (`Referer`, `User-Agent`) sin que el servidor del addon tenga que actuar como ancho de banda intermedio para el video completo.
- **Extractor Registry con Cache de Dos Niveles y Deduplicación en Vuelo**:
  - Posee un `inFlight` Map (`Map<string, Promise<UrlResult[]>>`) que evita que 5 peticiones simultáneas al mismo embed realicen 5 descargas redundantes.
  - Arquitectura abstracta `Extractor` con tipado estricto, métodos de normalización de URLs, tests unitarios con fixtures HTML reproducibles (`__fixtures__`).
- **Gran Variedad de Extractores de Video**:
  - Soporta servidores que suelen encontrarse en sitios de doramas y anime: FileMoon, Streamtape, Dropload, SuperVideo, Uqload, Fastream, Voe, HubCloud.

---

### 2.2. `streamvix` (qwertyuiop8899/streamvix)
> *Addon multiplataforma con soporte para películas, series, anime y eventos deportivos.*

- **Mapeo Universal de IDs (Cinemeta / TMDB / Kitsu)**:
  - Mapeo bidireccional entre IDs de IMDb, TMDB y Kitsu mediante tablas y APIs de sincronización. Esto permite que el addon responda streams tanto si el usuario navega desde el catálogo nativo del addon como si entra a través del catálogo oficial de Cinemeta o Cyberflix.
- **Nombres y Formato Unificado de Streams (`buildUnifiedStreamName`)**:
  - Formatea los títulos de los streams de forma estándar: calidad, proveedor, servidor de video, idioma/subtítulo e icono distintivo (ej. ⚡ para enlaces rápidos o proxied).
- **Manejo de Dominios Dinámicos / Failover de Sitios**:
  - Archivo de configuración centralizado (`provider_urls.json` / `domains.json`) con flujos de actualización automática vía GitHub Actions cuando un sitio cambia de dominio (`.com` -> `.top` -> `.to`).

---

### 2.3. `animeflv-stremio-addon` (Pigamer37/animeflv-stremio-addon)
> *Addon de anime en Node.js que unifica múltiples webs españolas (AnimeFLV, AnimeAV1, Henaojara, TioAnime, JKAnime).*

- **Integración con APIs de Mappings Anime/Dramas (`api.ani.zip` y `relations.yuna.moe`)**:
  - Resuelve identificadores externos y cruza metadatos de episodios utilizando AniZip y Kitsu.
- **Estimación Inteligente de Fechas de Lanzamiento (`EstimateReleaseDate`)**:
  - Muchos sitios web de streaming solo proveen "Episodio 1, Episodio 2...", sin fechas de emisión reales. Este addon calcula y ancla las fechas de estreno basándose en la fecha de inicio de la serie, distribuyéndolos semanalmente. Así se evita el problema de que Stremio marque series finalizadas como si tuvieran un episodio nuevo cada día.
- **Estrategia Robusta de Control de Caché en Cliente (`clientCache.js`)**:
  - Diferenciación clara de cabeceras HTTP `Cache-Control`:
    - Metas: 10 minutos (para detectar nuevos episodios rápidamente sin esperar días).
    - Catálogos: 1 hora con `stale-while-revalidate`.
    - Streams: 3 horas (los enlaces directos o tokens expiran, no deben guardarse eternamente).
    - Fallos: 5 minutos (si falla un scraping, no deja al usuario bloqueado 24 horas).
- **Manejo de Rate-Limits y Retries Inteligentes**:
  - Cola por host con límite de concurrencia y respeto al header `Retry-After` (HTTP 429).

---

### 2.4. `kunolabs/yukistreams-addon`
> *Addon curado para anime y doramas asiáticos, optimizado para Stremio.*

- **Filtrado y Limpieza de Streams ("Made for signal, not clutter")**:
  - Reduce duplicados idénticos provenientes de distintas fuentes. Si una misma fuente o múltiples proveedores ofrecen el mismo servidor de video con idéntica calidad, se consolidan o se prioriza el más estable.
- **Perfiles de Reproducción según Dispositivo**:
  - Diferencia si el cliente es Stremio Web, Stremio Desktop o Stremio Android/TV para descartar o marcar como `notWebReady` streams que no funcionan en navegadores (ej. HLS sin CORS o MP4 con hotlink estricto).
- **Soporte de Cuentas Debrid (Real-Debrid, TorBox)**:
  - Permite a los usuarios ingresar su API Key para resolver hosts de video protegidos o lentos a través del CDN de Debrid.

---

### 2.5. `qwertyuiop8899/tvvoo`
> *Addon de canales de TV en vivo con gestión de proxies y mitigación de expiración de tokens.*

- **Soporte de Keep-Alive y Pool de Conexiones HTTP/HTTPS**:
  - Reutilización intensiva de sockets (`http.Agent` y `https.Agent` con `keepAlive: true`) para reducir la latencia de TLS en sitios lentos.
- **Proxying Directo con Reescritura de Headers**:
  - Envía cabeceras necesarias (`Referer`, `Origin`, `User-Agent`) en el streaming en vivo sin romper compatibilidad con reproductores ExoPlayer y Stremio Web.
- **Página de Landing Personalizada con Auto-Generación de Enlaces `stremio://`**:
  - Página HTML estática ligera con botones para abrir directamente en Stremio o copiar manifest.

---

### 2.6. `dudu-martins/brazilcam4-nuvio`
> *Addon ligero enfocado en streams con cabeceras especiales y proxying de miniaturas.*

- **Uso Estándar de `behaviorHints.proxyHeaders`**:
  - Stremio soporta nativamente pasar cabeceras HTTP al reproductor interno mediante:
    ```json
    "behaviorHints": {
      "notWebReady": true,
      "proxyHeaders": {
        "request": {
          "User-Agent": "...",
          "Referer": "https://..."
        }
      }
    }
    ```
  - Permite a Stremio Desktop y Android reproducir directamente streams con protección de `Referer` sin necesidad de consumir ancho de banda propio a través de un proxy intermedio.
- **Proxy Integrado de Imágenes para Hotlink Protection**:
  - Endpoint dedicado para re-servir pósters o miniaturas que tienen hotlink protection contra Stremio Web (como el problema documentado con `tudorama` en `doramas-stremio`).

---

## 3. Propuestas Detalladas de Mejoras para `doramas-stremio`

A continuación se detallan las mejoras técnicas recomendadas, organizadas por impacto y viabilidad:

### 🚀 Mejora 1: Añadir Interfaz de Configuración de Usuario (`/configure`)
*Inspirado en: WebStreamrMBG, animeflv-stremio-addon, yukistreams-addon*
- **Situación actual**: `doramas-stremio` ofrece un catálogo fijo con 10 fuentes que cargan por defecto para todos los usuarios.
- **Propuesta**:
  - Crear un endpoint `/configure` que sirva una página web responsiva y ligera.
  - Opciones configurables por el usuario:
    - **Selección de fuentes activas**: Elegir qué sitios incluir (`dflix`, `dlat`, `pandrama`, `kisskh`, etc.) para reducir tiempos de respuesta si solo le interesan ciertas fuentes.
    - **Exclusión de enlaces externos**: Opción para ocultar streams marcados como 🌐 `externalUrl` (que abren en navegador externo) si el usuario solo desea reproducción nativa.
    - **Orden de preferencia de servidores**: Priorizar StreamWish, MP4Upload o FileMoon según preferencia del usuario.
    - **Soporte opcional para MediaFlow Proxy o Debrid**: Configuración de URL y API key personal del usuario.
  - La URL del manifest resultante sería: `/:config/manifest.json`.

---

### 🛠️ Mejora 2: Uso de `behaviorHints.proxyHeaders` y `notWebReady` de Stremio
*Inspirado en: brazilcam4-nuvio, WebStreamrMBG*
- **Situación actual**: Para streams que requieren `Referer` específico, actualmente se depende de un proxy en Deno Deploy (`deno/fetch.ts`), consumiendo ancho de banda del proxy.
- **Propuesta**:
  - Para clientes que ejecutan Stremio Desktop o Android (que usan libvlc o ExoPlayer), Stremio acepta la propiedad `behaviorHints.proxyHeaders.request`:
    ```ts
    stream = {
      name: "Dorama Lat",
      title: "StreamWish (Directo)",
      url: streamUrl,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            "Referer": embedUrl,
            "User-Agent": BROWSER_UA
          }
        }
      }
    };
    ```
  - Mantener el proxy Deno como fallback automático únicamente para Stremio Web (navegadores) o cuando el reproductor del cliente no soporte cabeceras personalizadas. Esto reduce drásticamente el consumo y latencia en el servidor Deno.

---

### 🖼️ Mejora 3: Proxy de Imágenes Ligero para Resolver el Hotlink de `tudorama`
*Inspirado en: brazilcam4-nuvio*
- **Situación actual**: Como se documenta en el README, `tudorama` bloquea por Referer las solicitudes desde `app.stremio.com` (403), dejando pósters y miniaturas en blanco en Stremio Web.
- **Propuesta**:
  - Implementar una ruta en el Worker: `/img-proxy?url=...` o servir las miniaturas pasando por un relay de cabeceras seguro que envíe el Referer legítimo del sitio origen (`https://tudorama.com/`).
  - Aplicar cabeceras de caché agresivas (`Cache-Control: public, max-age=604800, immutable`) para que Cloudflare cachee las imágenes en el borde una sola vez.

---

### 🧩 Mejora 4: Ampliar Catálogo de Extractores de Video
*Inspirado en: WebStreamrMBG, animeflv-stremio-addon*
- **Situación actual**: `src/lib/extractors.ts` soporta StreamWish, savefiles, mp4upload, hexload, pixeldrain y lulustream. Muchos enlaces caen en `externalUrl`.
- **Propuesta**:
  - Agregar extractores directos para los servidores más comunes en sitios de doramas:
    1. **FileMoon**: Presente en DoramasYT, Doramasflix y varios servidores de K-dramas.
    2. **Streamtape / Vidguard / Voe**: Hosts recurrentes en sitios de streaming.
    3. **Doodstream**: Implementar la extracción del token md5 / URL final (siguiendo la lógica documentada en WebStreamrMBG y streamvix).

---

### ⚡ Mejora 5: Deduplicación de Peticiones en Vuelo y Cache HTTP por Capas
*Inspirado en: animeflv-stremio-addon, WebStreamrMBG*
- **Situación actual**: Si varios usuarios o peticiones simultáneas piden el mismo episodio, se procesan solicitudes concurrentes al sitio externo.
- **Propuesta**:
  - **In-flight dedup**: Un `Map<string, Promise<Stream[]>>` en memoria del Worker para peticiones idénticas concurrentes. Si entra una segunda petición mientras la primera está esperando la respuesta del sitio de doramas, ambas comparten la misma promesa.
  - **Afinar `Cache-Control`**:
    - Metas de series: 10 a 15 minutos (para que los nuevos episodios aparezcan rápido sin forzar re-instalación).
    - Streams: 2 a 3 horas con `stale-while-revalidate` (para absorber picos sin servir enlaces expirados).
    - Fallos o listas vacías: 2 a 5 minutos (evitar que un fallo temporal de un sitio deje una serie vacía durante 24h).

---

### 🏷️ Mejora 6: Estandarización de Etiquetas y Calidad en Streams
*Inspirado en: streamvix, yukistreams-addon*
- **Situación actual**: Cada fuente formatea el título del stream de manera ligeramente diferente.
- **Propuesta**:
  - Diseñar un formateador unificado de títulos:
    - Formato: `[Fuente] [Servidor] [Calidad] [Idioma/Sub]`
    - Ejemplo: `[DoramaFlix] StreamWish 1080p | Sub Español ⚡`
  - Facilitar la lectura al usuario en pantallas de TV (Android TV / Fire TV) donde el espacio horizontal del stream es reducido.

---

### 📅 Mejora 7: Estimación de Fechas de Emisión para Evitar Orden Falso en Stremio
*Inspirado en: animeflv-stremio-addon*
- **Situación actual**: Al scrapear sitios de doramas que no tienen fecha por episodio, Stremio puede desordenar o mostrar como "estrenados hoy" todos los episodios históricos.
- **Propuesta**:
  - Adoptar la función `EstimateReleaseDate` de `animeflv-stremio-addon`: usando la fecha de estreno del drama (obtenida de TMDB o de la ficha del drama), calcular una fecha tentativa espaciada semanalmente para cada episodio histórico. Esto estabiliza el orden en la interfaz de Stremio.

---

## 4. Matriz Comparativa de Capacidades

| Característica | `doramas-stremio` | `WebStreamrMBG` | `streamvix` | `animeflv` | `yukistreams` | `brazilcam4` |
|---|---|---|---|---|---|---|
| **Arquitectura** | Cloudflare + Deno | Node.js / Docker | Node.js / Docker | Node.js / Express | Servicio Cloud | Node.js / Express |
| **Configuración Web (`/configure`)** | ❌ (Estático) | ✅ Avanzado | ✅ Básico | ✅ Avanzado | ✅ Avanzado | ❌ |
| **MediaFlow Proxy** | ❌ (Usa Deno) | ✅ Nativo | ✅ Nativo | ❌ | ❌ (Debrid) | ❌ |
| **`behaviorHints.proxyHeaders`** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Nativo |
| **Variedad de Extractores** | 6 hosts | 20+ hosts | 12+ hosts | 10+ hosts | Alta | N/A (Webcam) |
| **Deduplicación en Vuelo** | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Resolución TMDB/Kitsu/IMDb** | Parcial (TMDB) | N/A | ✅ Universal | ✅ AniZip/Kitsu | ✅ Universal | N/A |
| **Proxy de Imágenes (CORS/Hotlink)** | ❌ (Pendiente) | ❌ | ❌ | ❌ | ✅ | ✅ Nativo |
| **Optimizado para Doramas** | 💯 Exclusivo | General | General / Anime | Solo Anime | Dorama + Anime | Adultos/TV |

---

## 5. Conclusión y Ruta de Implementación Sugerida

1. **Fase 1 (Inmediata / Alto impacto)**:
   - Implementar `behaviorHints.proxyHeaders` en los streams compatibles para descargar carga del proxy Deno.
   - Endpoint ligero `/img-proxy` en el Worker para solucionar el problema visual de `tudorama`.
2. **Fase 2 (Experiencia de Usuario)**:
   - Añadir la página `/configure` permitiendo al usuario activar/desactivar fuentes individuales y ocultar enlaces externos `externalUrl`.
   - Estandarizar la presentación de nombres de streams.
3. **Fase 3 (Extractores y Resiliencia)**:
   - Integrar extractores clave como FileMoon y Streamtape.
   - Agregar deduplicación de promesas en vuelo y política de `Cache-Control` calibrada.
