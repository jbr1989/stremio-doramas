import {
  genreSourceOptions,
  masterGenreLabels,
} from "./genres";

const ADDON_ID = "com.doramas.stremio";

// Extras de catálogo: búsqueda y paginación estándar; el dropdown de género
// se agrega con withGenre() únicamente donde el sitio lo soporta de verdad
// (criterio Opción B y detalle in-vivo en src/genres.ts): términos del
// registry propio de cada sitio, expuestos aunque hoy devuelvan 0 series —
// si upstream etiqueta series mañana, el filtro se llena solo.
type CatalogExtra = {
  name: string;
  isRequired: boolean;
  options?: string[];
  optionsLimit?: number;
};

const SEARCH_SKIP: CatalogExtra[] = [
  { name: "search", isRequired: false },
  { name: "skip", isRequired: false },
];
const withGenre = (opts: string[]): CatalogExtra[] => [
  ...SEARCH_SKIP,
  { name: "genre", isRequired: false, options: opts, optionsLimit: 1 },
];

export const MANIFEST = {
  id: ADDON_ID,
  version: "1.3.0",
  name: "Doramas",
  description: "Fuentes de Doramas en español y subtituladas",
  // Fallback por si el manifest se consume fuera del handler (el dominio vivo
  // en producción); en runtime index.ts reescribe logo al origin del request.
  logo: "https://stremio-doramas.jbr1989-b26.workers.dev/logo.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  catalogs: [
    {
      type: "series",
      id: "alldoramas-directory",
      name: "Todos los Doramas",
      extra: withGenre(masterGenreLabels()),
    },
    {
      type: "series",
      id: "doramaslat-directory",
      name: "Doramas Latino — Directorio",
      extra: withGenre(genreSourceOptions("dorama")),
    },
    {
      type: "series",
      id: "doramedplay-directory",
      name: "Doramas Sub — Directorio",
      extra: withGenre(genreSourceOptions("dsub")),
    },
    {
      type: "series",
      id: "kplay-directory",
      name: "KDramas Play — Directorio",
      extra: withGenre(genreSourceOptions("kplay")),
    },
    {
      type: "series",
      id: "doramasflix-directory",
      name: "Doramasflix — Directorio",
      extra: withGenre(genreSourceOptions("dflix")),
    },
    {
      type: "series",
      id: "tudorama-directory",
      name: "TuDorama — Directorio",
      extra: withGenre(genreSourceOptions("tudorama")),
    },
    {
      type: "series",
      id: "pandrama-directory",
      name: "Pandrama — Dramas Populares",
      extra: withGenre(genreSourceOptions("pandrama")),
    },
    {
      type: "series",
      id: "doramasyt-directory",
      name: "DoramasYT — Directorio",
      extra: withGenre(genreSourceOptions("dyt")),
    },
  ],
  idPrefixes: ["dorama:", "dsub:", "kplay:", "dflix:", "tudorama:", "pandrama:", "dyt:"],
};
