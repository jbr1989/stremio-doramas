# Comparativa de `stremio-doramas` y Propuestas de Mejora

Este documento compara en detalle la arquitectura, funcionalidades y diseño de **stremio-doramas** con los siguientes 5 proyectos de la comunidad de Stremio:

1. [qwertyuiop8899/streamvix](https://github.com/qwertyuiop8899/streamvix)
2. [qwertyuiop8899/tvvoo](https://github.com/qwertyuiop8899/tvvoo)
3. [newman2x/WebStreamrMBG](https://github.com/newman2x/WebStreamrMBG)
4. [kunolabs/yukistreams-addon](https://github.com/kunolabs/yukistreams-addon)
5. [dudu-martins/brazilcam4-nuvio](https://github.com/dudu-martins/brazilcam4-nuvio)

---

## 📄 Resumen de Arquitectura Actual de `stremio-doramas`

- **Plataforma:** Serverless en Cloudflare Workers (`src/index.ts`) con microservicio proxy auxiliar en Deno Deploy (`deno/fetch.ts`).
- **Nivel Gratis / Eficiencia:** Extremadamente ligero, tiempo de ejecución global reducido y presupuesto de CPU ajustado.
- **Fuentes:** Sitios especializados en Doramas (`dlat`, `dplay`, `kplay`, `dflix`, `tudorama`, `pandrama`, `dsub`, `dyt`).
- **Mecanismos:** Scraper HTML / GraphQL, proxy de cabeceras, extractores manuales de reproductores (StreamWish, SaveFiles, Mp4Upload, Hexload, Pixeldrain, Dood/Playmogo) y fallback opcional a Cloudflare Browser Rendering.

---

## 🔍 Análisis Comparativo Proyecto por Proyecto

### 1. `streamvix` (qwertyuiop8899/streamvix)
* **Puntos Fuertes:**
  - **Soporte MediaFlow Proxy (MFP):** Integra reescritura/envolvimiento dinámico mediante MediaFlow Proxy para evitar bloqueos por IP y geobloqueos.
  - **Soporte Multi-Proxy configurable por proveedor:** Permite configurar proxies SOCKS5/HTTP independientes por fuente (`AU_PROXY`, `AS_PROXY`, etc.) para evadir desafíos de Cloudflare.
  - **Manejo Dinámico de Catálogos & Tareas Programadas:** Ejecuta scripts periódicos (`Live.py`) con purge de contenidos caducados y recarga dinámica de JSON sin reiniciar el servidor.
* **Lección para nuestro proyecto:**
  - Incorporar la capacidad opcional de envolver flujos con MediaFlow Proxy cuando el usuario disponga de una instancia.
  - Permitir activar proxies de salida específicos (ej. SOCKS5 o WARP) para resolver reproductores rebeldes sin depender únicamente de Cloudflare Browser Rendering.

---

### 2. `tvvoo` (qwertyuiop8899/tvvoo)
* **Puntos Fuertes:**
  - **Página de Configuración Dinámica `/configure`:** Interfaz web intuitiva que permite al usuario seleccionar qué catálogos/países incluir o excluir y genera una URL de manifest adaptada (`/cfg-es-lat/manifest.json`).
  - **Rutas de Manifest personalizadas por Path:** La app analiza los parámetros codificados en la URL para adaptar la lista de catálogos y fuentes expuestas.
* **Lección para nuestro proyecto:**
  - Crear una interfaz web de configuración (Landing `/configure`) que permita al usuario elegir sus fuentes de doramas preferidas (ej. deshabilitar fuentes lentas o que no usa) antes de instalar el addon en Stremio.

---

### 3. `WebStreamrMBG` (newman2x/WebStreamrMBG)
* **Puntos Fuertes:**
  - **Gestión Avanzada de Extractores y Deshabilitación de Fuentes:** Permite deshabilitar extractores (`DISABLED_EXTRACTORS`) o fuentes (`DISABLED_SOURCES`) mediante variables de entorno o interfaz.
  - **Integración con FlareSolverr:** Redirección automática de páginas con reto de Cloudflare hacia un endpoint de FlareSolverr para obtener cookies/tokens de sesión.
  - **Configuración de Proxy por Dominio (`PROXY_CONFIG`):** Uso de patrones minimatch (`dood.to:http://...`, `*:socks5://...`) para dirigir tráfico específico a través de proxys dedicados.
  - **Base de Datos Persistente Local (SQLite):** Caché de catálogo y resolver persistente.
* **Lección para nuestro proyecto:**
  - Implementar un sistema de bandera/filtro para desactivar extractores o fuentes de manera granular sin tocar el código.
  - Ofrecer compatibilidad con FlareSolverr como alternativa/complemento a Cloudflare Browser Rendering.

---

### 4. `yukistreams-addon` (kunolabs/yukistreams-addon)
* **Puntos Fuertes:**
  - **Soporte Multilinea de Reproducción (Direct, Debrid, P2P, MediaFlow):** Evalúa el perfil del usuario e integra conectores con servicios de Debrid (Real-Debrid, TorBox) para resolver enlaces premium o torrents cacheados de doramas.
  - **Limpieza de Nombres y Formateo Consistente de Streams:** Muestra etiquetas de calidad, idioma, fuente y subtítulos de forma estructurada y sin duplicados molestos.
  - **Perfiles y Presets de Usuario:** Modos prediseñados según la conexión y dispositivos del usuario.
* **Lección para nuestro proyecto:**
  - Enriquecer la metadata de cada stream devuelto (etiquetas de audio como "Latino / Sub Español", servidor de origen, velocidad estimada).
  - Posible integración opcional con Debrid (Real-Debrid / TorBox) para enlaces que tengan torrents o servidores premium.

---

### 5. `brazilcam4-nuvio` (dudu-martins/brazilcam4-nuvio)
* **Puntos Fuertes:**
  - **Filtros de Ordenación y Búsqueda en Catálogo:** Catálogos navegables con ordenación dinámica (por popularidad/espectadores).
  - **Arquitectura Ultra Ligera y Limpia:** Estructura minimalista, sin sobrecarga de dependencias.
* **Lección para nuestro proyecto:**
  - Implementar opciones de ordenación en nuestros catálogos (ej. "Más recientes", "Más populares", "Por servidor").

---

## 🚀 Lista Detallada de Posibles Mejoras para `stremio-doramas`

 Basándonos en el análisis anterior, estas son las modificaciones estratégicas que podrías implementar en el proyecto:

### 🛠️ 1. Interfaz de Configuración de Usuario (`/configure`) y Manifests Dinámicos
- **Descripción:** Implementar una landing page web simple alojada en el Worker (usando HTML estático servido desde `/configure`).
- **Funcionamiento:**
  - El usuario podrá seleccionar mediante casillas de verificación cuáles fuentes activar (`dlat`, `dplay`, `kplay`, `dflix`, `tudorama`, `pandrama`, `dsub`, `dyt`).
  - Posibilidad de ingresar credenciales opcionales (ej. URL/Key de MediaFlow Proxy, Token de Real-Debrid, o Clave de FlareSolverr).
  - Generación de una URL de Manifest codificada, por ejemplo:
    `https://mi-addon.workers.dev/cfg/dlat,dplay,dflix/manifest.json`
- **Beneficio:** Reduce la latencia y subrequests consumidas en Cloudflare Workers al no consultar fuentes que el usuario no desea o que están fallando.

---

### 🛡️ 2. Soporte Opcional para MediaFlow Proxy (MFP) e Integración con FlareSolverr
- **Descripción:** Agregar compatibilidad con MediaFlow Proxy y FlareSolverr.
- **Funcionamiento:**
  - Cuando un host de video (como StreamWish, FileLions o Dood) aplique bloqueos estrictos por IP, el Worker podrá envolver la URL del stream en el formato de MediaFlow Proxy (`${MFP_URL}/proxy/hls?url=...&api_password=...`).
  - Para sitios de doramas con protección agresiva de Cloudflare (como `dsvplay`, `do7go`, `playmogo`), permitir configurar un endpoint de **FlareSolverr** alternativo al Cloudflare Browser Rendering.
- **Beneficio:** Mayor tasa de éxito en la reproducción de streams en clientes como Android TV / Stremio Web donde los encabezados `Referer` / `User-Agent` no siempre son respetados por el reproductor nativo.

---

### 🎨 3. Formateo y Enriquecimiento Visual de los Streams
- **Descripción:** Normalizar el diseño y etiquetado de los resultados presentados en Stremio.
- **Funcionamiento:**
  - Estructurar la propiedad `title` de los streams con un formato claro e informativo:
    ```text
    [DoramasLat] StreamWish • 1080p
    💬 Sub Español / 🇲🇽 Audio Latino
    ⚡ Directo / Proxy Deno
    ```
  - Incluir indicadores visuales (emojis o insignias) para distinguir rápidamente entre audio Latino, Castellano o Subtitulado, así como el servidor de video subyacente.
- **Beneficio:** Mejora notable en la experiencia de usuario dentro de la aplicación Stremio.

---

### ⚡ 4. Deshabilitación Dinámica de Fuentes y Extractores por Configuración / Diagnóstico
- **Descripción:** Sistema de "Circuit Breaker" o lista negra temporal.
- **Funcionamiento:**
  - Si una fuente (por ejemplo `tudorama` o `kplay`) responde con errores repetidos o tiempos de espera agotados, marcar esa fuente como inactivada temporalmente en memoria/KV.
  - Permitir a los administradores desactivar fuentes mediante un endpoint de administración o variables de entorno (`DISABLED_SOURCES="tudorama,kplay"`).
- **Beneficio:** Evita que el usuario sufra demoras de 10 a 20 segundos esperando respuesta de sitios caídos o bloqueados.

---

### 💎 5. Integración con Debrid (Real-Debrid / TorBox)
- **Descripción:** Añadir soporte opcional para resolvers Debrid.
- **Funcionamiento:**
  - Permitir que las URLs de hosts pesados o con límites de velocidad (ej. Pixeldrain, Mp4Upload, Hexload, Mega) sean desbloqueadas mediante la API de Real-Debrid o TorBox si el usuario ha configurado su API Token.
- **Beneficio:** Carga instantánea de episodios en máxima calidad sin buffer ni restricciones de ancho de banda del host gratuito.

---

### 📊 6. Catálogos Mejorados con Ordenación y Filtros por Género/Año
- **Descripción:** Expandir las opciones del manifest para ofrecer sub-catálogos.
- **Funcionamiento:**
  - Añadir filtros de catálogo en el manifest de Stremio por género (Coreano, Japonés, Chino, Romance, Acción) o por año de estreno.
  - Implementar ordenación por "Últimos añadidos" vs "Más populares".
- **Beneficio:** Facilita el descubrimiento de contenido nuevo directamente desde la pantalla principal de Stremio.

---

## 📋 Resumen Recomendado de Prioridad de Implementación

| # | Mejora | Complejidad | Impacto en Usuario |
|---|---|---|---|
| 1 | **Interfaz `/configure` y Manifests Adaptativos** | Media | 🌟 Alto |
| 2 | **Etiquetado e Iconografía de Streams** | Baja | 🌟 Alto |
| 3 | **Soporte para MediaFlow Proxy (MFP)** | Media | 🌟 Alto |
| 4 | **Circuit Breaker / Desactivación de Fuentes** | Media | 🛡️ Medio/Alto |
| 5 | **Soporte para FlareSolverr** | Media | 🛡️ Medio |
| 6 | **Integración con Real-Debrid / TorBox** | Alta | 💎 Premium |
