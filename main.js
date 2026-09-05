/*
 * EaglePack Importer for Obsidian
 * ---------------------------------
 * Imports Eagle (https://eagle.cool) EaglePack export files (`.eaglepack`) —
 * and zipped Eagle libraries — into an Obsidian vault, in single or batch mode.
 *
 * A `.eaglepack` file is a ZIP archive. Two layouts occur in the wild and both
 * are understood here (plus nesting under an arbitrary prefix folder):
 *
 *   1. "Library layout" (a zipped Eagle .library folder)
 *        <prefix>/metadata.json                         -> folder tree (folders/smartFolders…)
 *        <prefix>/mtime.json                            -> item id index
 *        <prefix>/images/<ITEM_ID>.info/metadata.json   -> per-item metadata
 *        <prefix>/images/<ITEM_ID>.info/<file>          -> the original asset(s)
 *
 *   2. "Pack layout" (EaglePack produced by Eagle or third-party tools)
 *        pack.json                                      -> { images: [ ...item metadata ] }
 *        <ITEM_ID>.info/metadata.json                   -> per-item metadata
 *        <ITEM_ID>.info/<file>                          -> the original asset(s)
 *
 * For each item the plugin writes the asset into the vault, creates a Markdown
 * note that embeds it together with tags / URL / annotation / folder info /
 * colour palettes, and creates a pack-level index (gallery) note. This file is
 * intentionally dependency-free: ZIP parsing is implemented here and DEFLATE is
 * handled by the platform's native DecompressionStream.
 *
 * The pure logic (ZIP reader, EaglePack parser, markdown builders, sanitizers)
 * is exported so it can be unit-tested under plain Node (see tests/run.mjs).
 */

'use strict';

// ---------------------------------------------------------------------------
// 0. Obsidian bootstrap (guarded so the pure API is loadable under Node too)
// ---------------------------------------------------------------------------
let obsidianLib = null;
try {
  // eslint-disable-next-line global-require
  obsidianLib = require('obsidian');
} catch (_err) {
  obsidianLib = null; // running under plain Node for tests / tooling
}
// Test seam: tests/integration-smoke.mjs installs a fake Obsidian API here so
// the real plugin class (and its import pipeline) can run against a fake vault.
if (!obsidianLib && typeof globalThis !== 'undefined' && globalThis.__EAGLEPACK_OBSIDIAN_STUB) {
  obsidianLib = globalThis.__EAGLEPACK_OBSIDIAN_STUB;
}

// ---------------------------------------------------------------------------
// 1. Small shared helpers (pure)
// ---------------------------------------------------------------------------
const utf8Decoder = new TextDecoder('utf-8');

const EMBEDDABLE_IMAGES = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'jxl', 'heic', 'heif',
]);
const EMBEDDABLE_VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv', 'ogv', 'm4v', 'avi']);
const EMBEDDABLE_AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'opus', 'aac', 'wma', 'aiff']);
const EMBEDDABLE_OTHER = new Set(['pdf', 'md']);
const THUMB_RE = /(?:_thumbnail|_thumb|thumbnail|_preview|_tn)[.]/i;

// ---------------------------------------------------------------------------
// Item kind classification — which file extension belongs to which type group.
// The groups are editable from the Settings tab (see ITEM_TYPE_DEFAULT_*).
// ---------------------------------------------------------------------------
const ITEM_KIND_ORDER = ['bookmark', 'image', 'video', 'audio', 'document', 'font', 'archive', 'other'];

const ITEM_TYPE_LABELS = {
  bookmark: 'Bookmark',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  font: 'Font',
  archive: 'Archive',
  other: 'Other',
};

const ITEM_TYPE_DEFAULT_EXTENSIONS = {
  bookmark: ['url', 'webloc', 'website'], // web-bookmark shortcut extensions
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'jxl', 'heic', 'heif', 'raw', 'psb'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'ogv', 'm4v', 'avi', 'wmv', 'flv', 'mpeg', 'mpg', '3gp', 'ts'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'opus', 'aac', 'wma', 'aiff', 'aif', 'wv'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'html', 'htm', 'rtf', 'epub', 'pages', 'numbers', 'key', 'csv', 'indd', 'ai', 'psd', 'sketch', 'fig'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'iso'],
};

/** Fresh copy of the default group definitions (includes the implicit 'other'). */
function defaultTypeGroups() {
  const groups = {};
  for (const key of ITEM_KIND_ORDER) {
    groups[key] = key === 'other' ? [] : Array.from(ITEM_TYPE_DEFAULT_EXTENSIONS[key] || []);
  }
  return groups;
}

/** Parse a user-edited extension list ("png jpg,webp svg" → ["png","jpg",...]). */
function parseExtList(input) {
  const out = [];
  const seen = new Set();
  for (const raw of String(input == null ? '' : input).split(/[\s,;]+/)) {
    let ext = raw.trim().toLowerCase().replace(/^[.*]+/, '');
    if (!ext) continue;
    if (!seen.has(ext)) {
      seen.add(ext);
      out.push(ext);
    }
  }
  return out;
}

/** Merge a possibly-partial user setting object onto the defaults. */
function mergeItemTypeSettings(saved, defaults) {
  const d = defaults || defaultTypeGroups();
  const src = saved && typeof saved === 'object' ? saved : {};
  const srcGroups = src.groups && typeof src.groups === 'object' ? src.groups : {};
  const groups = {};
  for (const key of ITEM_KIND_ORDER) {
    const list = Array.isArray(srcGroups[key]) ? srcGroups[key] : d[key];
    groups[key] = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  }
  let noExt = typeof src.noExt === 'string' ? src.noExt : 'auto';
  if (noExt !== 'auto' && !ITEM_KIND_ORDER.includes(noExt)) noExt = 'auto';
  return { groups, noExt };
}

/** Which group does a file extension belong to? ('' or unknown → null) */
function typeOfExtension(ext, groups) {
  const e = String(ext || '').toLowerCase().replace(/^[.*]+/, '');
  if (!e || !groups) return null;
  for (const key of ITEM_KIND_ORDER) {
    const list = groups[key];
    if (Array.isArray(list) && list.includes(e)) return key;
  }
  return 'other'; // known extension, but not listed in any group
}

/**
 * Classify an Eagle item into one of the kind groups.
 *  - extension listed in an explicit group → that group;
 *  - extension unlisted AND the item is a URL item (bookmark/webpage) → Bookmark
 *    (in auto mode) instead of Other;
 *  - no extension → `noExt` rule ('auto' = URL items are bookmarks, else Other).
 */
function classifyItemKind(meta, groups, noExt) {
  const m = meta || {};
  const groupsFinal = groups || defaultTypeGroups();
  const mode = noExt || 'auto';
  const ext = String(m.ext || '').toLowerCase().replace(/^[.*]+/, '');
  if (ext) {
    const extKind = typeOfExtension(ext, groupsFinal);
    if (extKind && extKind !== 'other') return extKind;
    // Unlisted extension: don't let Eagle bookmarks/webpages fall into Other —
    // a source URL + unknown file type means bookmark, unless auto mode is off.
    if (mode === 'auto' && String(m.url || '') !== '') return 'bookmark';
    return 'other';
  }
  if (mode === 'auto') {
    return String(m.url || '') !== '' ? 'bookmark' : 'other';
  }
  return ITEM_KIND_ORDER.includes(mode) ? mode : 'other';
}

function typeLabel(kind) {
  return ITEM_TYPE_LABELS[kind] || 'Other';
}

/** Normalize zip entry path separators. */
function normPath(p) {
  let s = String(p == null ? '' : p);
  s = s.replace(/\\/g, '/');
  s = s.replace(/^[./]+/, '');
  return s;
}

function dirnameOf(p) {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

function basenameOf(p) {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

function stripExt(name) {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function extOf(name) {
  const idx = name.lastIndexOf('.');
  return idx > 0 && idx < name.length - 1 ? name.slice(idx + 1).toLowerCase() : '';
}

function isEmbeddable(name) {
  const ext = extOf(name);
  return EMBEDDABLE_IMAGES.has(ext) || EMBEDDABLE_VIDEO.has(ext) || EMBEDDABLE_AUDIO.has(ext) || EMBEDDABLE_OTHER.has(ext);
}

function isImageName(name) {
  return EMBEDDABLE_IMAGES.has(extOf(name));
}

function isThumbnailName(name) {
  return THUMB_RE.test(name) && isImageName(name);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${Math.round(v * 10) / 10} ${units[i]}`;
}

function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Sanitize a string so it is safe to use as a file or folder name inside an
 * Obsidian vault on Windows/macOS/Linux.
 */
function sanitizeFileName(name, opts) {
  const o = opts || {};
  let s = String(name == null ? '' : name).trim();
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f<>:"/\\|?*\u007f#\[\]^]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[ .]+|[ .]+$/g, '');
  // Windows reserved device names (case-insensitive)
  const head = s.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(head)) s = `_${s}`;
  s = s.trim();
  if (!s) s = o.fallback || 'Untitled';
  const max = o.max || 180;
  if (s.length > max) s = s.slice(0, max).trim().replace(/[ .]+$/, '');
  return s;
}

/** Quote a value as an inline YAML scalar. */
function yamlInline(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v); // JSON strings are valid YAML
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(yamlInline).join(', ')}]`;
  return JSON.stringify(v);
}

/** Convert an Eagle palette array into an inline HTML swatch line. */
function palettesToSwatches(palettes) {
  if (!Array.isArray(palettes) || palettes.length === 0) return '';
  const parts = [];
  for (const pal of palettes) {
    if (!pal || !Array.isArray(pal.color) || pal.color.length < 3) continue;
    const [r, g, b] = pal.color;
    const hex = `#${[r, g, b].map((c) => {
      const h = Math.max(0, Math.min(255, Math.round(c))).toString(16);
      return h.length === 1 ? `0${h}` : h;
    }).join('')}`;
    const ratio = typeof pal.ratio === 'number' ? `${pal.ratio}%` : '';
    parts.push(`<span class="ep-swatch" title="${hex} ${ratio}" style="background-color:${hex}"></span>`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 2. Minimal, dependency-free ZIP reader (store + deflate)
// ---------------------------------------------------------------------------
const SIG_EOCD = 0x06054b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

/**
 * Parse the ZIP central directory of `arrayBuffer`.
 * @param {ArrayBufferLike} arrayBuffer
 */
function openZip(arrayBuffer) {
  const ab = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
  const u8 = new Uint8Array(ab);
  const view = new DataView(ab);

  // Locate the End Of Central Directory record: its signature sits between 22
  // and 22 + 65535 (comment length) bytes from the end of the file.
  let eocd = -1;
  const minStart = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive: end-of-central-directory record not found.');

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff) {
    throw new Error('ZIP64 archives are not supported (too many entries).');
  }

  const entries = [];
  let p = cdOffset;
  for (let k = 0; k < totalEntries; k++) {
    if (p + 46 > u8.length || view.getUint32(p, true) !== SIG_CDH) {
      throw new Error(`Corrupt ZIP central directory near entry ${k}.`);
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported (an entry exceeds 4 GB or uses ZIP64 offsets).');
    }
    let name;
    try {
      name = utf8Decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));
    } catch (_e) {
      name = String.fromCharCode(...Array.from(u8.subarray(p + 46, p + 46 + nameLen)));
    }
    name = normPath(name);
    entries.push({
      index: k,
      name,
      flags,
      method,
      compSize,
      uncompSize,
      localOffset,
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const cache = new Map(); // entry.index -> Uint8Array

  async function inflateRaw(slice) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([slice]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function extract(index) {
    if (cache.has(index)) return cache.get(index);
    const e = entries[index];
    if (!e) throw new Error(`ZIP entry ${index} does not exist.`);
    if (e.isDir) {
      const empty = new Uint8Array(0);
      cache.set(index, empty);
      return empty;
    }
    // Read the local file header to compute the actual data offset.
    const lfh = e.localOffset;
    if (lfh + 30 > u8.length || view.getUint32(lfh, true) !== SIG_LFH) {
      throw new Error(`Corrupt ZIP local header for "${e.name}".`);
    }
    const localNameLen = view.getUint16(lfh + 26, true);
    const localExtraLen = view.getUint16(lfh + 28, true);
    const dataStart = lfh + 30 + localNameLen + localExtraLen;
    const end = dataStart + e.compSize;
    if (end > u8.length) throw new Error(`Truncated ZIP data for "${e.name}".`);

    let out;
    if (e.method === 0) {
      out = u8.slice(dataStart, end); // stored
    } else if (e.method === 8) {
      const slice = u8.slice(dataStart, end); // deflated
      try {
        out = await inflateRaw(slice);
      } catch (err) {
        throw new Error(`Failed to inflate "${e.name}": ${err && err.message ? err.message : err}`);
      }
    } else {
      throw new Error(`Unsupported ZIP compression method ${e.method} for "${e.name}" (only store/deflate are supported).`);
    }
    cache.set(index, out);
    return out;
  }

  return {
    u8,
    view,
    entries,
    extract,
  };
}

/** Read a ZIP entry as UTF-8 text (empty string on failure). */
async function readEntryText(zip, index) {
  try {
    const bytes = await zip.extract(index);
    return utf8Decoder.decode(bytes);
  } catch (_e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 3. Eagle metadata model + EaglePack parsing (pure)
// ---------------------------------------------------------------------------
const ITEM_DEFAULTS = {
  id: '',
  name: '',
  size: 0,
  btime: 0,
  mtime: 0,
  ext: '',
  tags: [],
  folders: [],
  isDeleted: false,
  url: '',
  annotation: '',
  modificationTime: 0,
  width: 0,
  height: 0,
  noThumbnail: false,
  lastModified: 0,
  palettes: [],
  star: 0,
  duration: 0,
  medium: '',
  bpm: 0,
  order: {},
  comments: [],
};

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function str(v) {
  return typeof v === 'string' ? v : '';
}
function bool(v) {
  return v === true;
}
function strArr(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** Fill missing item fields with sensible defaults; only `id` is guaranteed. */
function normalizeItem(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(ITEM_DEFAULTS)) out[key] = Array.isArray(ITEM_DEFAULTS[key]) ? [] : ITEM_DEFAULTS[key];
  out.id = str(src.id);
  out.name = str(src.name);
  out.size = num(src.size);
  out.btime = num(src.btime);
  out.mtime = num(src.mtime);
  out.ext = str(src.ext).toLowerCase();
  out.tags = strArr(src.tags);
  out.folders = strArr(src.folders);
  out.isDeleted = bool(src.isDeleted);
  out.url = str(src.url);
  out.annotation = str(src.annotation);
  out.modificationTime = num(src.modificationTime);
  out.width = num(src.width);
  out.height = num(src.height);
  out.noThumbnail = bool(src.noThumbnail);
  out.lastModified = num(src.lastModified);
  out.star = num(src.star);
  out.duration = num(src.duration);
  out.medium = str(src.medium);
  out.bpm = num(src.bpm);
  out.palettes = Array.isArray(src.palettes) ? src.palettes.filter(isPlainObject) : [];
  out.order = isPlainObject(src.order) ? src.order : {};
  out.comments = Array.isArray(src.comments) ? src.comments : [];
  return out;
}

/**
 * Classify an arbitrary parsed JSON object found inside a pack.
 * @returns {'item'|'library'|'pack'|'other'}
 */
function classifyJsonObject(obj) {
  if (!isPlainObject(obj)) return 'other';
  if (Array.isArray(obj.images)) return 'pack';
  if (typeof obj.id === 'string' && obj.id !== '') {
    // Item metadata always carries an id; a library header never has one.
    return 'item';
  }
  if (Array.isArray(obj.folders) || Array.isArray(obj.smartFolders) || Array.isArray(obj.orderedList) || Array.isArray(obj.tagsGroups)) {
    return 'library';
  }
  return 'other';
}

/**
 * Given the file entries inside one item folder, return the ordered list of
 * assets (primary first, thumbnail last).
 */
function pickAssets(fileList, meta) {
  const files = fileList.filter((f) => {
    const base = basenameOf(f.name).toLowerCase();
    if (base === 'metadata.json' || base === 'library.json' || base === 'pack.json') return false;
    if (base.endsWith('.json')) return false;
    if (base === 'thumbs.db' || base === '.ds_store' || base === 'desktop.ini') return false;
    return true;
  });
  const scored = files.map((f) => {
    const base = basenameOf(f.name);
    const isThumb = isThumbnailName(base);
    const metaExt = String(meta.ext || '').toLowerCase();
    const metaName = String(meta.name || '').toLowerCase();
    const isExact = !isThumb && metaExt !== '' && extOf(base) === metaExt && stripExt(base).toLowerCase() === metaName;
    const startsWithName = !isThumb && !isExact && metaName !== '' && base.toLowerCase().startsWith(metaName + '.');
    const weight = isThumb ? 0 : isExact ? 4 : startsWithName ? 3 : 2;
    return { f, isThumb, score: weight };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.f.uncompSize - a.f.uncompSize));
  const primary = scored.filter((s) => !s.isThumb);
  const thumbs = scored.filter((s) => s.isThumb);
  const ordered = primary.concat(thumbs);
  return ordered.map((s) => ({
    name: basenameOf(s.f.name),
    path: s.f.name,
    zipIndex: s.f.index,
    size: s.f.uncompSize,
    isThumbnail: s.isThumb,
  }));
}

/**
 * Parse an EaglePack (.eaglepack / .zip) buffer into a normalized model.
 *
 * @param {ArrayBufferLike} buffer raw file bytes
 * @param {string} sourceFileName original file name (for display)
 */
async function parseEaglePackBuffer(buffer, sourceFileName) {
  const zip = openZip(buffer);
  const warnings = [];
  const fileByDir = new Map(); // dir -> array of file entries
  const dirs = new Set();
  for (const e of zip.entries) {
    if (e.isDir) {
      dirs.add(normPath(e.name));
      continue;
    }
    const dir = dirnameOf(e.name);
    if (!fileByDir.has(dir)) fileByDir.set(dir, []);
    fileByDir.get(dir).push(e);
  }
  // Implicit parent directories of file entries (some archives omit directory records)
  for (const e of zip.entries) {
    if (e.isDir) continue;
    let d = dirnameOf(e.name);
    while (d !== '') {
      dirs.add(d);
      const nd = dirnameOf(d);
      if (nd === d) break;
      d = nd;
    }
  }

  // -- Phase 1: read & classify every .json entry ---------------------------
  const libraryMetas = [];
  const packRecords = [];
  const itemRecords = []; // { path, dir, metaRaw }
  const jsonIndexes = [];
  zip.entries.forEach((e, i) => {
    if (!e.isDir && /\.json$/i.test(basenameOf(e.name))) jsonIndexes.push(i);
  });
  for (const idx of jsonIndexes) {
    const entry = zip.entries[idx];
    if (entry.uncompSize > 8 * 1024 * 1024) {
      warnings.push(`Skipped oversized JSON entry "${entry.name}" (> 8 MB).`);
      continue;
    }
    const text = await readEntryText(zip, idx);
    if (!text) {
      warnings.push(`Could not read JSON entry "${entry.name}".`);
      continue;
    }
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (_e) {
      warnings.push(`Invalid JSON in "${entry.name}" — ignored.`);
      continue;
    }
    const kind = classifyJsonObject(obj);
    if (kind === 'library') {
      libraryMetas.push({ path: normPath(entry.name), obj });
    } else if (kind === 'pack') {
      packRecords.push({ path: normPath(entry.name), obj });
    } else if (kind === 'item') {
      itemRecords.push({ path: normPath(entry.name), dir: dirnameOf(entry.name), metaRaw: obj });
    }
  }

  // -- Phase 2: folder tree from the (first) library header ------------------
  const folderById = new Map();
  const folderRoots = [];
  if (libraryMetas.length > 0) {
    const lib = libraryMetas[0].obj;
    const walk = (list, parentId, depth) => {
      if (depth > 64) return;
      for (const node of list || []) {
        if (!isPlainObject(node) || typeof node.id !== 'string') continue;
        folderById.set(node.id, {
          id: node.id,
          name: str(node.name) || node.id,
          parentId,
          coverId: str(node.coverId),
        });
        if (!parentId) folderRoots.push(node.id);
        if (Array.isArray(node.children) && node.children.length > 0) walk(node.children, node.id, depth + 1);
      }
    };
    walk(lib.folders, null, 0);
  }

  // -- Phase 3: assemble items ------------------------------------------------
  const items = [];
  const seenIds = new Set();
  const addItem = (item) => {
    const itemId = item.meta ? item.meta.id : item.id;
    if (!itemId || seenIds.has(itemId)) return;
    seenIds.add(itemId);
    items.push(item);
  };

  for (const rec of itemRecords) {
    const meta = normalizeItem(rec.metaRaw);
    if (!meta.id) meta.id = basenameOf(rec.dir).replace(/\.info$/i, '');
    const dirFiles = fileByDir.get(rec.dir) || [];
    const assets = pickAssets(dirFiles, meta);
    addItem({ meta, sourceDir: rec.dir, assets, from: 'metadata.json' });
  }

  // pack.json may be the only source of item metadata
  for (const rec of packRecords) {
    const images = Array.isArray(rec.obj.images) ? rec.obj.images : [];
    for (const raw of images) {
      if (!isPlainObject(raw)) continue;
      const meta = normalizeItem(raw);
      if (!meta.id) continue;
      if (seenIds.has(meta.id)) continue;
      let folder = null;
      for (const d of dirs) {
        const base = basenameOf(d).replace(/\.info$/i, '');
        if (base === meta.id) {
          folder = d;
          break;
        }
      }
      let assets = [];
      if (folder) {
        const dirFiles = fileByDir.get(folder) || [];
        assets = pickAssets(dirFiles, meta);
      } else {
        warnings.push(`Pack metadata lists item "${meta.id}" but no asset folder was found.`);
      }
      addItem({ meta, sourceDir: folder || '', assets, from: 'pack.json' });
    }
  }

  if (items.length === 0 && itemRecords.length === 0 && packRecords.length === 0) {
    // Last resort: item dirs recognizable by ".info" naming but no parseable JSON
    for (const d of dirs) {
      if (!/\.info$/i.test(d)) continue;
      const id = basenameOf(d).replace(/\.info$/i, '');
      const dirFiles = fileByDir.get(d) || [];
      if (dirFiles.length === 0) continue;
      const assets = pickAssets(dirFiles, { name: '', ext: '', id });
      addItem({
        meta: Object.assign({}, ITEM_DEFAULTS, { id, name: id }),
        sourceDir: d,
        assets,
        from: 'folder-scan',
      });
    }
    if (items.length > 0) {
      warnings.push('No metadata JSON found; item records were inferred from folder names only.');
    } else {
      throw new Error('This archive does not look like an EaglePack export: no Eagle metadata.json, pack.json or *.info item folders were found.');
    }
  }

  items.sort((a, b) => {
    if (a.meta.isDeleted !== b.meta.isDeleted) return a.meta.isDeleted ? 1 : -1;
    return a.meta.name.localeCompare(b.meta.name) || a.meta.id.localeCompare(b.meta.id);
  });

  // Display name: library name > pack.json name > file name stem
  let displayName = '';
  if (libraryMetas.length > 0 && str(libraryMetas[0].obj.name)) displayName = str(libraryMetas[0].obj.name);
  if (!displayName && packRecords.length > 0 && str(packRecords[0].obj.name)) displayName = str(packRecords[0].obj.name);
  if (!displayName) displayName = stripExt(basenameOf(sourceFileName)) || sourceFileName || 'EaglePack';

  const folderName = (id) => {
    const f = folderById.get(id);
    return f ? f.name : id;
  };

  return {
    sourceFileName,
    displayName,
    items,
    folderById,
    folderRoots,
    folderName,
    hasLibraryHeader: libraryMetas.length > 0,
    hasPackJson: packRecords.length > 0,
    warnings,
    zip,
  };
}

// ---------------------------------------------------------------------------
// 4. Placement + markdown builders (pure)
// ---------------------------------------------------------------------------
const EMBEDDABLE_EXTS = new Set([...EMBEDDABLE_IMAGES, ...EMBEDDABLE_VIDEO, ...EMBEDDABLE_AUDIO, ...EMBEDDABLE_OTHER]);

/**
 * Compute the sanitized folder-path segments an item note should be placed in,
 * mirroring the Eagle folder tree. Empty array = pack root.
 */
function primaryFolderSegments(pack, itemMeta, opts) {
  const o = opts || {};
  if (o.mirrorFolders === false) return [];
  let folderId = '';
  if (Array.isArray(itemMeta.folders) && itemMeta.folders.length > 0) folderId = itemMeta.folders[0];
  if (!folderId || !pack.folderById.has(folderId)) return [];
  const chain = [];
  const visited = new Set();
  let cur = folderId;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const node = pack.folderById.get(cur);
    if (!node) break;
    chain.unshift(node.name);
    cur = node.parentId || '';
  }
  return chain.map((n) => sanitizeFileName(n, { fallback: 'Folder', max: 100 }));
}

/** Human-readable labels ("Root / Sub") for every folder an item belongs to. */
function folderLabels(pack, itemMeta) {
  const labels = [];
  for (const id of itemMeta.folders || []) {
    if (!pack.folderById.has(id)) continue;
    const chain = [];
    const visited = new Set();
    let cur = id;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const node = pack.folderById.get(cur);
      if (!node) break;
      chain.unshift(node.name);
      cur = node.parentId || '';
    }
    labels.push(chain.join(' / '));
  }
  return labels;
}

/** Obsidian-safe tag list derived from Eagle tags (no spaces / # / /). */
function obsidianTags(eagleTags) {
  const out = [];
  for (const t of eagleTags || []) {
    let tag = String(t).trim();
    if (!tag) continue;
    tag = tag.replace(/^#+/, '');
    tag = tag.replace(/[/\\]/g, '-');
    tag = tag.replace(/[\s_]+/g, '-');
    tag = tag.replace(/[^\p{L}\p{N}_-]/gu, '');
    tag = tag.replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!tag) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * A "bookmark / webpage" item is one Eagle saved from a URL that has no
 * original *content* file of its own — only metadata (with a source url) and
 * at most a generated preview image. Shortcut files such as *.url do not count
 * as content, so bookmark items keep the link-first layout even when a .url
 * sibling is present next to the preview.
 */
function isBookmarkItem(item) {
  const meta = item && item.meta;
  if (!meta || !meta.url) return false;
  const assets = Array.isArray(item.assets) ? item.assets : [];
  const hasRealMedia = assets.some((a) => !a.isThumbnail && isEmbeddable(a.name));
  return !hasRealMedia;
}

/** Build frontmatter + body of one item note. */
function buildItemNoteContent(ctx) {
  const { pack, item, segs, assetVaultPath, assetBaseName, opts, importDateISO } = ctx;
  const attachments = Array.isArray(ctx.attachments) ? ctx.attachments : [];
  const meta = item.meta;
  const title = meta.name || meta.id || 'Untitled';
  const url = meta.url || '';
  const tags = opts.tagFromEagle ? obsidianTags(meta.tags) : [];
  const folderLabelsList = folderLabels(pack, meta);
  // Kind classification: caller may pass it explicitly (from the editable
  // Settings groups); otherwise fall back to the default grouping rules.
  const kind = ctx.kind || classifyItemKind(meta, null, 'auto');
  const kindLabel = typeLabel(kind);
  const bookmark = kind === 'bookmark';
  const embeddable = !!assetVaultPath && EMBEDDABLE_EXTS.has(extOf(assetVaultPath));

  // Only allow clickable http(s)/ftp links (never javascript: …)
  const safeUrl = /^(https?|ftp):\/\//i.test(url) ? url : '';
  const linkLine = safeUrl ? `🔗 [${safeUrl}](${safeUrl})` : (url ? `🔗 ${url}` : '');

  const yaml = [];
  yaml.push('---');
  yaml.push('eagle:');
  yaml.push(`  id: ${yamlInline(meta.id)}`);
  yaml.push(`  name: ${yamlInline(meta.name || '')}`);
  yaml.push(`  ext: ${yamlInline(meta.ext || '')}`);
  yaml.push(`  kind: ${yamlInline(kind)}`);
  yaml.push(`  sourcePack: ${yamlInline(pack.displayName)}`);
  yaml.push(`  importedFrom: ${yamlInline(pack.sourceFileName)}`);
  yaml.push(`  importedAt: ${yamlInline(importDateISO)}`);
  if (meta.size > 0) yaml.push(`  size: ${yamlInline(meta.size)}`);
  if (meta.width > 0 || meta.height > 0) yaml.push(`  dimensions: ${yamlInline(`${meta.width} x ${meta.height}`)}`);
  if (meta.star > 0) yaml.push(`  star: ${yamlInline(meta.star)}`);
  if (meta.btime > 0) yaml.push(`  btime: ${yamlInline(formatDate(meta.btime))}`);
  if (meta.modificationTime > 0) yaml.push(`  modificationTime: ${yamlInline(formatDate(meta.modificationTime))}`);
  if (url) yaml.push(`  url: ${yamlInline(url)}`);
  if (meta.annotation) yaml.push(`  annotation: ${yamlInline(meta.annotation)}`);
  if (folderLabelsList.length > 0) yaml.push(`  eagleFolders: ${yamlInline(folderLabelsList)}`);
  if (meta.tags && meta.tags.length > 0) yaml.push(`  eagleTags: ${yamlInline(meta.tags)}`);
  if (assetBaseName) yaml.push(`  asset: ${yamlInline(assetBaseName)}`);
  if (tags.length > 0) yaml.push(`tags: ${yamlInline(tags)}`);
  yaml.push('---');
  yaml.push('');

  const body = [];
  body.push(`# ${title} <span class="ep-kind">${kindLabel}</span>`);
  body.push('');
  if (bookmark) {
    // Bookmarks: title → source link → preview image below it
    if (linkLine) {
      body.push(linkLine);
      body.push('');
    }
    if (embeddable && assetVaultPath) {
      body.push(`![[${assetVaultPath}]]`);
      body.push('');
    } else if (assetVaultPath) {
      const ext = extOf(assetVaultPath).toUpperCase();
      body.push(`📎 [[${assetVaultPath}|Open preview (${ext || 'asset'})]]`);
      body.push('');
    }
  } else if (embeddable && assetVaultPath) {
    body.push(`![[${assetVaultPath}]]`);
    body.push('');
  } else if (assetVaultPath) {
    const ext = extOf(assetVaultPath).toUpperCase();
    body.push(`📎 [[${assetVaultPath}|Open original file (${ext || 'asset'})]]`);
    body.push('');
  }

  if (attachments.length > 0) {
    body.push('### Attachments');
    body.push('');
    for (const at of attachments) {
      const atExt = extOf(at.path).toUpperCase();
      body.push(`- 📎 [[${at.path}|${at.name}${atExt ? ` (${atExt})` : ''}]]`);
    }
    body.push('');
  }

  if (meta.annotation) {
    body.push('> [!note] Annotation');
    body.push('>');
    for (const line of String(meta.annotation).split(/\r?\n/)) {
      body.push(`> ${line.replace(/\t/g, '    ')}`);
    }
    body.push('');
  }

  body.push('### Metadata');
  body.push('');
  if (meta.width > 0 || meta.height > 0) body.push(`- **Dimensions:** ${meta.width} × ${meta.height} px`);
  body.push(`- **Type:** ${kindLabel}${meta.ext ? ` (${meta.ext.toUpperCase()})` : ''}`);
  if (meta.size > 0) body.push(`- **Size:** ${formatBytes(meta.size)}`);
  if (meta.duration > 0) body.push(`- **Duration:** ${meta.duration}s`);
  if (meta.medium) body.push(`- **Medium:** ${meta.medium}`);
  if (meta.star > 0) {
    const n = Math.min(5, Math.max(0, Math.round(meta.star)));
    body.push(`- **Rating:** ${'★'.repeat(n)}${'☆'.repeat(5 - n)} (${meta.star}/5)`);
  }
  if (meta.btime > 0) body.push(`- **Added:** ${formatDate(meta.btime)}`);
  if (meta.modificationTime > 0) body.push(`- **Last modified:** ${formatDate(meta.modificationTime)}`);
  if (url && !bookmark) body.push(`- **Source:** [${url}](${url})`);
  if (folderLabelsList.length > 0) body.push(`- **Eagle folders:** ${folderLabelsList.join(', ')}`);
  if (meta.id) body.push(`- **Eagle ID:** \`${meta.id}\``);
  body.push('');

  if (meta.tags && meta.tags.length > 0) {
    body.push('### Tags');
    body.push('');
    body.push(meta.tags.map((t) => `- ${t}`).join('\n'));
    body.push('');
  }

  if (Array.isArray(meta.palettes) && meta.palettes.length > 0) {
    const swatches = palettesToSwatches(meta.palettes);
    if (swatches) {
      body.push('### Colour palette');
      body.push('');
      body.push(swatches);
      body.push('');
    }
  }

  return `${yaml.join('\n')}\n${body.join('\n')}`.trimEnd() + '\n';
}

/** Build the pack-level index (gallery) note. */
function buildIndexNoteContent(ctx) {
  const { pack, entries, opts, importDateISO } = ctx;
  const lines = [];
  lines.push(`# ${pack.displayName} — EaglePack index`);
  lines.push('');
  lines.push(`> Imported from \`${pack.sourceFileName}\` on ${importDateISO}. ${entries.length} item(s).`);
  lines.push('');

  const byFolder = new Map();
  const uncategorized = [];
  for (const en of entries) {
    const label = en.folderSegs && en.folderSegs.length > 0 ? en.folderSegs.join(' / ') : '';
    if (label) {
      if (!byFolder.has(label)) byFolder.set(label, []);
      byFolder.get(label).push(en);
    } else {
      uncategorized.push(en);
    }
  }
  const sortedLabels = [...byFolder.keys()].sort((a, b) => a.localeCompare(b));
  const append = (out, en) => {
    const title = (en.metaName || en.noteName || 'Item').slice(0, 90);
    const link = en.notePath ? `[[${en.notePath}|${title}]]` : `**${title}**`;
    const kindTag = en.kindLabel ? ` <span class="ep-kind">${en.kindLabel}</span>` : '';
    if (en.embedPath) {
      // title on its own line (with its type), item preview strictly below it
      out.push(`**${link}**${kindTag}`);
      out.push('');
      out.push(`![[${en.embedPath}|${opts.thumbWidth || 180}]]`);
      out.push('');
    } else {
      out.push(`- ${link}${kindTag}`);
    }
  };
  for (const label of sortedLabels) {
    lines.push(`## ${label}`);
    lines.push('');
    for (const en of byFolder.get(label)) append(lines, en);
    lines.push('');
  }
  if (uncategorized.length > 0) {
    lines.push('## Uncategorized');
    lines.push('');
    for (const en of uncategorized) append(lines, en);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 5. Pure API surface (used by tests as well)
// ---------------------------------------------------------------------------
const pureApi = {
  normPath,
  dirnameOf,
  basenameOf,
  stripExt,
  extOf,
  sanitizeFileName,
  formatBytes,
  formatDate,
  isEmbeddable,
  isImageName,
  isThumbnailName,
  yamlInline,
  palettesToSwatches,
  obsidianTags,
  openZip,
  readEntryText,
  normalizeItem,
  classifyJsonObject,
  pickAssets,
  parseEaglePackBuffer,
  primaryFolderSegments,
  folderLabels,
  isBookmarkItem,
  defaultTypeGroups,
  parseExtList,
  mergeItemTypeSettings,
  typeOfExtension,
  classifyItemKind,
  typeLabel,
  ITEM_KIND_ORDER,
  ITEM_TYPE_LABELS,
  ITEM_TYPE_DEFAULT_EXTENSIONS,
  buildItemNoteContent,
  buildIndexNoteContent,
};

// ---------------------------------------------------------------------------
// 6. Obsidian plugin class
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  importFolder: 'Eagle Imports',
  mirrorFolders: true,
  writeItemNotes: true,
  writeIndexNote: true,
  overwrite: false,
  tagFromEagle: true,
  openAfterSingle: true,
  thumbWidth: 180,
  itemTypes: { groups: defaultTypeGroups(), noExt: 'auto' },
};

// Placeholders assigned at the bottom of the file when Obsidian is present.
let ImportOptionsModalCtor = null;
let EaglePackImporterSettingTabCtor = null;

function createPlugin(PluginBase) {
  const { Notice, normalizePath } = obsidianLib;

  class EaglePackImporter extends PluginBase {
    async onload() {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
      // Normalize the (new) item-type settings so older saves keep working.
      this.settings.itemTypes = mergeItemTypeSettings(this.settings.itemTypes, null);
      this.statusEl = null;

      this.registerCommands();
      this.addSettingTab(new EaglePackImporterSettingTabCtor(this.app, this));
    }

    onunload() {
      if (this.statusEl) this.statusEl.remove();
    }

    registerCommands() {
      this.addCommand({
        id: 'import-eaglepack-single',
        name: 'Import EaglePack… (single file)',
        callback: () => this.chooseFiles(false),
      });
      this.addCommand({
        id: 'import-eaglepack-batch',
        name: 'Import EaglePacks… (batch)',
        callback: () => this.chooseFiles(true),
      });
      this.addRibbonIcon('download', 'EaglePack Importer — import .eaglepack files', () => this.chooseFiles(true));
    }

    chooseFiles(multiple) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.eaglepack,.zip';
      input.multiple = !!multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        input.remove();
        if (files.length === 0) return;
        await this.handleSelectedFiles(files);
      });
      input.click();
    }

    status(text) {
      if (!this.statusEl) {
        this.statusEl = this.addStatusBarItem();
      }
      this.statusEl.setText(text);
    }

    clearStatus() {
      if (this.statusEl) this.statusEl.setText('');
    }

    async handleSelectedFiles(files) {
      const relevant = files.filter((f) => /\.(eaglepack|zip)$/i.test(f.name || ''));
      const skipped = files.length - relevant.length;
      if (relevant.length === 0) {
        new Notice('EaglePack Importer: no .eaglepack/.zip files were selected.');
        return;
      }
      const parsed = [];
      const failures = [];
      for (let i = 0; i < relevant.length; i++) {
        const file = relevant[i];
        this.status(`EaglePack: parsing ${i + 1}/${relevant.length} — ${file.name}`);
        try {
          const buf = await file.arrayBuffer();
          const pack = await pureApi.parseEaglePackBuffer(buf, file.name);
          parsed.push({ file, pack });
        } catch (err) {
          failures.push({ name: file.name, error: err && err.message ? err.message : String(err) });
        }
      }
      this.clearStatus();
      if (parsed.length === 0) {
        const msg = failures.map((f) => `${f.name}: ${f.error}`).join('\n');
        new Notice(`EaglePack Importer: none of the files could be parsed.${failures.length ? `\n\n${msg}` : ''}`, 8000);
        console.error('[EaglePack Importer] parse failures', failures);
        return;
      }
      if (skipped > 0) new Notice(`EaglePack Importer: ${skipped} file(s) ignored (not .eaglepack/.zip).`, 5000);
      const modal = new ImportOptionsModalCtor(this.app, this, parsed, failures);
      modal.open();
    }

    async runImport(jobs, options) {
      const { vault } = this.app;
      const report = { created: 0, skipped: 0, failed: 0, notes: 0, packs: [], errors: [] };
      let totalItems = 0;
      for (const job of jobs) totalItems += job.pack.items.length;
      let done = 0;
      const base = normalizePath((options.importFolder || 'Eagle Imports').trim() || 'Eagle Imports');
      let openedIndexPath = null;

      for (const job of jobs) {
        try {
          const packName = sanitizeFileName(job.pack.displayName, { fallback: 'EaglePack', max: 100 });
          const packRoot = normalizePath(`${base}/${packName}`);
          const run = await this.importOnePack(job, packRoot, options, () => {
            done += 1;
            this.status(`EaglePack: ${done}/${totalItems}`);
          });
          report.created += run.created;
          report.skipped += run.skipped;
          report.failed += run.failed;
          report.notes += run.notes;
          report.errors.push(...run.errors);
          if (run.indexPath) {
            report.packs.push({ name: packName, items: run.items, indexPath: run.indexPath });
          }
          if (run.indexPath && options.openAfterSingle && jobs.length === 1) {
            openedIndexPath = run.indexPath;
          }
        } catch (err) {
          report.failed += 1;
          report.errors.push(`${job.pack.sourceFileName}: ${err && err.message ? err.message : err}`);
        }
      }
      this.clearStatus();

      const summary = [`Imported ${report.notes} note(s) — ${report.created} file(s) written, ${report.skipped} skipped, ${report.failed} failed.`];
      for (const p of report.packs) summary.push(`• ${p.name}: ${p.items} item(s) → ${p.indexPath}`);
      if (report.errors.length > 0) summary.push('', 'Errors:');
      for (const e of report.errors.slice(0, 8)) summary.push(`  ✗ ${e}`);
      if (report.errors.length > 8) summary.push(`  … and ${report.errors.length - 8} more (see console)`);
      new Notice(summary.join('\n'), 9000);
      console.log('[EaglePack Importer] report', report);

      if (openedIndexPath) {
        const file = vault.getAbstractFileByPath(openedIndexPath);
        if (file) {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
        }
      }
      return report;
    }

    async ensureFolder(path) {
      const { adapter } = this.app.vault;
      if (await adapter.exists(normalizePath(path))) return;
      const parts = normalizePath(path).split('/').filter(Boolean);
      let cur = '';
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        const cp = normalizePath(cur);
        if (!(await adapter.exists(cp))) {
          await this.app.vault.createFolder(cp);
        }
      }
    }

    /** Import a single parsed pack; returns per-pack counts. */
    async importOnePack(job, packRoot, options, progress) {
      const { pack } = job;
      const { vault } = this.app;
      const result = { created: 0, skipped: 0, failed: 0, notes: 0, items: 0, errors: [], indexPath: null };
      const importDateISO = new Date().toISOString();
      const indexEntries = [];
      const touched = new Set(); // vault paths written during THIS run

      // Item-type configuration (editable in Settings)
      const typesCfg = (options && options.itemTypes) || {};
      const typeGroups = typesCfg.groups || defaultTypeGroups();
      const noExtMode = typesCfg.noExt || 'auto';

      await this.ensureFolder(packRoot);

      for (const item of pack.items) {
        if (item.meta.isDeleted) {
          result.skipped += 1;
          continue;
        }
        result.items += 1;
        const label = item.meta.name || item.meta.id || 'item';
        const kind = pureApi.classifyItemKind(item.meta, typeGroups, noExtMode);
        try {
          const segs = pureApi.primaryFolderSegments(pack, item.meta, { mirrorFolders: options.mirrorFolders !== false });
          const folderPath = segs.length > 0 ? normalizePath(`${packRoot}/${segs.join('/')}`) : packRoot;
          await this.ensureFolder(folderPath);

          // ---- import the item's files ----
          // Eagle item folders may hold the original file AND generated
          // previews (*_thumbnail.png). Bookmark/webpage items in particular
          // can hold a shortcut file (e.g. *.url) next to the generated
          // preview. Import EVERY real file plus (when nothing embeddable is
          // among them) the generated preview, then display the best one.
          const realAssets = item.assets.filter((a) => !a.isThumbnail);
          const thumbAssets = item.assets.filter((a) => a.isThumbnail);
          const embeddableReal = realAssets.find((a) => pureApi.isEmbeddable(a.name));
          const previewAsset = embeddableReal || thumbAssets[0] || null;

          const filesToImport = [];
          const seenZip = new Set();
          for (const a of realAssets) {
            if (!seenZip.has(a.zipIndex)) {
              seenZip.add(a.zipIndex);
              filesToImport.push(a);
            }
          }
          // Generated preview becomes the display image only when the real
          // file(s) cannot be embedded (typical for bookmarks and design files)
          if (previewAsset && previewAsset.isThumbnail && !seenZip.has(previewAsset.zipIndex)) {
            filesToImport.push(previewAsset);
          }

          const written = []; // { asset, path }
          for (const asset of filesToImport) {
            const assetBase = sanitizeFileName(asset.name, { fallback: 'asset', max: 150 });
            const ext = extOf(assetBase);
            const base = ext ? stripExt(assetBase) : assetBase;
            let assetName = assetBase;
            let assetPath = normalizePath(`${folderPath}/${assetName}`);
            let aUnique = 0;
            // Only disambiguate against files *this run* already wrote. Files
            // that already exist on disk are either skipped (default) or
            // overwritten — never silently renamed to "(2)".
            while (touched.has(assetPath)) {
              aUnique += 1;
              assetName = ext ? `${base} (${aUnique}).${ext}` : `${base} (${aUnique})`;
              assetPath = normalizePath(`${folderPath}/${assetName}`);
            }
            let bytes;
            try {
              const u8 = await job.pack.zip.extract(asset.zipIndex);
              bytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
            } catch (extractErr) {
              result.errors.push(`${label}: asset "${asset.name}" — ${extractErr && extractErr.message ? extractErr.message : extractErr}`);
              throw extractErr;
            }
            const assetExists = await vault.adapter.exists(normalizePath(assetPath));
            if (assetExists && !options.overwrite) {
              result.skipped += 1;
            } else {
              if (assetExists && options.overwrite) await vault.adapter.remove(normalizePath(assetPath));
              await vault.createBinary(normalizePath(assetPath), bytes);
              result.created += 1;
              touched.add(assetPath);
            }
            written.push({ asset, path: assetPath });
          }

          // What the note displays: the preview asset when there is one,
          // otherwise the first real file (rendered as a plain 📎 link when it
          // cannot be embedded). Remaining files become attachment links.
          let displayEntry = null;
          if (previewAsset) displayEntry = written.find((w) => w.asset === previewAsset) || null;
          if (!displayEntry && written.length > 0) displayEntry = written[0];
          const displayPath = displayEntry ? displayEntry.path : null;
          const attachments = written
            .filter((w) => w !== displayEntry)
            .map((w) => ({ path: w.path, name: w.asset.name }));

          // ---- determine the note name (same skip semantics) ----
          const stem = sanitizeFileName(item.meta.name || item.meta.id, { fallback: 'Untitled', max: 150 }) || 'Untitled';
          let noteName = `${stem}.md`;
          let notePath = normalizePath(`${folderPath}/${noteName}`);
          let unique = 0;
          while (touched.has(notePath)) {
            unique += 1;
            noteName = `${stem} (${unique}).md`;
            notePath = normalizePath(`${folderPath}/${noteName}`);
          }

          // ---- write the item note ----
          if (options.writeItemNotes !== false) {
            const noteCtx = {
              pack,
              item,
              segs,
              kind,
              assetVaultPath: displayPath,
              assetBaseName: displayEntry ? displayEntry.asset.name : null,
              attachments,
              opts: options,
              importDateISO,
            };
            const content = pureApi.buildItemNoteContent(noteCtx);
            const noteExists = await vault.adapter.exists(normalizePath(notePath));
            if (noteExists && !options.overwrite) {
              result.skipped += 1;
            } else {
              if (noteExists && options.overwrite) await vault.adapter.remove(normalizePath(notePath));
              await vault.create(normalizePath(notePath), content);
              result.notes += 1;
              result.created += 1;
              touched.add(notePath);
            }
            indexEntries.push({
              notePath,
              metaName: item.meta.name || item.meta.id || '',
              folderSegs: segs,
              kindLabel: kind ? typeLabel(kind) : '',
              embedPath: displayPath && pureApi.isEmbeddable(displayPath) ? displayPath : null,
            });
          }
          progress(label);
        } catch (err) {
          result.failed += 1;
          result.errors.push(`${label}: ${err && err.message ? err.message : err}`);
        }
      }

      // ---- index / gallery note ----
      if (options.writeIndexNote !== false && indexEntries.length > 0) {
        const indexStem = sanitizeFileName(`${pack.displayName} — Index`, { fallback: 'Index', max: 150 });
        const indexPath = normalizePath(`${packRoot}/${indexStem}.md`);
        const indexExists = await vault.adapter.exists(normalizePath(indexPath));
        if (!indexExists || options.overwrite) {
          if (indexExists && options.overwrite) await vault.adapter.remove(normalizePath(indexPath));
          const content = pureApi.buildIndexNoteContent({
            pack,
            entries: indexEntries,
            opts: options,
            importDateISO,
          });
          await vault.create(normalizePath(indexPath), content);
          result.indexPath = indexPath;
        }
      }

      return result;
    }
  }

  return EaglePackImporter;
}

// ---------------------------------------------------------------------------
// 7. Import options modal
// ---------------------------------------------------------------------------
function buildModalCtor(obsidian) {
  const { Modal, Setting, Notice } = obsidian;
  return class ImportOptionsModal extends Modal {
    constructor(app, plugin, parsed, failures) {
      super(app);
      this.plugin = plugin;
      this.parsed = parsed;
      this.failures = failures;
      this.options = Object.assign({}, plugin.settings, {
        openAfterSingle: parsed.length === 1 ? plugin.settings.openAfterSingle : false,
      });
    }

    onOpen() {
      const { contentEl } = this;
      contentEl.empty();
      contentEl.createEl('h2', { text: 'Import EaglePack' });

      const list = contentEl.createEl('ul');
      for (const p of this.parsed) {
        const li = list.createEl('li');
        li.textContent = `${p.file.name} — ${p.pack.items.length} item(s)`;
        if (p.pack.warnings && p.pack.warnings.length > 0) {
          li.createEl('div', {
            text: `⚠ ${p.pack.warnings.slice(0, 3).join(' ')}${p.pack.warnings.length > 3 ? ` (+${p.pack.warnings.length - 3} more)` : ''}`,
            cls: 'setting-item-description',
          });
        }
      }
      if (this.failures.length > 0) {
        const warn = contentEl.createEl('p', {
          text: `⚠ ${this.failures.length} file(s) could not be parsed and were skipped: ${this.failures.map((f) => f.name).join(', ')}`,
        });
        warn.addClass('mod-warning');
      }

      new Setting(contentEl)
        .setName('Import folder')
        .setDesc('Destination folder inside your vault.')
        .addText((t) => t.setValue(this.options.importFolder).onChange((v) => {
          this.options.importFolder = v;
        }));

      new Setting(contentEl)
        .setName('Mirror Eagle folders')
        .setDesc('Recreate the Eagle folder tree under the import folder; otherwise import everything flat into one pack folder.')
        .addToggle((t) => t.setValue(this.options.mirrorFolders).onChange((v) => {
          this.options.mirrorFolders = v;
        }));

      new Setting(contentEl)
        .setName('Create item notes')
        .setDesc('Write one Markdown note per item (embedded image + metadata).')
        .addToggle((t) => t.setValue(this.options.writeItemNotes).onChange((v) => {
          this.options.writeItemNotes = v;
        }));

      new Setting(contentEl)
        .setName('Create index note')
        .setDesc('Write a pack-level gallery/index note.')
        .addToggle((t) => t.setValue(this.options.writeIndexNote).onChange((v) => {
          this.options.writeIndexNote = v;
        }));

      new Setting(contentEl)
        .setName('Use Eagle tags')
        .setDesc('Convert Eagle tags into Obsidian tags on each note.')
        .addToggle((t) => t.setValue(this.options.tagFromEagle).onChange((v) => {
          this.options.tagFromEagle = v;
        }));

      new Setting(contentEl)
        .setName('Overwrite existing files')
        .setDesc('Re-import over already-imported files. Off = skip existing files (safe).')
        .addToggle((t) => t.setValue(this.options.overwrite).onChange((v) => {
          this.options.overwrite = v;
        }));

      const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
      const importBtn = btnRow.createEl('button', { text: `Import ${this.parsed.length} file(s)`, cls: 'mod-cta' });
      const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: '' });
      cancelBtn.addEventListener('click', () => this.close());
      importBtn.addEventListener('click', async () => {
        importBtn.disabled = true;
        importBtn.textContent = 'Importing…';
        this.close();
        try {
          await this.plugin.runImport(this.parsed, this.options);
        } catch (err) {
          new Notice(`EaglePack Importer failed: ${err && err.message ? err.message : err}`, 8000);
          console.error('[EaglePack Importer]', err);
        }
      });
    }

    onClose() {
      this.contentEl.empty();
    }
  };
}

// ---------------------------------------------------------------------------
// 8. Settings tab
// ---------------------------------------------------------------------------
function buildSettingTabCtor(obsidian) {
  const { PluginSettingTab, Setting } = obsidian;
  return class EaglePackImporterSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    display() {
      const { containerEl } = this;
      containerEl.empty();
      containerEl.createEl('h2', { text: 'EaglePack Importer settings' });
      containerEl.createEl('p', {
        text: 'Import Eagle (eagle.cool) EaglePack export files into your vault. Each item becomes a Markdown note with the original asset embedded, plus a gallery/index note per pack.',
      });

      new Setting(containerEl)
        .setName('Default import folder')
        .setDesc('Where imported packs are placed inside your vault (can be overridden per import).')
        .addText((text) => text
          .setPlaceholder('Eagle Imports')
          .setValue(this.plugin.settings.importFolder)
          .onChange(async (value) => {
            this.plugin.settings.importFolder = (value || '').trim() || 'Eagle Imports';
            await this.plugin.saveData(this.plugin.settings);
          }));

      new Setting(containerEl)
        .setName('Mirror Eagle folders')
        .setDesc('Recreate the Eagle folder structure under the import folder (off = import flat).')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.mirrorFolders)
          .onChange(async (value) => {
            this.plugin.settings.mirrorFolders = value;
            await this.plugin.saveData(this.plugin.settings);
          }));

      new Setting(containerEl)
        .setName('Create item notes')
        .setDesc('Write one Markdown note per item.')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.writeItemNotes)
          .onChange(async (value) => {
            this.plugin.settings.writeItemNotes = value;
            await this.plugin.saveData(this.plugin.settings);
          }));

      new Setting(containerEl)
        .setName('Create pack index note')
        .setDesc('Write a gallery/index note at the top of each imported pack folder.')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.writeIndexNote)
          .onChange(async (value) => {
            this.plugin.settings.writeIndexNote = value;
            await this.plugin.saveData(this.plugin.settings);
          }));

      new Setting(containerEl)
        .setName('Use Eagle tags')
        .setDesc('Import Eagle tags as Obsidian tags on each note.')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.tagFromEagle)
          .onChange(async (value) => {
            this.plugin.settings.tagFromEagle = value;
            await this.plugin.saveData(this.plugin.settings);
          }));

      new Setting(containerEl)
        .setName('Open index after single import')
        .setDesc('Open the generated index note when importing a single file.')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.openAfterSingle)
          .onChange(async (value) => {
            this.plugin.settings.openAfterSingle = value;
            await this.plugin.saveData(this.plugin.settings);
          }));

      new Setting(containerEl)
        .setName('Overwrite existing files')
        .setDesc('When files already exist at the destination, overwrite them instead of skipping.')
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.overwrite)
          .onChange(async (value) => {
            this.plugin.settings.overwrite = value;
            await this.plugin.saveData(this.plugin.settings);
          }));

      containerEl.createEl('h3', { text: 'Item types' });
      containerEl.createEl('p', {
        text: 'Decide which file extensions are treated as Bookmarks, Images, Videos, Audio, Documents, Fonts or Archives (everything unlisted becomes "Other"). Each imported note shows this type, and Bookmark items use the link + preview layout. Leave a field empty to fall back to the defaults shown as placeholders.',
        cls: 'setting-item-description',
      });

      const typeDesc = {
        bookmark: 'e.g. url webloc website (webpages saved from a URL usually have no file type at all)',
        image: 'e.g. png jpg jpeg gif webp svg bmp avif',
        video: 'e.g. mp4 webm mov mkv avi',
        audio: 'e.g. mp3 wav ogg flac m4a aac',
        document: 'e.g. pdf doc docx txt md html ai psd sketch',
        font: 'e.g. ttf otf woff woff2 eot',
        archive: 'e.g. zip rar 7z tar gz dmg iso',
      };
      for (const key of ITEM_KIND_ORDER) {
        if (key === 'other') continue; // catch-all group, not editable
        const defaults = (defaultTypeGroups()[key] || []).join(' ');
        new Setting(containerEl)
          .setName(ITEM_TYPE_LABELS[key])
          .setDesc(typeDesc[key] ? typeDesc[key] : `Extensions treated as ${ITEM_TYPE_LABELS[key]}.`)
          .addText((text) => text
            .setPlaceholder(defaults || '(empty)')
            .setValue((this.plugin.settings.itemTypes.groups[key] || []).join(' '))
            .onChange(async (value) => {
              this.plugin.settings.itemTypes.groups[key] = parseExtList(value);
              await this.plugin.saveData(this.plugin.settings);
            }));
      }

      new Setting(containerEl)
        .setName('Items without a file type')
        .setDesc('Items whose metadata has no extension (typical for web bookmarks) are classified with this rule. "Auto" = URL items become Bookmarks, everything else Other.')
        .addDropdown((dropdown) => {
          dropdown.addOption('auto', 'Auto — URL items → Bookmark, others → Other');
          for (const key of ITEM_KIND_ORDER) {
            if (key === 'other') continue;
            dropdown.addOption(key, `Always ${ITEM_TYPE_LABELS[key]}`);
          }
          dropdown.addOption('other', 'Always Other');
          dropdown.setValue(this.plugin.settings.itemTypes.noExt || 'auto');
          dropdown.onChange(async (value) => {
            this.plugin.settings.itemTypes.noExt = value;
            await this.plugin.saveData(this.plugin.settings);
          });
        });

      new Setting(containerEl)
        .setName('Reset item types')
        .setDesc('Restore the default extension groups and the default "no file type" rule.')
        .addButton((button) => button.setButtonText('Reset to defaults').onClick(async () => {
          this.plugin.settings.itemTypes = mergeItemTypeSettings(null, null);
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        }));

      containerEl.createEl('p', {
        text: 'Understood formats: .eaglepack and .zip archives containing an Eagle library layout (metadata.json + images/*.info) or an EaglePack layout (pack.json + *.info folders). Only store/deflate ZIP compression is supported; ZIP64 is not.',
        cls: 'setting-item-description',
      });
    }
  };
}

// ---------------------------------------------------------------------------
// 9. Module export (Obsidian loads the class; Node loads the pure API)
// ---------------------------------------------------------------------------
if (obsidianLib) {
  ImportOptionsModalCtor = buildModalCtor(obsidianLib);
  EaglePackImporterSettingTabCtor = buildSettingTabCtor(obsidianLib);
  const Cls = createPlugin(obsidianLib.Plugin);
  Cls.pureApi = pureApi; // exposed for tests
  module.exports = Cls;
} else {
  module.exports = pureApi;
}
