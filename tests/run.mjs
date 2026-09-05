/*
 * Node tests for the pure logic of the EaglePack Importer plugin.
 * Run with: npm test   (node --test tests/run.mjs)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  libraryFixture,
  packFixture,
  packJsonOnlyFixture,
  bookmarkFixture,
  bookmarkShortcutFixture,
  toArrayBuffer,
  SAMPLE_BYTES,
  ITEM_1_META,
  ITEM_2_META,
  BOOKMARK_META,
} from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const api = require(path.join(__dirname, '..', 'main.js'));

const {
  openZip,
  readEntryText,
  parseEaglePackBuffer,
  normalizeItem,
  classifyJsonObject,
  sanitizeFileName,
  extOf,
  isThumbnailName,
  obsidianTags,
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
  buildItemNoteContent,
  buildIndexNoteContent,
  stripExt,
  basenameOf,
} = api;

// ---------------------------------------------------------------------------

test('module exposes the pure API (runs without Obsidian)', () => {
  assert.equal(typeof parseEaglePackBuffer, 'function');
  assert.equal(typeof openZip, 'function');
  assert.equal(typeof buildItemNoteContent, 'function');
});

test('zip reader parses entries and round-trips store + deflate content', async () => {
  const fixture = await import('./fixtures.mjs');
  const buf = fixture.packFixture();
  const zip = openZip(buf);
  const names = zip.entries.map((e) => e.name);
  assert.ok(names.includes('pack.json'));
  assert.ok(names.includes(`${ITEM_1_META.id}.info/metadata.json`));
  assert.ok(names.includes(`${ITEM_1_META.id}.info/photo dog.jpg`));

  // pick entries and verify content integrity for both compression methods
  for (const entry of zip.entries) {
    if (entry.isDir) continue;
    if (entry.name.endsWith('.jpg')) {
      const out = await zip.extract(entry.index);
      assert.deepEqual(Array.from(out), Array.from(SAMPLE_BYTES.FAKE_JPG));
    }
    if (entry.name.endsWith('.mp4')) {
      const out = await zip.extract(entry.index);
      assert.deepEqual(Array.from(out), Array.from(SAMPLE_BYTES.FAKE_MP4));
    }
    if (entry.name === 'pack.json') {
      const text = await readEntryText(zip, entry.index);
      assert.equal(JSON.parse(text).images.length, 3);
    }
  }
});

test('classification: item vs library vs pack headers', () => {
  assert.equal(classifyJsonObject(normalizeItem({ id: 'X1', ext: 'png' })), 'item');
  assert.equal(classifyJsonObject({ id: 'X1', name: 'x' }), 'item');
  assert.equal(classifyJsonObject({ folders: [], smartFolders: [] }), 'library');
  assert.equal(classifyJsonObject({ images: [] }), 'pack');
  assert.equal(classifyJsonObject({ name: 'wat' }), 'other');
  assert.equal(classifyJsonObject(null), 'other');
  assert.equal(classifyJsonObject([1, 2]), 'other');
});

test('fixture 1 (library layout): items, assets, folders and thumbnails', async () => {
  const pack = await parseEaglePackBuffer(libraryFixture(''), 'photo-library.eaglepack');
  assert.equal(pack.displayName, 'My Eagle Library');
  assert.equal(pack.hasLibraryHeader, true);
  assert.equal(pack.items.length, 3);

  const dog = pack.items.find((i) => i.meta.id === ITEM_1_META.id);
  assert.ok(dog);
  assert.equal(dog.meta.name, 'photo dog');
  assert.equal(dog.meta.ext, 'jpg');
  assert.equal(dog.meta.annotation.includes('lovely'), true);
  assert.deepEqual(dog.meta.folders, ['F2DOG']);

  // primary asset first (exact name+ext match beats the thumbnail)
  assert.equal(dog.assets[0].name, 'photo dog.jpg');
  assert.ok(dog.assets.some((a) => a.name === 'photo dog_thumbnail.png' && a.isThumbnail));

  // folder tree mapping
  assert.ok(pack.folderById.has('F1VIDEO'));
  assert.equal(pack.folderById.get('F2DOG').parentId, 'F2DOG_PARENT');
  assert.equal(pack.folderName('F2DOG'), 'dog');
});

test('placement mirrors the Eagle folder tree (nested)', async () => {
  const pack = await parseEaglePackBuffer(libraryFixture(''), 'x.eaglepack');
  const dog = pack.items.find((i) => i.meta.id === ITEM_1_META.id);
  const segs = primaryFolderSegments(pack, dog.meta, { mirrorFolders: true });
  assert.deepEqual(segs, ['animal', 'dog']);
  assert.deepEqual(folderLabels(pack, dog.meta), ['animal / dog']);

  const video = pack.items.find((i) => i.meta.id === ITEM_2_META.id);
  assert.deepEqual(primaryFolderSegments(pack, video.meta, { mirrorFolders: true }), ['video']);

  // flat mode returns no folder segments
  assert.deepEqual(primaryFolderSegments(pack, dog.meta, { mirrorFolders: false }), []);
});

test('fixture 2 (pack layout): pack.json + .info folders with de-dup', async () => {
  const pack = await parseEaglePackBuffer(packFixture(), 'assets.eaglepack');
  assert.equal(pack.hasPackJson, true);
  // ITEM_3 has no asset files -> still present (metadata-only item)
  assert.equal(pack.items.length, 3);
  const ids = pack.items.map((i) => i.meta.id);
  assert.ok(ids.includes(ITEM_1_META.id));
  assert.ok(ids.includes(ITEM_2_META.id));

  const dog = pack.items.find((i) => i.meta.id === ITEM_1_META.id);
  assert.equal(dog.assets[0].name, 'photo dog.jpg');
});

test('fixture 3 (pack.json only, no folder metadata.json)', async () => {
  const pack = await parseEaglePackBuffer(packJsonOnlyFixture(), 'pics.eaglepack');
  assert.equal(pack.displayName, 'Pictures Only');
  assert.equal(pack.items.length, 1);
  const item = pack.items[0];
  assert.equal(item.meta.id, ITEM_1_META.id);
  assert.equal(item.assets[0].name, 'photo dog.jpg');
});

test('nested library layout under a prefix folder parses identically', async () => {
  const pack = await parseEaglePackBuffer(libraryFixture('MyLibrary'), 'nested.eaglepack');
  assert.equal(pack.items.length, 3);
  const dog = pack.items.find((i) => i.meta.id === ITEM_1_META.id);
  assert.ok(dog.sourceDir.endsWith(`${ITEM_1_META.id}.info`));
});

test('rejects non-zip content', async () => {
  const junk = toArrayBuffer(new TextEncoder().encode('this is definitely not a zip file at all'));
  await assert.rejects(() => parseEaglePackBuffer(junk, 'bad.eaglepack'), /ZIP/);
});

test('sanitizeFileName handles unsafe + reserved names', () => {
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('a<b>c*d:e|f?g'), 'a b c d e f g');
  assert.equal(sanitizeFileName('  spaced  out  '), 'spaced out');
  assert.equal(sanitizeFileName('icon [v2] #2 ^note'), 'icon v2 2 note');
  assert.equal(sanitizeFileName(''), 'Untitled');
  assert.equal(sanitizeFileName('x'.repeat(300)).length <= 180, true);
  assert.equal(sanitizeFileName('a/b\\c'), 'a b c');
});

test('name helpers', () => {
  assert.equal(extOf('photo dog.jpg'), 'jpg');
  assert.equal(extOf('noext'), '');
  assert.equal(stripExt('photo dog.jpg'), 'photo dog');
  assert.equal(basenameOf('a/b/c.txt'), 'c.txt');
  assert.equal(isThumbnailName('x_thumbnail.png'), true);
  assert.equal(isThumbnailName('x.png'), false);
});

test('obsidianTags normalizes Eagle tags', () => {
  assert.deepEqual(obsidianTags(['UI Design', 'Foo/Bar', '#hash', 'x_y']), ['UI-Design', 'Foo-Bar', 'hash', 'x-y']);
});

test('item note markdown: frontmatter + embed + metadata', () => {
  const pack = { displayName: 'My Eagle Library', sourceFileName: 'x.eaglepack', folderById: new Map() };
  const item = { meta: normalizeItem(ITEM_1_META), assets: [{ name: 'photo dog.jpg' }] };
  const content = buildItemNoteContent({
    pack,
    item,
    segs: ['animal', 'dog'],
    assetVaultPath: 'Eagle Imports/My Eagle Library/animal/dog/photo dog.jpg',
    assetBaseName: 'photo dog.jpg',
    opts: { tagFromEagle: true },
    importDateISO: '2025-01-01T00:00:00.000Z',
  });
  assert.ok(content.startsWith('---\n'));
  assert.ok(content.includes('eagle:'));
  assert.ok(content.includes('id: "AAA111BBB222"'));
  assert.ok(content.includes('tags: ["Animal", "Bird", "UI-Design"]'));
  assert.ok(content.includes('![[Eagle Imports/My Eagle Library/animal/dog/photo dog.jpg]]'));
  assert.ok(content.includes('# photo dog'));
  assert.ok(content.includes('# photo dog <span class="ep-kind">Image</span>'), 'type badge must sit next to the title');
  assert.ok(content.includes('### Metadata'));
  assert.ok(content.includes('> A lovely dog photo.'));
  assert.ok(content.includes('ep-swatch'));
  // kind classification: JPG → Image, shown in YAML and on the Type line
  assert.ok(content.includes('kind: "image"'));
  assert.ok(content.includes('- **Type:** Image (JPG)'));
  // a real image that merely has a source url is NOT a bookmark: image first,
  // url listed under Metadata, no leading 🔗 block
  assert.equal(isBookmarkItem(item), false);
  assert.ok(content.includes('- **Source:** [https://example.com/dog](https://example.com/dog)'));
  assert.ok(!content.includes('🔗 ['));
});

test('index note markdown groups by folder and links + embeds items', () => {
  const pack = { displayName: 'My Eagle Library', sourceFileName: 'x.eaglepack' };
  const entries = [
    {
      notePath: 'Eagle Imports/My Eagle Library/animal/dog/photo dog.md',
      metaName: 'photo dog',
      folderSegs: ['animal', 'dog'],
      kindLabel: 'Image',
      embedPath: 'Eagle Imports/My Eagle Library/animal/dog/photo dog.jpg',
    },
    {
      notePath: 'Eagle Imports/My Eagle Library/video/clip.md',
      metaName: 'clip',
      folderSegs: ['video'],
      kindLabel: 'Video',
      embedPath: null,
    },
  ];
  const md = buildIndexNoteContent({
    pack,
    entries,
    opts: { thumbWidth: 180 },
    importDateISO: '2025-01-01T00:00:00.000Z',
  });
  assert.ok(md.includes('# My Eagle Library — EaglePack index'));
  assert.ok(md.includes('## animal / dog'));
  assert.ok(md.includes('## video'));
  assert.ok(md.includes('![[Eagle Imports/My Eagle Library/animal/dog/photo dog.jpg|180]]'));
  assert.ok(md.includes('[[Eagle Imports/My Eagle Library/video/clip.md|clip]]'));

  // type of each item is shown right next to its title
  assert.ok(md.includes('<span class="ep-kind">Image</span>'), 'item type must appear next to the title');
  assert.ok(md.includes('[[Eagle Imports/My Eagle Library/video/clip.md|clip]] <span class="ep-kind">Video</span>'));

  // the item preview sits on its own line *below* its title (not on the same line)
  const boldTitle = md.indexOf('**[[Eagle Imports/My Eagle Library/animal/dog/photo dog.md|photo dog]]**');
  const embed = md.indexOf('![[Eagle Imports/My Eagle Library/animal/dog/photo dog.jpg|180]]');
  assert.ok(boldTitle >= 0, 'title must be present as its own bold line');
  assert.ok(embed > boldTitle, 'embed must come after the title');
  const between = md.slice(boldTitle, embed);
  assert.ok(!between.includes(' — '), 'title and embed must not share a line');
});

test('deleted items are parsed but excluded from the importable list by flag', async () => {
  const pack = await parseEaglePackBuffer(libraryFixture(''), 'x.eaglepack');
  const del = pack.items.find((i) => i.meta.isDeleted);
  assert.equal(del, undefined); // none deleted in fixture; sanity check
  // ensure all items are flagged correctly
  for (const item of pack.items) assert.equal(item.meta.isDeleted, false);
});

test('zip entries with UTF-8 (non-ASCII) names survive parsing', async () => {
  const fixture = await import('./fixtures.mjs');
  // build a small inline archive with an accented/CJK filename
  const { buildZip, toArrayBuffer: t2ab } = fixture;
  const buf = t2ab(buildZip([
    { path: 'pack.json', data: JSON.stringify({ images: [] }) },
    { path: 'AB1C2D3E4F5G.info/metadata.json', data: JSON.stringify({ id: 'AB1C2D3E4F5G', name: 'café 東京', ext: 'png' }) },
    { path: 'AB1C2D3E4F5G.info/café 東京.png', data: new Uint8Array([1, 2, 3, 4]), store: true },
  ]));
  const pack = await parseEaglePackBuffer(buf, 'utf8.eaglepack');
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].meta.name, 'café 東京');
  assert.equal(pack.items[0].assets[0].name, 'café 東京.png');
});

test('bookmark items (url + no original file) are detected as bookmarks', async () => {
  const pack = await parseEaglePackBuffer(bookmarkFixture(true), 'links.eaglepack');
  assert.equal(pack.items.length, 1);
  const item = pack.items[0];
  assert.equal(item.meta.id, BOOKMARK_META.id);
  assert.equal(item.meta.url, 'https://example.com/design-inspiration');
  assert.equal(isBookmarkItem(item), true);
  // the only sibling file is the generated preview
  assert.ok(item.assets.length === 1 && item.assets[0].isThumbnail === true);
});

test('bookmark note: link first, preview image below the link', () => {
  const pack = { displayName: 'Links', sourceFileName: 'links.eaglepack', folderById: new Map() };
  const item = {
    meta: normalizeItem(BOOKMARK_META),
    assets: [{ name: 'Web Design Ideas_thumbnail.png', isThumbnail: true }],
  };
  const content = buildItemNoteContent({
    pack,
    item,
    segs: [],
    assetVaultPath: 'Eagle Imports/Links/Web Design Ideas_thumbnail.png',
    assetBaseName: 'Web Design Ideas_thumbnail.png',
    opts: { tagFromEagle: true },
    importDateISO: '2025-01-01T00:00:00.000Z',
  });
  assert.ok(content.includes('# Web Design Ideas'));
  const linkAt = content.indexOf('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)');
  const embedAt = content.indexOf('![[Eagle Imports/Links/Web Design Ideas_thumbnail.png]]');
  assert.ok(linkAt >= 0, 'bookmark must show its source link');
  assert.ok(embedAt > linkAt, 'preview image must come below the link');
  // no duplicated Source bullet since the link is already prominent
  assert.ok(!content.includes('- **Source:**'));
});

test('bookmark note without a preview still shows the link (no broken embed)', () => {
  const pack = { displayName: 'Links', sourceFileName: 'links.eaglepack', folderById: new Map() };
  const item = { meta: normalizeItem(BOOKMARK_META), assets: [] };
  const content = buildItemNoteContent({
    pack,
    item,
    segs: [],
    assetVaultPath: null,
    assetBaseName: null,
    opts: { tagFromEagle: false },
    importDateISO: '2025-01-01T00:00:00.000Z',
  });
  assert.ok(content.includes('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)'));
  assert.ok(!content.includes('![[Eagle Imports/Links/Web Design Ideas_thumbnail.png]]'));
});

test('bookmark item with a .url shortcut next to its preview: both files import, preview displays, .url is an attachment', async () => {
  // parse-level: the folder yields two assets — the shortcut (real, non-media)
  // and the generated preview (thumbnail)
  const pack = await parseEaglePackBuffer(bookmarkShortcutFixture(), 'links.eaglepack');
  assert.equal(pack.items.length, 1);
  const item = pack.items[0];
  assert.equal(item.assets.length, 2);
  assert.ok(item.assets.some((a) => a.name.endsWith('.url') && !a.isThumbnail));
  assert.ok(item.assets.some((a) => a.name.endsWith('_thumbnail.png') && a.isThumbnail));
  // the .url shortcut is NOT media content, so this stays a bookmark item
  assert.equal(isBookmarkItem(item), true);

  // note-level: preview is embedded below the link, shortcut listed as attachment
  const ctx = {
    pack: { displayName: 'Links', sourceFileName: 'links.eaglepack', folderById: new Map() },
    item,
    segs: [],
    assetVaultPath: 'Eagle Imports/Links/Web Design Ideas_thumbnail.png',
    assetBaseName: 'Web Design Ideas_thumbnail.png',
    attachments: [{ path: 'Eagle Imports/Links/Web Design Ideas.url', name: 'Web Design Ideas.url' }],
    opts: { tagFromEagle: true },
    importDateISO: '2025-01-01T00:00:00.000Z',
  };
  const content = buildItemNoteContent(ctx);
  const linkAt = content.indexOf('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)');
  const embedAt = content.indexOf('![[Eagle Imports/Links/Web Design Ideas_thumbnail.png]]');
  assert.ok(linkAt >= 0);
  assert.ok(embedAt > linkAt, 'thumbnail must render below the bookmark link');
  assert.ok(content.includes('- 📎 [[Eagle Imports/Links/Web Design Ideas.url|Web Design Ideas.url (URL)]]'));
  assert.ok(content.includes('### Attachments'));
});

test('default type groups classify common extensions', () => {
  const d = defaultTypeGroups();
  for (const key of ITEM_KIND_ORDER) {
    assert.ok(Array.isArray(d[key]), `group ${key} must exist`);
  }
  assert.ok(d.image.includes('jpg') && d.image.includes('png'));
  assert.ok(d.video.includes('mp4'));
  assert.ok(d.audio.includes('mp3'));
  assert.ok(d.font.includes('ttf'));
  assert.equal(typeOfExtension('jpg', d), 'image');
  assert.equal(typeOfExtension('MP4', d), 'video'); // case-insensitive
  assert.equal(typeOfExtension('zzz-not-real', d), 'other'); // unlisted → other
  assert.equal(typeOfExtension('', d), null);
  assert.equal(typeLabel('audio'), 'Audio');
});

test('editable extension→type groups change the classification', () => {
  const custom = {
    bookmark: ['png', 'url'],
    image: [],
    video: ['mp4'],
    audio: [],
    document: [],
    font: [],
    archive: [],
    other: [],
  };
  // png moved into Bookmark → the item is a bookmark even though it is an image file
  assert.equal(classifyItemKind({ ext: 'png', url: 'https://x' }, custom, 'auto'), 'bookmark');
  assert.equal(classifyItemKind({ ext: 'mp4' }, custom, 'auto'), 'video');
  assert.equal(classifyItemKind({ ext: 'psd' }, custom, 'auto'), 'other');
  // extension-less items follow the "no file type" rule
  assert.equal(classifyItemKind({ ext: '', url: 'https://x' }, custom, 'auto'), 'bookmark');
  assert.equal(classifyItemKind({ ext: '', url: '' }, custom, 'auto'), 'other');
  assert.equal(classifyItemKind({ ext: '', url: 'https://x' }, custom, 'image'), 'image');
  assert.equal(classifyItemKind({ ext: '', url: '' }, custom, 'audio'), 'audio');
});

test('URL items classify as Bookmark — never Other — unless explicitly grouped elsewhere', () => {
  const d = defaultTypeGroups();
  // default group ships bookmark shortcut extensions
  assert.ok(d.bookmark.includes('url'));
  assert.equal(classifyItemKind({ ext: 'url', url: 'https://x' }, d, 'auto'), 'bookmark');
  assert.equal(classifyItemKind({ ext: 'webloc', url: 'https://x' }, d, 'auto'), 'bookmark');
  // unknown/unlisted extension + source URL → Bookmark, not Other
  assert.equal(classifyItemKind({ ext: 'design', url: 'https://x' }, d, 'auto'), 'bookmark');
  assert.equal(classifyItemKind({ ext: 'xyzzy', url: 'https://x' }, d, 'auto'), 'bookmark');
  // unknown extension without a URL stays Other
  assert.equal(classifyItemKind({ ext: 'xyzzy', url: '' }, d, 'auto'), 'other');
  // explicit type groups still win over the URL rule
  assert.equal(classifyItemKind({ ext: 'mp4', url: 'https://x' }, d, 'auto'), 'video');
  assert.equal(classifyItemKind({ ext: 'pdf', url: 'https://x' }, d, 'auto'), 'document');
  assert.equal(classifyItemKind({ ext: 'png', url: 'https://x' }, d, 'auto'), 'image');
  // a user mapping that moves an unlisted extension to another group also wins
  const custom = mergeItemTypeSettings({ groups: { image: ['png', 'jpg', 'xyzzy'] } }, d);
  assert.equal(classifyItemKind({ ext: 'xyzzy', url: 'https://x' }, custom.groups, custom.noExt), 'image');
  // ...unless the user puts it into the bookmark group explicitly
  const customBm = mergeItemTypeSettings({ groups: { bookmark: ['xyzzy'] } }, d);
  assert.equal(classifyItemKind({ ext: 'xyzzy', url: '' }, customBm.groups, customBm.noExt), 'bookmark');
});

test('parseExtList + mergeItemTypeSettings normalize user input', () => {
  assert.deepEqual(parseExtList('png jpg, webp;SVG   *.bmp  png'), ['png', 'jpg', 'webp', 'svg', 'bmp']);
  const d = defaultTypeGroups();
  const merged = mergeItemTypeSettings({ groups: { image: ['foo', 'jpg'] }, noExt: 'video' }, d);
  assert.deepEqual(merged.groups.image, ['foo', 'jpg']);
  assert.deepEqual(merged.groups.font, d.font); // untouched groups keep defaults
  assert.equal(merged.noExt, 'video');
  // invalid input degrades gracefully
  const bad = mergeItemTypeSettings({ groups: null, noExt: 'nope' }, d);
  assert.deepEqual(bad.groups, d);
  assert.equal(bad.noExt, 'auto');
});

test('note layout follows the classified kind passed by the importer', () => {
  // A .url shortcut + thumbnail item forced to "Bookmark" kind uses the
  // link-first layout even though a legacy file-based heuristic might not.
  const pack = { displayName: 'Links', sourceFileName: 'links.eaglepack', folderById: new Map() };
  const item = { meta: normalizeItem(BOOKMARK_META), assets: [] };
  const base = {
    pack,
    item,
    segs: [],
    assetVaultPath: 'Eagle Imports/Links/Web Design Ideas_thumbnail.png',
    assetBaseName: 'Web Design Ideas_thumbnail.png',
    opts: { tagFromEagle: false },
    importDateISO: '2025-01-01T00:00:00.000Z',
  };
  const asBookmark = buildItemNoteContent(Object.assign({}, base, { kind: 'bookmark' }));
  const linkAt = asBookmark.indexOf('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)');
  const embedAt = asBookmark.indexOf('![[Eagle Imports/Links/Web Design Ideas_thumbnail.png]]');
  assert.ok(linkAt >= 0 && embedAt > linkAt, 'bookmark kind → link first, image below');
  assert.ok(asBookmark.includes('kind: "bookmark"'));

  // The same files forced to "video" kind are NOT a bookmark → no 🔗 block
  const asVideo = buildItemNoteContent(Object.assign({}, base, { kind: 'video' }));
  assert.ok(!asVideo.includes('🔗 ['));
  assert.ok(asVideo.includes('- **Type:** Video'));
  assert.ok(asVideo.includes('kind: "video"'));
});
