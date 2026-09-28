import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

let copied = 0;
for (const entry of readdirSync(src, { recursive: true })) {
  const relative = String(entry);
  if (!relative.endsWith(".css")) continue;
  const target = path.join(dist, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(src, relative), target);
  copied += 1;
}
console.log(`copy-assets: ${copied} css file(s)`);
