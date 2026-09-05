/*
 * Build step for the Obsidian store's reproducible build verification.
 *
 * The plugin ships as a single dependency-free file: `main.js` IS the build
 * output (there is no TypeScript/bundling step). This script:
 *   1. verifies the release files that Obsidian needs exist (main.js,
 *      manifest.json, styles.css),
 *   2. verifies the version declared in manifest.json / versions.json matches
 *      package.json (catches drift before a store submission),
 *   3. writes `main.js` back byte-for-byte so the store's
 *      `npm ci && npm run build` reproduces the exact released artifact.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const required = ['main.js', 'manifest.json', 'styles.css'];
for (const file of required) {
  if (!existsSync(file)) {
    console.error(`[build] missing required release file: ${file}`);
    process.exit(1);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[build] cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
}

const pkg = readJson('package.json');
const manifest = readJson('manifest.json');
const versions = readJson('versions.json');
const versionKeys = Object.keys(versions);

if (manifest.version !== pkg.version) {
  console.error(`[build] version mismatch: manifest=${manifest.version} package=${pkg.version}`);
  process.exit(1);
}
if (!versionKeys.includes(pkg.version)) {
  console.error(`[build] versions.json does not list ${pkg.version} (found: ${versionKeys.join(', ') || 'none'})`);
  process.exit(1);
}

const bytes = readFileSync('main.js');
writeFileSync('main.js', bytes); // identity write: reproducible byte-for-byte

console.log(`[build] ok — EaglePack Importer ${pkg.version}: main.js (${bytes.length} bytes) is reproducible`);
