import { readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
const redirect = JSON.parse(readFileSync(".wrangler/deploy/config.json", "utf8"));
if (typeof redirect.configPath !== "string")
  throw new Error("Falta la configuración de despliegue generada por Vite.");
const path = resolve(".wrangler/deploy", redirect.configPath);
if (!existsSync(path))
  throw new Error("Falta el Worker compilado: revisa main en wrangler.jsonc.");
const config = JSON.parse(readFileSync(path, "utf8"));
if (
  !config.main ||
  resolve(dirname(path), config.assets?.directory || "") !==
    resolve("dist/client")
)
  throw new Error(
    "El despliegue debe incluir el Worker y servir solo dist/client.",
  );
const appOrigin = config.vars?.APP_ORIGIN;
let origin;
try {
  origin = new URL(appOrigin);
} catch {
  throw new Error("APP_ORIGIN debe ser el origen HTTPS del dominio configurado.");
}
if (
  origin.protocol !== "https:" ||
  appOrigin !== origin.origin ||
  origin.hostname === "alveo.ejemplo.com" ||
  !config.routes?.some((route) => route.custom_domain && route.pattern === origin.host) ||
  !config.d1_databases?.some((db) => db.binding === "DB" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(db.database_id)) ||
  !config.queues?.producers?.some((q) => q.binding === "SYNC_QUEUE") ||
  !config.kv_namespaces?.some((k) => k.binding === "READ_CACHE" && /^[\da-f]{32}$/i.test(k.id)) ||
  !config.r2_buckets?.some((bucket) => bucket.binding === "FEED_IMAGES")
)
  throw new Error("Faltan el origen o los bindings de producción.");
for (const name of readdirSync("dist/client"))
  if (/^(?:\.dev\.vars|wrangler\.|index\.js$)/.test(name))
    throw new Error(
      "Hay archivos de backend dentro de los estáticos públicos.",
    );
const localSecrets = resolve(dirname(path), ".dev.vars");
if (existsSync(localSecrets)) chmodSync(localSecrets, 0o600);
console.log(
  "Build verificado: Worker + API, estáticos separados y bindings de producción.",
);
