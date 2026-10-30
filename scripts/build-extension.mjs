// Builds extension/yahoo-draft-reader.user.js: inlines extension/parser.js (ES module, no deps) into extension/userscript.src.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension");
const parser = fs.readFileSync(path.join(root, "parser.js"), "utf8");
const src = fs.readFileSync(path.join(root, "userscript.src.js"), "utf8");

if (/^\s*import\s/m.test(parser)) throw new Error("parser.js must not import anything");
if (/^export\s*\{|^export\s+default/m.test(parser)) throw new Error("parser.js: use `export function/const` declarations only");
const inlined = parser.replace(/^export\s+/gm, "").split("\n").map((l) => (l ? "  " + l : l)).join("\n");

const MARK = "/*__PARSER__*/";
if (!src.includes(MARK)) throw new Error(`${MARK} marker missing in userscript.src.js`);
const out = src.replace(MARK, () => `// ---- inlined from extension/parser.js ----\n${inlined}\n  // ---- end parser.js ----`);
const target = path.join(root, "yahoo-draft-reader.user.js");
fs.writeFileSync(target, out);
console.log(`wrote ${path.relative(process.cwd(), target)} (${out.length} bytes)`);
