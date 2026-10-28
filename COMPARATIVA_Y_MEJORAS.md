# Comparativa del Proyecto `stremio-doramas` con Proyectos de Referencia de la Comunidad y Propuestas de Mejora

Este documento presenta una comparativa técnica detallada entre el proyecto **`stremio-doramas`** y seis proyectos destacados de la comunidad de addons para Stremio, analizando sus arquitecturas, capacidades, estrategias de resolución y experiencia de usuario para proponer mejoras aplicables a nuestro addon.

---

## 📋 Tabla de Contenidos

1. [Resumen del Proyecto Actual (`stremio-doramas`)](#1-resumen-del-proyecto-actual-stremio-doramas)
2. [Análisis Detallado de Proyectos de Referencia](#2-análisis-detallado-de-proyectos-de-referencia)
   - [qwertyuiop8899 / streamvix](#-qwertyuiop8899--streamvix)
   - [qwertyuiop8899 / tvvoo](#-qwertyuiop8899--tvvoo)
   - [newman2x / WebStreamrMBG](#-newman2x--webstreamrmbg)
   - [kunolabs / yukistreams-addon](#-kunolabs--yukistreams-addon)
   - [dudu-martins / brazilcam4-nuvio](#-dudu-martins--brazilcam4-nuvio)
   - [Pigamer37 / animeflv-stremio-addon](#-pigamer37--animeflv-stremio-addon)
3. [Cuadro Comparativo de Características](#3-cuadro-comparativo-de-características)
4. [Propuestas Concretas de Mejora para `stremio-doramas`](#4-propuestas-concretas-de-mejora-para-stremio-doramas)
   - [Área 1: Interfaz de Configuración Dinámica y Personalización (`/configure`)](#área-1-interfaz-de-configuración-dinámica-y-personalización-configure)
   - [Área 2: Búsqueda, Coincidencia Difusa (*Fuzzy Matching*) y Mapeo Avanzado de IDs](#área-2-búsqueda-coincidencia-difusa-fuzzy-matching-y-mapeo-avanzado-de-ids)
   - [Área 3: Presentación, Limpieza y Ordenamiento de Resultados (*Stream Rows*)](#área-3-presentación-limpieza-y-ordenamiento-de-resultados-stream-rows)
   - [Área 4: Monitoreo Automático de Dominios, Espejos y Resiliencia](#área-4-monitoreo-automático-de-dominios-espejos-y-resiliencia)
   - [Área 5: Optimización de Encabezados de Caché HTTP para Stremio](#área-5-optimización-de-encabezados-de-caché-http-para-stremio)
   - [Área 6: Arquitectura Modular de Pruebas Automatizadas con Fixtures](#área-6-arquitectura-modular-de-pruebas-automatizadas-con-fixtures)
   - [Área 7: Canales de Transmisión Continua 24/7 (Doramas en Vivo)](#área-7-canales-de-transmisión-continua-247-doramas-en-vivo)

---

## 1. Resumen del Proyecto Actual (`stremio-doramas`)

`stremio-doramas` es un addon híbrido para Stremio ejecutado sobre **Cloudflare Workers** como backend principal y un proxy auxiliar en **Deno Deploy**.
- **Fuentes Soportadas**: Integración directa con 7+ fuentes de doramas hispanas e internacionales (`dlat`, `dplay`, `kplay`, `dflix`, `tudorama`, `pandrama`, `dsub`, `kisskh`, `yandispoiler`, `doramasyt`).
- **Arquitectura de Red**: Resuelve bloqueos de IP de Cloudflare Workers delegando peticiones HTML y retransmisiones HLS ip-bound (StreamWish, SaveFiles, FileLions) al proxy de Deno Deploy.
- **Puntos Fuertes**: Excelente rendimiento sin costo de infraestructura, manejo de desafíos Cloudflare vía Browser Rendering opcional y sistema de comprobación rápida (`/debug-all`).

---

## 2. Análisis Detallado de Proyectos de Referencia

### 🎬 `qwertyuiop8899 / streamvix`
- **Descripción**: Addon multiproveedor (películas, series, anime, eventos deportivos en vivo y TV).
- **Aspectos Destacados**:
  - **Script de Verificación de Dominios (`scripts/check_domains.js`)**: Comprueba automáticamente si los dominios de los proveedores están vivos o han cambiado de IP/bloqueo DNS.
  - **Página `/configure` Completa**: Permite activar o desactivar proveedores de contenido individualmente y configurar proxies o integración con MediaFlow Proxy.
  - **Normalización de Títulos (`scripts/auto_normalize.py`)**: Utiliza mapeos JSON para normalizar nombres de episodios y series entre la consulta de Stremio y el buscador interno de las páginas.
  - **Soporte de Múltiples Motores**: Integra manejadores en Python (vavoo, eurostreaming) y TypeScript.

### 📺 `qwertyuiop8899 / tvvoo`
- **Descripción**: Addon especializado en canales de televisión en vivo por países y categorías.
- **Aspectos Destacados**:
  - **Gestión de Listas Dinámicas y M3U**: Separa la lista de canales estáticos (`lists.json`) de los streams dinámicos M3U.
  - **Servicio de Guía de Programación (EPG)**: Mapea nombres de canales a guías de televisión (`service.ts`).
  - **Procesamiento Previo (`prebuild.js`)**: Genera mapas de cobertura y logotipos de canales antes del despliegue para minimizar latencia en tiempo de ejecución.

### 🌐 `newman2x / WebStreamrMBG`
- **Descripción**: Addon modular enfocado en la extracción HTTP multi-fuente de alta calidad.
- **Aspectos Destacados**:
  - **Arquitectura Basada en Clases Abstraídas**: Define interfaces stricts para `Source` y `Extractor` con control de TTL, cache versioning, y soporte lazy-extract.
  - **Coincidencia Difusa (*Fuzzy Matching*)**: Utiliza bibliotecas como `fuse.js` y `fast-levenshtein` para comparar el título devuelto por TMDB con el título encontrado en el sitio web objetivo, reduciendo falsos positivos.
  - **Exhaustiva Suite de Pruebas con Fixtures (`jest`)**: Guarda capturas de respuestas HTTP de servidores reales (`__fixtures__`) para probar los extractores (Streamtape, Doodstream, Savefiles, Voe, etc.) sin hacer peticiones de red reales en CI/CD.
  - **Clasificación Estricta de Errores**: Define excepciones específicas (`TimeoutError`, `HttpError`, `BlockedError`, `TooManyRequestsError`) para reaccionar de forma inteligente (retries o fallback sin tumbar el servicio).

### ❄️ `kunolabs / yukistreams-addon`
- **Descripción**: Gateway concentrador para anime, doramas asiáticos, películas y series.
- **Aspectos Destacados**:
  - **Filosofía "Signal over Clutter"**: Enfocado en mostrar respuestas limpias y ordenadas sin filas duplicadas ni basura visual en los títulos de los enlaces.
  - **Página de Configuración Completa**: Los usuarios seleccionan perfiles de reproducción (Debrid, P2P, Proxy directo), resoluciones máximas (4K, 1080p, 720p) e idiomas preferidos.
  - **Formateo Estandarizado de Resultados**: Añade insignias claras en las etiquetas del stream (Servidor | Calidad | Subtítulo | Latencia).

### 🔞 `dudu-martins / brazilcam4-nuvio`
- **Descripción**: Addon ligero enfocado en transmisiones HLS dinámicas ordenadas en tiempo real.
- **Aspectos Destacados**:
  - **Manejo Directo de HLS**: Sin intermediarios innecesarios cuando el origen permite reproducción directa cliente-servidor.
  - **Cero Configuración**: Instalación de un solo clic orientada a máxima simplicidad de uso.

### 🌸 `Pigamer37 / animeflv-stremio-addon`
- **Descripción**: Addon para contenido de anime hispano (AnimeAV1, TioAnime, Latanime, Henaojara).
- **Aspectos Destacados**:
  - **Mapeo Multi-API de IDs (`routes/relations.js`)**: Soluciona la disparidad entre nombres en inglés/japonés/español consultando en paralelo `ani.zip`, `yuna.moe`, `AniList` y `Kitsu`. Esto permite obtener el título en Romaji exacto para buscar en sitios de anime/doramas.
  - **Estrategia Inteligente de Caché HTTP (`clientCache.js`)**: Emplea encabezados de caché afinados (`max-age`, `stale-while-revalidate` y `stale-if-error`). Permite que Stremio muestre episodios instantáneamente desde caché mientras revalida en segundo plano.
  - **Integración con Calendario y Biblioteca**: Los identificadores permiten integrar estrenos futuros en la pestaña "Calendario" de Stremio.

---

## 3. Cuadro Comparativo de Características

| Característica / Capacidad | `stremio-doramas` | `streamvix` | `tvvoo` | `WebStreamrMBG` | `yukistreams` | `animeflv` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Infraestructura Serverless** | ✅ (Cloudflare + Deno) | ❌ (Node/Express) | ❌ (Node/Express) | ❌ (Node/Express) | ❓ (Closed-source) | ❌ (Express/Vercel) |
| **Página de Configuración (`/configure`)** | ❌ (Solo manifest directo) | ✅ | ✅ | ✅ | ✅ | ✅ (HTML/EJS) |
| **Fuzzy Title Matching (Levenshtein/Fuse)** | ⚠️ (Básico/Regex) | ⚠️ (JSON maps) | N/A | ✅ (`fuse.js` / `levenshtein`) | ✅ | ⚠️ (Búsqueda por Romaji) |
| **Mapeo Multi-API de IDs (ani.zip/Kitsu/Yuna)** | ❌ | ❌ | N/A | ❌ | ✅ | ✅ (`relations.js`) |
| **Deduplicado y Limpieza de Streams** | ⚠️ (Parcial) | ⚠️ | N/A | ✅ | ✅ (Avanzado) | ⚠️ |
| **Pruebas Automatizadas con Fixtures** | ❌ (Solo `/debug-all`) | ❌ | ❌ | ✅ (`jest` + snapshots) | ❓ | ❌ |
| **Verificación Automática de Dominios** | ❌ | ✅ (`check_domains.js`) | ❌ | ❌ | ❓ | ❌ |
| **Estrategia HTTP `stale-while-revalidate`** | ⚠️ (Básico KV) | ❌ | ❌ | ❌ | ✅ | ✅ (`clientCache.js`) |

---

## 4. Propuestas Concretas de Mejora para `stremio-doramas`

Basándonos en las fortalezas descubiertas en los seis proyectos analizados, se detallan las siguientes modificaciones y adiciones recomendadas para nuestro proyecto:

---

### Área 1: Interfaz de Configuración Dinámica y Personalización (`/configure`)
> *Inspirado en `streamvix`, `yukistreams-addon` y `animeflv-stremio-addon`*

Actualmente `stremio-doramas` expone un manifest fijo en `/manifest.json`. Añadir una página `/configure` le dará control total al usuario sin recargar el servidor:

1. **Selección de Fuentes Activas**:
   - Permitir al usuario desmarcar sitios que sean lentos o no de su interés (ej. desactivar `kisskh` o `doramasyt` si prefiere solo contenido 100% en español latino).
2. **Priorización y Filtro de Servidores**:
   - Opción para ordenar o filtrar servidores de video (ej. preferir **StreamWish** / **Pixeldrain** sobre enlaces de respaldo externos `🌐`).
3. **Preferencias de Idioma y Subtítulos**:
   - Filtrar únicamente contenidos con Audio Latino, Castellano o Subtitulado según la preferencia seleccionada en el formulario.
4. **Generación de Manifest Codificado**:
   - La página `/configure` generará una URL de manifest personalizada (`/<config_base64>/manifest.json`) que lee las opciones de forma transparente en Cloudflare Workers.

---

### Área 2: Búsqueda, Coincidencia Difusa (*Fuzzy Matching*) y Mapeo Avanzado de IDs
> *Inspirado en `WebStreamrMBG` y `animeflv-stremio-addon`*

Muchos doramas fallan en la búsqueda porque el nombre en TMDB o IMDb difiere ligeramente del título publicado en sitios de doramas (ej. *"Goblin"* vs *"Goblin: The Lonely and Great God"* o nombres con títulos en coreano/romanizado).

1. **Integración de Coincidencia Difusa (`fuse.js` o `fast-levenshtein`)**:
   - Al buscar un dorama en la fuente web, calcular la distancia Levenshtein entre el título esperado y los resultados del scraping.
   - Descartar coincidencias con un umbral de similitud inferior al 75%, evitando enviar capítulos de series incorrectas.
2. **Mapeo Avanzado de Títulos Alternativos vía `ani.zip` / `yuna.moe`**:
   - Para doramas de origen asiático, consultar la API de `ani.zip` o `yuna.moe` cuando el ID de la consulta proviene de Kitsu/IMDb.
   - Esto permite obtener tanto el **título en Romaji** como el **título en Inglés** y **Español** para intentar búsquedas múltiples de respaldo (*fallback*).

---

### Área 3: Presentación, Limpieza y Ordenamiento de Resultados (*Stream Rows*)
> *Inspirado en `yukistreams-addon` y `WebStreamrMBG`*

Actualmente, las respuestas de stream de `stremio-doramas` muestran nombres derivados del host o fuente. Se pueden hacer más legibles y profesionales:

1. **Deduplicado de Enlaces Idénticos**:
   - Si dos fuentes (ej. `dlat` y `dplay`) extraen la misma URL de StreamWish o FileLions, consolidar el resultado en una sola fila indicando los orígenes `[DoradoLat / DoraPlay]`.
2. **Estandarización de Títulos y Badges**:
   - Formato sugerido para el campo `name` y `description` de Stremio:
     - `name`: `[Dorama] StreamWish 1080p`
     - `title`: `⚡ Servidor Rápido | 🔊 Español Latino | 🟢 Online`
3. **Indicador Visual de Reproducción Directa vs Externa**:
   - Clasificar claramente los enlaces que reproducen de forma nativa dentro de Stremio (HLS / MP4) en contraste con los enlaces que requieren navegador (`🌐 Enlace Externo`).

---

### Área 4: Monitoreo Automático de Dominios, Espejos y Resiliencia
> *Inspirado en `streamvix`*

Los sitios de doramas cambian frecuentemente de dominio o aplican bloqueos de Cloudflare:

1. **Script de Verificación de Salud de Dominios (`scripts/check_domains.js`)**:
   - Crear una tarea periódica (vía GitHub Actions o script ejecutado por el desarrollador) que compruebe la conectividad con todos los dominios de `src/sources/`.
   - Si un sitio cambia de dominio (ej. `doramasflix.in` a `doramasflix.io`), el script actualizará o notificará los cambios en `domains.json`.
2. **Circuit Breaker para Fuentes Caídas**:
   - Si una fuente falla reiteradamente durante un período de tiempo (ej. 5 respuestas fallidas consecutivas en KV), marcarla temporalmente como *degradada* para no ralentizar el tiempo de respuesta general de las demás fuentes.

---

### Área 5: Optimización de Encabezados de Caché HTTP para Stremio
> *Inspirado en `animeflv-stremio-addon`*

Para garantizar que la interfaz de Stremio cargue de forma instantánea y no mantenga información obsoleta tras el estreno de un capítulo:

1. **Encabezados HTTP Afinados**:
   - Aplicar la siguiente política de respuesta HTTP en el Worker:
     - **Streams**: `Cache-Control: public, max-age=3600, stale-while-revalidate=1800, stale-if-error=86400`
     - **Metadatos de Episodios**: `Cache-Control: public, max-age=600, stale-while-revalidate=600, stale-if-error=86400`
2. **Beneficios**:
   - Stremio mostrará los datos de la caché local de inmediato al usuario, mientras actualiza la lista de streams en segundo plano si la entrada ha expirado.

---

### Área 6: Arquitectura Modular de Pruebas Automatizadas con Fixtures
> *Inspirado en `WebStreamrMBG`*

`stremio-doramas` cuenta actualmente con el endpoint `/debug-all`, que realiza pruebas en vivo contra sitios reales. Sin embargo, los cambios en el código pueden romper extractores sin que lo notemos hasta que un sitio cambia.

1. **Suite de Pruebas con `vitest` / `jest` y Fixtures**:
   - Guardar páginas HTML estáticas de ejemplo (`.html` fixtures) de sitios como `doramaslat`, `pandrama` o respuestas JSON de `dflix`.
2. **Pruebas Unitarias de Extractores**:
   - Verificar que `extractStreamwish`, `extractMp4upload`, `extractSavefiles` y los parseadores de DooPlay funcionen correctamente analizando los fixtures locales sin necesidad de acceso a Internet durante la ejecución del comando de prueba.

---

### Área 7: Canales de Transmisión Continua 24/7 (Doramas en Vivo)
> *Inspirado en `tvvoo` y `streamvix`*

1. **Catálogo de TV / Canales Temáticos de Doramas**:
   - Implementar un catálogo opcional de tipo `tv` que exponga transmisiones en vivo 24/7 o reproducciones continuas de doramas populares (utilizando listas M3U o streams HLS directos).
2. **EPG Integrada**:
   - Asignar nombres y logos estandarizados para que Stremio reconozca la guía de programación en la pestaña de TV en vivo.

---

## 5. Resumen de Implementación Sugerida

| Prioridad | Mejora | Complejidad | Impacto en Usuario |
|:---:|---|:---:|:---:|
| 🟢 **Alta** | Página de Configuración `/configure` | Media | 🌟 Muy Alto (Personalización total) |
| 🟢 **Alta** | Coincidencia Difusa de Títulos (Fuzzy Matching con `fuse.js`) | Baja | 🌟 Muy Alto (Mayor precisión en búsquedas) |
| 🟡 **Media** | Encabezados `Cache-Control` (`stale-while-revalidate`) | Baja | 🚀 Alto (Respuesta más rápida) |
| 🟡 **Media** | Deduplicado y Formateo Limpio de Stream Rows | Media | 🎨 Alto (Mejor experiencia visual) |
| 🔵 **Baja** | Pruebas Unitarias con HTML Fixtures | Media | 🛡️ Alto (Estabilidad del código) |
| 🔵 **Baja** | Script de Verificación de Dominios (`check_domains.js`) | Baja | 🔧 Medio (Mantenimiento facilitado) |

---
*Documento generado como guía de evolución y mejores prácticas para el proyecto `stremio-doramas`.*
