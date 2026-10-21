import { sanitizeText } from "./http";

// Remove language glue, platform/creator promotion and common title boilerplate.
const NOISE = new Set(
  "a al algo and are as at be by con como como de del desde el en es esta este esto for from ha how i in is it la las lo los me mi mis no of on or para pero por que se sin so su sus the this to tu un una unas unos video videos youtube shorts short live directo official oficial hd 4k 1080p 60fps subscribe suscribete suscribanse canal channel viral trending tendencia tutorial review reviews guia guide aprende aprender learn learning nuevo nueva new latest hoy today episodio episode parte part capitulo chapter increible amazing ver watch mira mira descubre descubre entiende introduccion introduction mas very muy todo todos all full completo completa".split(
    /\s+/,
  ),
);
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function words(value: string): string[] {
  return sanitizeText(value, 500)
    .normalize("NFKC")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/[^\p{L}\p{N}+#.\s]/gu, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[.#]+|[.]+$/g, ""))
    .filter(
      (word) =>
        /\p{L}/u.test(word) && !NOISE.has(fold(word)) && word.length <= 48,
    );
}
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = fold(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const query = (tokens: string[]) =>
  unique(tokens).slice(0, 8).join(" ").slice(0, 140).trim();

/** At most two thematic searches: useful tags first, title/description fallback. */
export function relatedQueries(source: {
  title: string;
  description?: string;
  channelTitle?: string;
  tags?: string[];
}): string[] {
  const title = unique(words(source.title));
  const hashtags = Array.from(
    (source.description || "").matchAll(/#([\p{L}\p{N}_]+)/gu),
    (m) => m[1].replaceAll("_", " "),
  );
  const fallback = query(
    title.length
      ? [...title, ...hashtags.flatMap(words)]
      : [
          ...hashtags.flatMap(words),
          ...words((source.description || "").slice(0, 300)),
        ],
  );
  const channelWords = new Set(words(source.channelTitle || "").map(fold));
  const titleWords = new Set(title.map(fold));
  const tags = (source.tags || [])
    .slice(0, 40)
    .map((tag, index) => ({ tokens: unique(words(tag)), index }))
    .filter(
      (tag) =>
        tag.tokens.length &&
        !tag.tokens.every((word) => channelWords.has(fold(word))),
    )
    .sort(
      (a, b) =>
        b.tokens.filter((w) => titleWords.has(fold(w))).length -
          a.tokens.filter((w) => titleWords.has(fold(w))).length ||
        a.index - b.index,
    );
  const tagWords = unique(tags.slice(0, 2).flatMap((tag) => tag.tokens)).slice(
    0,
    6,
  );
  const preferred = tagWords.length
    ? query(
        tagWords.length < 2 ? [...tagWords, ...title.slice(0, 2)] : tagWords,
      )
    : "";
  return unique([preferred, fallback].filter(Boolean));
}
