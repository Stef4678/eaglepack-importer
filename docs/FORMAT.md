# Eagle / EaglePack on-disk format notes

Reverse-engineering notes used to write this plugin. Sources are community
parsers, Eagle support docs, and a real Eagle 4.0 sample library.

## Eagle library (`.library`) folder layout

A running Eagle library is an ordinary folder whose metadata lives in small
JSON files next to the assets — there is no proprietary database:

```
<Library>.library/
├── metadata.json                      # library header + folder tree
├── mtime.json                         # { [itemId]: mtime, "all": <count> }
└── images/
    └── <ITEM_ID>.info/                # one folder per item
        ├── metadata.json              # item metadata (see below)
        ├── <original file>            # e.g. photo.jpg — original asset
        └── <original file>_thumbnail.png   # optional preview (PNG)
```

`metadata.json` (library header, Eagle 3.x/4.x):

```jsonc
{
  "name": "My Library",
  "folders": [
    { "id": "…", "name": "animal",
      "children": [ { "id": "…", "name": "dog", "children": [], … } ],
      "modificationTime": 1759876356012, "tags": [], "password": "" }
  ],
  "smartFolders": [], "quickAccess": [], "tagsGroups": [],
  "modificationTime": 1760231728179,
  "applicationVersion": "4.0.0"
}
```

Newer libraries call the root header `metadata.json`; the item-level JSONs are
also named `metadata.json` but live inside each `<ITEM_ID>.info` folder, so a
parser distinguishes them by content, not just by file name.

Item `metadata.json` (keys shared with Eagle's Web API `/api/item/info`):

```jsonc
{
  "id": "MGMYDH18YSIS1",
  "name": "pexels-stuart-robinson-461411873-33528653", // no extension
  "size": 63785, "btime": 1756571097667, "mtime": 1756571097667,
  "ext": "jpg",
  "tags": ["Animal", "Bird"],
  "folders": ["MGH4XZ1OQCGZD"],        // folder *ids*, not paths
  "isDeleted": false,
  "url": "https://…", "annotation": "",
  "modificationTime": 1760228118908,
  "height": 960, "width": 640,
  "noThumbnail": true, "lastModified": 1760409426491,
  "star": 4,
  "palettes": [ { "color": [221,218,210], "ratio": 51 }, … ],
  "order": { "<folderId>": "1759876940271.5" }
}
```

Only `id` is guaranteed; everything else may be missing. Folder membership is
virtual: an item lists folder *ids* and may belong to several folders without
duplicating the file on disk. Older Eagle versions may also include `star`,
`duration`, `medium`, `bpm`, `comments`, `fontMetas`.

**Bookmark / webpage items** have a non-empty `url` and typically **no
original file** — their item folder holds only `metadata.json` and, when Eagle
generated one, a preview image (often named like `<name>_thumbnail.png`), and
some exports also carry a Windows URL shortcut (`*.url`) beside it. The plugin
detects these (metadata carries a `url` and no real media file is present) and
renders the note as: title → clickable source link → preview image below it.

**Item kind classification** is fully user-configurable: the plugin ships with
default extension→type groups (Bookmark / Image / Video / Audio / Document /
Font / Archive, catch-all Other) that can be edited in Settings. The classified
kind is stored in the note frontmatter (`eagle.kind`) and drives the Bookmark
layout plus the `Type` line shown in the note. Items whose metadata has no
extension follow a configurable "no file type" rule (default `auto`: URL items
→ Bookmark, everything else → Other). As a safeguard, an item with a source
`url` and an unknown/unlisted file type is classified **Bookmark** rather than
Other (the Bookmark group also ships `url`/`webloc`/`website` shortcut
extensions); only an explicit group mapping overrides this.

Folder trees nest child folders as full objects inside `children`.

## `.eaglepack` (EaglePack export) layout

A `.eaglepack` is a ZIP (rename to `.zip` and open it) built from the same
primitives. Two producers are known:

**Eagle / Eagle-compatible exporters** (e.g. `sdweb-eaglepack`, verified to
import back into Eagle by double-click):

```
pack.json                              # { "images": [ <item metadata>… ] }
<ITEM_ID>.info/
├── metadata.json                      # same item metadata (duplicated)
└── <original file>                    # asset, original file name
```

**Packs created from an Eagle library folder** use the `.library` layout
above — optionally nested under one top-level folder inside the zip.

Eagle's own material packs also carry folder/classification info so importing
a pack into Eagle recreates its folders. Free packs on the Eagle community
site are distributed in this format.

## Design decisions in the parser

Because both layouts (and arbitrary nesting) appear in the wild, the parser in
`main.js`:

1. reads the ZIP central directory (no extraction of everything upfront),
2. classifies **every** `.json` entry by *content*:
   - has `images` array → pack header (`pack.json`),
   - has a string `id` → item metadata,
   - has `folders`/`smartFolders`/`orderedList` (and no `id`) → library header,
3. treats each item metadata JSON's folder as the item folder and scans its
   sibling files for the asset (preferring an exact `<name>.<ext>` match, then
   `name.*`, then the largest file; `*_thumbnail.png` files are recognised as
   previews),
4. falls back to `pack.json`'s `images` list when per-folder metadata is
   missing (locating `<id>.info`/`<id>` folders), and finally to folder-name
   scanning for bare `.info` directories.

Verified against a real Eagle 4.0 library sample
(`docs/sample-library` in [naamiru/eagle-webui](https://github.com/naamiru/eagle-webui))
and the Eagle 4.0 API docs ([api.eagle.cool](https://api.eagle.cool/item/info.md)).

## Related references

- https://en.eagle.cool/support/article/import-exporting-eaglepacks
- https://github.com/kznrluk/sdweb-eaglepack (Go, creates importable `.eaglepack`)
- https://github.com/fanyang89/eaglexport (Go, reads a `.library` folder)
- https://github.com/naamiru/eagle-webui (TS, reads a `.library` folder; sample included)
- https://api.eagle.cool/item/info.md (item field reference)
