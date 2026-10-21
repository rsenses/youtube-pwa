import { readFileSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
const path = "dist/alveo/wrangler.json";
if (!existsSync(path))
  throw new Error("Falta el Worker compilado: revisa main en wrangler.jsonc.");
const config = JSON.parse(readFileSync(path, "utf8"));
if (
  !config.main ||
  resolve("dist/alveo", config.assets?.directory || "") !==
    resolve("dist/client")
)
  throw new Error(
    "El despliegue debe incluir el Worker y servir solo dist/client.",
  );
if (
  config.vars?.APP_ORIGIN !== "https://alveo.rsenses.com" ||
  !config.d1_databases?.some((db) => db.binding === "DB") ||
  !config.queues?.producers?.some((q) => q.binding === "SYNC_QUEUE") ||
  !config.kv_namespaces?.some((k) => k.binding === "READ_CACHE")
)
  throw new Error("Faltan el origen o los bindings de producción.");
for (const name of readdirSync("dist/client"))
  if (/^(?:\.dev\.vars|wrangler\.|index\.js$)/.test(name))
    throw new Error(
      "Hay archivos de backend dentro de los estáticos públicos.",
    );
if (existsSync("dist/alveo/.dev.vars"))
  chmodSync("dist/alveo/.dev.vars", 0o600);
console.log(
  "Build verificado: Worker + API, estáticos separados y bindings de producción.",
);
