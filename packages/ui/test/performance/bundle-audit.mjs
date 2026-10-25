import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
// Run from the repository root after the usual build, for example:
// node packages/ui/test/performance/bundle-audit.mjs apps/web/dist FileBrowser
// node packages/ui/test/performance/bundle-audit.mjs apps/desktop/dist FileBrowser
// Reports minified JavaScript (raw and gzip) required by a lazy entry, excluding
// the initial page's static imports. Dynamic descendants load only on demand.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const output = path.resolve(process.argv[2] ?? 'apps/web/dist');
const selector = process.argv[3] ?? 'FileBrowser';
const files = fs.readdirSync(path.join(output, 'assets')).filter(file => file.endsWith('.js'));
const chunks = new Map();
for (const file of files) {
  const relative = `assets/${file}`;
  const content = fs.readFileSync(path.join(output, relative), 'utf8');
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const imports = [];
  for (const statement of ast.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.')) imports.push(path.posix.normalize(path.posix.join('assets', specifier)));
    }
  }
  chunks.set(relative, { file: relative, raw: Buffer.byteLength(content), gzip: zlib.gzipSync(content).length, imports });
}
function closure(roots) {
  const found = new Set();
  function add(file) {
    if (found.has(file) || !chunks.has(file)) return;
    found.add(file);
    for (const imported of chunks.get(file).imports) add(imported);
  }
  for (const root of roots) add(root);
  return found;
}
const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
const initialRoots = [...html.matchAll(/(?:src|href)="\/?([^\"]+\.js)"/g)].map(match => path.posix.normalize(match[1]));
const initial = closure(initialRoots);
const roots = [...chunks.keys()].filter(file => path.basename(file).startsWith(`${selector}-`));
if (roots.length !== 1) throw new Error(`Expected one ${selector} entry, found: ${roots.join(', ')}`);
const reachable = closure(roots);
const incremental = [...reachable].filter(file => !initial.has(file)).map(file => chunks.get(file)).sort((a,b) => b.raw - a.raw);
const sum = list => ({ chunks: list.length, raw: list.reduce((n, c) => n + c.raw, 0), gzip: list.reduce((n, c) => n + c.gzip, 0) });
console.log(JSON.stringify({ output, selector, root: roots[0], initial: sum([...initial].map(file => chunks.get(file))), incremental: sum(incremental), files: incremental }, null, 2));
