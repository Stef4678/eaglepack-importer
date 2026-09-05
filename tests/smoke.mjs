/*
 * Integration smoke test: run the *real* plugin class against a fake vault,
 * importing a synthesized EaglePack and verifying the files that land in the
 * vault (folders, binary assets, item notes, index note) and re-import safety.
 *
 * Run after tests/run.mjs:  node tests/smoke.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { libraryFixture, packFixture, bookmarkFixture, bookmarkShortcutFixture, SAMPLE_BYTES } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- fake Obsidian environment ---------------------------------------------
function simpleNormalizePath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

class FakeVault {
  constructor() {
    this.files = new Map(); // path -> { type: 'file'|'folder', data }
    this.adapter = {
      exists: async (p) => this.files.has(p),
      remove: async (p) => { this.files.delete(p); },
    };
  }

  async createFolder(p) {
    this.files.set(p, { type: 'folder' });
  }

  async create(p, data) {
    this.files.set(p, { type: 'file', data: String(data) });
  }

  async createBinary(p, data) {
    this.files.set(p, { type: 'file', data });
  }

  getAbstractFileByPath(p) {
    return this.files.has(p) ? { path: p } : null;
  }
}

class FakeNotice {
  constructor(message, timeout) {
    this.message = message;
    this.timeout = timeout;
  }
}

const fakeObsidian = {
  Plugin: class FakePlugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
  },
  PluginSettingTab: class {},
  Setting: class {},
  Modal: class {},
  Notice: FakeNotice,
  normalizePath: simpleNormalizePath,
};

globalThis.__EAGLEPACK_OBSIDIAN_STUB = fakeObsidian;

const require = createRequire(import.meta.url);
const PluginClass = require(path.join(__dirname, '..', 'main.js'));

function makeApp() {
  const vault = new FakeVault();
  return {
    vault,
    workspace: {
      getLeaf: () => ({ openFile: async () => {} }),
    },
  };
}

function makePlugin() {
  const app = makeApp();
  const plugin = new PluginClass(app, { id: 'eaglepack-importer', version: '1.0.0' });
  plugin.settings = {
    importFolder: 'Eagle Imports',
    mirrorFolders: true,
    writeItemNotes: true,
    writeIndexNote: true,
    overwrite: false,
    tagFromEagle: true,
    openAfterSingle: false,
    thumbWidth: 180,
  };
  plugin.loadData = async () => ({});
  plugin.saveData = async () => {};
  plugin.addStatusBarItem = () => ({ setText: () => {}, remove: () => {} });
  return plugin;
}

// ---------------------------------------------------------------------------

test('real plugin class imports a library-layout pack into a fake vault', async () => {
  const plugin = makePlugin();
  const buffer = libraryFixture('');
  const jobs = [{ file: { name: 'My Eagle Library.eaglepack' }, pack: await parseVia(buffer, 'My Eagle Library.eaglepack') }];
  const report = await plugin.runImport(jobs, plugin.settings);

  assert.ok(report.notes >= 3);
  assert.ok(report.created >= 3);
  const { vault } = plugin.app;
  const files = [...vault.files.keys()];

  // mirrored folder tree exists
  assert.ok(files.includes('Eagle Imports/My Eagle Library/animal/dog'));
  assert.ok(files.includes('Eagle Imports/My Eagle Library/video'));

  // the item note + its asset landed next to each other
  const notePath = files.find((p) => p.endsWith('photo dog.md'));
  assert.ok(notePath, 'expected item note for the dog photo');
  const jpgPath = files.find((p) => p.endsWith('photo dog.jpg'));
  assert.ok(jpgPath, 'expected original asset');
  assert.deepEqual(Array.from(new Uint8Array(vault.files.get(jpgPath).data)), Array.from(SAMPLE_BYTES.FAKE_JPG));

  // note body embeds the asset and contains metadata
  const note = vault.files.get(notePath).data;
  assert.ok(note.includes('eagle:'));
  assert.ok(note.includes(`![[${jpgPath}]]`));
  assert.ok(note.includes('A lovely dog photo.'));
  assert.ok(note.includes('tags: ["Animal", "Bird", "UI-Design"]'));

  // index note exists at the pack root
  const indexPath = files.find((p) => p.endsWith('My Eagle Library — Index.md'));
  assert.ok(indexPath, 'expected index note');
  const indexMd = vault.files.get(indexPath).data;
  assert.ok(indexMd.includes('## animal / dog'));
  assert.ok(indexMd.includes(`![[${jpgPath}|180]]`));
});

test('re-import with overwrite=false skips everything and creates nothing new', async () => {
  const plugin = makePlugin();
  const buffer = libraryFixture('');
  const jobs = [{ file: { name: 'My Eagle Library.eaglepack' }, pack: await parseVia(buffer, 'My Eagle Library.eaglepack') }];
  const first = await plugin.runImport(jobs, plugin.settings);
  const before = plugin.app.vault.files.size;

  const second = await plugin.runImport(jobs, plugin.settings);
  assert.ok(second.created === 0, `expected no new files on re-import, got created=${second.created}`);
  assert.equal(plugin.app.vault.files.size, before, 'vault size must not change on a no-op re-import');
  void first;
});

test('flat mode imports everything into the pack root (no mirrored folders)', async () => {
  const plugin = makePlugin();
  const buffer = packFixture();
  const jobs = [{ file: { name: 'Assets.eaglepack' }, pack: await parseVia(buffer, 'Assets.eaglepack') }];
  const opts = Object.assign({}, plugin.settings, { mirrorFolders: false });
  const report = await plugin.runImport(jobs, opts);
  assert.ok(report.notes >= 2);
  const files = [...plugin.app.vault.files.keys()];
  // no mirrored subfolder under pack root
  assert.ok(!files.some((p) => /^Eagle Imports\/Assets\/[^/]+\/[^/]+$/.test(p)));
  assert.ok(files.some((p) => /^Eagle Imports\/Assets\/(photo dog|clip|bookmark note)/.test(p)));
});

test('non-embeddable assets are still copied and linked', async () => {
  const plugin = makePlugin();
  const buffer = libraryFixture('');
  const jobs = [{ file: { name: 'Lib.eaglepack' }, pack: await parseVia(buffer, 'Lib.eaglepack') }];
  await plugin.runImport(jobs, plugin.settings);
  const files = [...plugin.app.vault.files.keys()];
  const note = files.find((p) => p.endsWith('clip.md'));
  assert.ok(note);
  const md = plugin.app.vault.files.get(note).data;
  // mp4 is embeddable in Obsidian, so the clip note embeds the original video
  assert.ok(md.includes('![[Eagle Imports/My Eagle Library/video/clip.mp4]]'));
});

test('bookmark items import with their source link above the preview image', async () => {
  const plugin = makePlugin();
  const buffer = bookmarkFixture(true); // url item with generated preview only
  const jobs = [{ file: { name: 'Links.eaglepack' }, pack: await parseVia(buffer, 'Links.eaglepack') }];
  await plugin.runImport(jobs, plugin.settings);
  const files = [...plugin.app.vault.files.keys()];

  const note = files.find((p) => p.endsWith('Web Design Ideas.md'));
  assert.ok(note, 'expected a note for the bookmark item');
  const md = plugin.app.vault.files.get(note).data;

  const previewPath = files.find((p) => p.endsWith('Web Design Ideas_thumbnail.png'));
  assert.ok(previewPath, 'expected the preview image to be imported');
  const linkAt = md.indexOf('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)');
  const embedAt = md.indexOf(`![[${previewPath}]]`);
  assert.ok(linkAt >= 0, 'bookmark note must contain the source link');
  assert.ok(embedAt > linkAt, 'preview image must render below the source link');
});

test('bookmark item without any preview file still imports (link only)', async () => {
  const plugin = makePlugin();
  const buffer = bookmarkFixture(false);
  const jobs = [{ file: { name: 'Links.eaglepack' }, pack: await parseVia(buffer, 'Links.eaglepack') }];
  const report = await plugin.runImport(jobs, plugin.settings);
  const notePath = [...plugin.app.vault.files.keys()].find((p) => p.endsWith('Web Design Ideas.md'));
  assert.ok(notePath, 'expected the bookmark note');
  const md = plugin.app.vault.files.get(notePath).data;
  assert.ok(md.includes('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)'));
  assert.ok(!md.includes('_thumbnail'), 'no preview expected for this fixture');
  assert.ok(report.notes >= 1);
});

test('bookmark item with .url shortcut + preview imports BOTH files and embeds the thumbnail', async () => {
  const plugin = makePlugin();
  const buffer = bookmarkShortcutFixture();
  const jobs = [{ file: { name: 'Links.eaglepack' }, pack: await parseVia(buffer, 'Links.eaglepack') }];
  await plugin.runImport(jobs, plugin.settings);
  const files = [...plugin.app.vault.files.keys()];

  const urlPath = files.find((p) => p.endsWith('Web Design Ideas.url'));
  assert.ok(urlPath, 'the .url shortcut must be imported too');
  const thumbPath = files.find((p) => p.endsWith('Web Design Ideas_thumbnail.png'));
  assert.ok(thumbPath, 'the thumbnail image must be imported');

  const note = files.find((p) => p.endsWith('Web Design Ideas.md'));
  assert.ok(note, 'expected the bookmark note');
  const md = plugin.app.vault.files.get(note).data;

  const linkAt = md.indexOf('🔗 [https://example.com/design-inspiration](https://example.com/design-inspiration)');
  const embedAt = md.indexOf(`![[${thumbPath}]]`);
  assert.ok(linkAt >= 0, 'bookmark note must contain the source link');
  assert.ok(embedAt > linkAt, 'thumbnail image must render below the source link');
  assert.ok(md.includes('[[${placeholder}]]'.replace('${placeholder}', urlPath)) || md.includes(urlPath),
    'note must reference the imported .url shortcut as an attachment');
});

test('editable item-type settings drive the imported note kind and layout', async () => {
  const plugin = makePlugin();
  // Reclassify: every extension-less item (this fixture's bookmark) as "audio",
  // and treat .url/.png/.jpg/.mp4 as their natural groups.
  plugin.settings.itemTypes = {
    groups: {
      bookmark: ['url'],
      image: ['png', 'jpg'],
      video: ['mp4'],
      audio: ['mp3'],
      document: ['pdf'],
      font: [],
      archive: [],
      other: [],
    },
    noExt: 'audio',
  };
  const buffer = bookmarkFixture(false); // url + no preview + ext: ''
  const jobs = [{ file: { name: 'Links.eaglepack' }, pack: await parseVia(buffer, 'Links.eaglepack') }];
  await plugin.runImport(jobs, plugin.settings);

  const notePath = [...plugin.app.vault.files.keys()].find((p) => p.endsWith('Web Design Ideas.md'));
  assert.ok(notePath);
  const md = plugin.app.vault.files.get(notePath).data;
  // Overridden to "audio" → not a bookmark layout: URL shows under Metadata
  assert.ok(md.includes('kind: "audio"'), 'frontmatter kind must follow the setting');
  assert.ok(md.includes('- **Type:** Audio'), 'Type line must follow the setting');
  assert.ok(!md.includes('🔗 ['), 'no link-first bookmark block when type is not Bookmark');
  assert.ok(md.includes('- **Source:** [https://example.com/design-inspiration](https://example.com/design-inspiration)'));
});

// helper — reuse the parser exposed on the plugin class by the module
async function parseVia(buffer, name) {
  return PluginClass.pureApi.parseEaglePackBuffer(buffer, name);
}
