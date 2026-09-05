/*
 * Test-fixture generator for EaglePack Importer.
 * Builds real ZIP archives (store + deflate) that mimic the two on-disk
 * layouts produced by Eagle / EaglePack tools, and re-exports them as
 * ArrayBuffers so the plugin's pure parser can be exercised under Node.
 */
import zlib from 'node:zlib';

const encoder = new TextEncoder();

// --- CRC32 (standard, used by ZIP) -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer.
 * @param {Array<{path: string, data: Uint8Array|string, store?: boolean}>} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const en of entries) {
    const nameBytes = encoder.encode(en.path);
    const data = typeof en.data === 'string' ? encoder.encode(en.data) : en.data;
    const store = en.store === true;
    const crc = crc32(data);
    const body = store ? data : zlib.deflateRawSync(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // general purpose flag: UTF-8 names
    lfh.writeUInt16LE(store ? 0 : 8, 8); // compression method
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    const local = Buffer.concat([lfh, nameBytes, body]);
    chunks.push(local);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // flags
    cdh.writeUInt16LE(store ? 0 : 8, 10); // method
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cdh, nameBytes]));

    offset += local.length;
  }

  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);

  return new Uint8Array(Buffer.concat([...chunks, cd, eocd]));
}

/** Convert a Uint8Array into an ArrayBuffer the parser accepts. */
export function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

const FAKE_JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const FAKE_MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

const ITEM_1_META = {
  id: 'AAA111BBB222',
  name: 'photo dog',
  size: 63785,
  btime: 1756571097667,
  mtime: 1756571097667,
  ext: 'jpg',
  tags: ['Animal', 'Bird', 'UI Design'],
  folders: ['F2DOG'], // nested under animal
  isDeleted: false,
  url: 'https://example.com/dog',
  annotation: 'A lovely dog photo.\nSecond line.',
  modificationTime: 1760228118908,
  height: 960,
  width: 640,
  noThumbnail: true,
  lastModified: 1760409426491,
  star: 4,
  palettes: [
    { color: [221, 218, 210], ratio: 51 },
    { color: [170, 148, 109], ratio: 16 },
  ],
};

const ITEM_2_META = {
  id: 'BBB222CCC333',
  name: 'clip',
  ext: 'mp4',
  size: 999999,
  tags: ['video'],
  folders: ['F1VIDEO'],
  isDeleted: false,
  url: '',
  annotation: '',
  width: 1920,
  height: 1080,
  star: 0,
};

const ITEM_3_META = {
  id: 'CCC333DDD444',
  name: 'bookmark note',
  ext: 'png',
  tags: [],
  folders: ['F2DOG'],
  isDeleted: false,
  url: 'https://example.com/page',
  annotation: 'Just a bookmark with a preview.',
};

const LIBRARY_HEADER = {
  name: 'My Eagle Library',
  folders: [
    {
      id: 'F1VIDEO',
      name: 'video',
      description: '',
      children: [],
      modificationTime: 1759876345810,
      tags: [],
      password: '',
      passwordTips: '',
    },
    {
      id: 'F2DOG_PARENT',
      name: 'animal',
      description: '',
      children: [
        {
          id: 'F2DOG',
          name: 'dog',
          description: '',
          children: [],
          modificationTime: 1760228305814,
          tags: [],
          password: '',
          passwordTips: '',
          coverId: 'AAA111BBB222',
          orderBy: 'MANUAL',
          sortIncrease: true,
        },
      ],
      modificationTime: 1759876356012,
      tags: [],
      password: '',
      passwordTips: '',
    },
  ],
  smartFolders: [],
  quickAccess: [],
  tagsGroups: [],
  modificationTime: 1760231728179,
  applicationVersion: '4.0.0',
};

const MTIME = {
  AAA111BBB222: 1760228119055,
  BBB222CCC333: 1760228120055,
  CCC333DDD444: 1760228121055,
  all: 3,
};

/**
 * Fixture 1 — an Eagle library zipped as-is (the "library layout"),
 * optionally nested under a top-level prefix folder.
 */
export function libraryFixture(prefix) {
  const p = (rel) => (prefix ? `${prefix}/${rel}` : rel);
  const entries = [
    { path: p('metadata.json'), data: JSON.stringify(LIBRARY_HEADER) },
    { path: p('mtime.json'), data: JSON.stringify(MTIME) },
    { path: p(`images/${ITEM_1_META.id}.info/metadata.json`), data: JSON.stringify(ITEM_1_META) },
    { path: p(`images/${ITEM_1_META.id}.info/photo dog.jpg`), data: FAKE_JPG, store: true },
    { path: p(`images/${ITEM_1_META.id}.info/photo dog_thumbnail.png`), data: FAKE_PNG, store: true },
    { path: p(`images/${ITEM_2_META.id}.info/metadata.json`), data: JSON.stringify(ITEM_2_META) },
    { path: p(`images/${ITEM_2_META.id}.info/clip.mp4`), data: FAKE_MP4 },
    { path: p(`images/${ITEM_3_META.id}.info/metadata.json`), data: JSON.stringify(ITEM_3_META) },
  ];
  return toArrayBuffer(buildZip(entries));
}

/**
 * Fixture 2 — the EaglePack "pack layout": pack.json plus <id>.info folders
 * (the layout produced by Eagle-compatible pack exporters). pack.json mirrors
 * the item list, so the parser must de-duplicate against per-folder metadata.
 */
export function packFixture() {
  const entries = [
    {
      path: 'pack.json',
      data: JSON.stringify({ images: [ITEM_1_META, ITEM_2_META, ITEM_3_META] }),
    },
    { path: `${ITEM_1_META.id}.info/metadata.json`, data: JSON.stringify(ITEM_1_META) },
    { path: `${ITEM_1_META.id}.info/photo dog.jpg`, data: FAKE_JPG, store: true },
    { path: `${ITEM_1_META.id}.info/photo dog_thumbnail.png`, data: FAKE_PNG, store: true },
    { path: `${ITEM_2_META.id}.info/metadata.json`, data: JSON.stringify(ITEM_2_META) },
    { path: `${ITEM_2_META.id}.info/clip.mp4`, data: FAKE_MP4 },
    { path: `${ITEM_3_META.id}.info/metadata.json`, data: JSON.stringify(ITEM_3_META) },
  ];
  return toArrayBuffer(buildZip(entries));
}

/**
 * Fixture 3 — pack.json only, no per-folder metadata.json (edge case: the
 * exporter that created sdweb-eaglepack style packs always wrote both, but a
 * folder-only fallback must still work).
 */
export function packJsonOnlyFixture() {
  const entries = [
    {
      path: 'pack.json',
      data: JSON.stringify({ name: 'Pictures Only', images: [ITEM_1_META] }),
    },
    { path: `${ITEM_1_META.id}.info/photo dog.jpg`, data: FAKE_JPG, store: true },
  ];
  return toArrayBuffer(buildZip(entries));
}

const BOOKMARK_META = {
  id: 'W1B2C3D4E5F6',
  name: 'Web Design Ideas',
  size: 0,
  btime: 1756000000000,
  mtime: 1756000000000,
  ext: '',
  tags: ['inspiration', 'web design'],
  folders: ['F2DOG'],
  isDeleted: false,
  url: 'https://example.com/design-inspiration',
  annotation: 'Saved webpage with Eagle.',
  modificationTime: 1760000000000,
  width: 1280,
  height: 800,
  noThumbnail: false,
  star: 5,
};

/**
 * Fixture 4 — a bookmark/webpage item (metadata with url, no original file).
 * `withPreview` adds the generated preview image Eagle stores for such items.
 */
export function bookmarkFixture(withPreview) {
  const entries = [
    { path: 'pack.json', data: JSON.stringify({ images: [BOOKMARK_META] }) },
    { path: `${BOOKMARK_META.id}.info/metadata.json`, data: JSON.stringify(BOOKMARK_META) },
  ];
  if (withPreview) {
    entries.push({
      path: `${BOOKMARK_META.id}.info/Web Design Ideas_thumbnail.png`,
      data: FAKE_PNG,
      store: true,
    });
  }
  return toArrayBuffer(buildZip(entries));
}

/**
 * Fixture 4b — like bookmarkFixture(true), but the item folder also holds a
 * Windows URL shortcut next to the preview. Eagle stores such a file for some
 * web bookmarks; the importer must import BOTH but display the preview image.
 */
export function bookmarkShortcutFixture() {
  const entries = [
    { path: 'pack.json', data: JSON.stringify({ images: [BOOKMARK_META] }) },
    { path: `${BOOKMARK_META.id}.info/metadata.json`, data: JSON.stringify(BOOKMARK_META) },
    {
      path: `${BOOKMARK_META.id}.info/Web Design Ideas.url`,
      data: '[InternetShortcut]\nURL=https://example.com/design-inspiration',
      store: true,
    },
    {
      path: `${BOOKMARK_META.id}.info/Web Design Ideas_thumbnail.png`,
      data: FAKE_PNG,
      store: true,
    },
  ];
  return toArrayBuffer(buildZip(entries));
}

export const SAMPLE_BYTES = { FAKE_JPG, FAKE_PNG, FAKE_MP4 };
export { ITEM_1_META, ITEM_2_META, ITEM_3_META, LIBRARY_HEADER, BOOKMARK_META };
