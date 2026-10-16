# Spatia

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: Windows • Web • Tablet](https://img.shields.io/badge/platform-Windows%20%7C%20Web%20%7C%20Tablet-informational.svg)](https://github.com/SpatiaLabs/Spatia/releases)
[![Version: 0.5.3](https://img.shields.io/badge/version-0.5.3-success.svg)](https://github.com/SpatiaLabs/Spatia/releases)
[![Web app: spatiaweb.surge.sh](https://img.shields.io/badge/web-spatiaweb.surge.sh-6f42c1.svg)](https://spatiaweb.surge.sh)

**A local-first visual infinite workspace for notes, sketches, and documents.**

Spatia runs as a desktop app on Windows and as a web app / PWA in the browser —
including on tablets and iPads with Apple Pencil support. Projects are plain
files on your machine: no account, no cloud.

![Spatia canvas showing notes, a frame, connections and a link card](Spatia%20Download%20%26%20Web/assets/screenshots/overview.webp)

<p>
  <a href="https://spatiaweb.surge.sh"><strong>Try the web app</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/SpatiaLabs/Spatia/releases">Download for Windows</a>
</p>

## Contents

- [Why Spatia](#why-spatia)
- [Features](#features)
  - [Canvas & navigation](#canvas--navigation)
  - [Objects & content](#objects--content)
  - [Connections & routing](#connections--routing)
  - [Writing & drawing](#writing--drawing)
  - [Organizing & finding](#organizing--finding)
  - [Import & export](#import--export)
  - [Collaboration & data safety](#collaboration--data-safety)
  - [Extending Spatia](#extending-spatia)
- [Screenshots](#screenshots)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Web version](#web-version)
- [Getting started (desktop)](#getting-started-desktop)
- [Web app / website](#web-app--website)
- [Development](#development)
- [Checks](#checks)
- [Project layout](#project-layout)
- [Plugins](#plugins)
- [Contributing](#contributing)
- [License](#license)

## Why Spatia

Think in space instead of in pages. Spatia is one unbounded canvas where notes,
text, shapes, frames, files and links live side by side, and where a lightweight
graph of connections keeps the relationships between them visible.

- **Local-first and private** — desktop projects are files you own; the web app
  keeps everything in your own browser. Nothing is uploaded to a Spatia cloud,
  and no account is required.
- **Fast and quiet** — a small, dependency-free engine renders a single canvas at
  60 fps with viewport culling and high-refresh smoothing, even on large boards.
- **One codebase, every device** — the same renderer and shared logic drive the
  Windows desktop app and the browser build, so a project opens wherever you are.

## Features

### Canvas & navigation

- **Infinite canvas** — zoom at the cursor, pan with the middle button or
  `Space` + drag, and keep your bearings with the minimap.
- **Focus & isolation** — `F` zooms to your selection; `Shift+I` isolates a frame
  or group and dims everything else so you can work on one area at a time.
- **Command palette** — `Ctrl+K` brings up every action; search finds any object
  in the project with `Ctrl+F` or `/`.
- **A calmer tools panel** — the sidebar is grouped into clear sections (Project,
  Browse, Edit, Tools, Insert, Data, Shapes, Media, Collaborate, Application)
  with consistent icons and inline shortcut hints, and it stays fully keyboard
  accessible.

### Objects & content

- **Notes, text, images, files & links** — drop content straight onto the board.
  Notes and text support rich formatting (bold, italic, underline, inline code,
  headings, bullet and numbered lists) as lightweight inline markup.
- **Frames & groups** — named, colored containers and logical groups give your
  workspace structure without clipping or constraining anything inside them.
- **Shapes & data** — seven built-in shapes, plus tables, comparison tables and
  charts for quick structured content.
- **Templates** — start from one of eight reusable templates (blank,
  brainstorming, project planning, mind map, study, notes, product planning,
  personal).

### Connections & routing

Connections are a real graph: an object can fan out to many targets and many
sources can converge on one, with each edge kept independent.

- **Automatic anchoring** — Spatia picks the attachment side for you and slides
  the anchor along the edge toward the other endpoint, so parallel links stay
  distinguishable and never overlap messily.
- **Three route styles** — choose per connection in the inspector:
  - **Curved** (default) — a smooth bezier that leaves each endpoint
    perpendicular to its edge.
  - **Elbow** — clean orthogonal routing with small, consistent rounded corners.
  - **Bracket** — a wide rail with perpendicular legs that frames the run between
    two objects.
- **Stable & cheap** — routes are recomputed deterministically from object
  geometry (so they never flicker while dragging) and memoized so the hot render
  path stays fast.
- **Self-healing** — deleting an object removes the edges attached to it,
  duplicating a cluster re-points the copied edges at the copies, and re-connecting
  a pair selects the existing edge instead of stacking an invisible double.
- **Persistence** — the chosen route style is stored with the file, and your last
  used style is remembered as the default for new connections.

### Writing & drawing

- **First-class pen & eraser** — real-time ink with centripetal Catmull-Rom
  smoothing and pressure support, variable-width tapered strokes, plus partial-
  and whole-stroke erasing with a live preview.
- **Distinct brushes** — Pen, Pencil, Ballpoint, Marker, Brush, Highlighter and a
  real **calligraphy nib** whose width depends on stroke direction, each with its
  own width/opacity response, caps and texture. Brush type travels with presets
  and round-trips through `.spatia` files.

### Organizing & finding

- **Search, tags, projects & folders** — organize projects in a library and find
  objects fast with fuzzy search.
- **Version history** — desktop autosave plus up to 20 snapshots per project,
  with manual and on-open captures you can restore at any time.

### Import & export

- **Import** Markdown, OPML, FreeMind (`.mm`), Excalidraw (`.excalidraw`) and Miro
  board JSON — files convert to native objects on the canvas.
- **Export** to PNG, JPEG, PDF, Markdown, and the native `.spatia` / `.spatia.json`
  format.

### Collaboration & data safety

- **Real-time collaboration** — zero-setup on desktop (click Share and the local
  server starts automatically); manual server setup is also available
  ([`server/`](server/)). Rooms survive server restarts and reconnects.
- **Portable & offline** — `.spatia` files are plain text in **SSON**, Spatia's
  versioned structured object notation; unknown/newer format versions are rejected
  rather than silently corrupted.
- **Input that just works** — a layout-independent shortcut resolver keys off
  physical key codes, so commands behave the same on QWERTY, AZERTY and AltGr
  layouts; any standard gamepad can drive the whole app.

### Extending Spatia

- **Sandboxed plugins** — a manifest-based plugin system (API v2) with an explicit
  permission model ([`src/shared/plugins/manifest.ts`](src/shared/plugins/manifest.ts))
  and shared validation for desktop, web and the renderer.

## Screenshots

| Workspace with the tools panel and inspector open | A close-up of frames, notes and connections |
| --- | --- |
| ![Spatia with the tools panel open and a note selected](Spatia%20Download%20%26%20Web/assets/screenshots/workspace.webp) | ![Close-up of a Spatia frame with notes and a connection](Spatia%20Download%20%26%20Web/assets/screenshots/detail.webp) |

## Keyboard shortcuts

Canvas shortcuts (the same on desktop and in the browser):

| Shortcut | Action |
| --- | --- |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | Undo / redo |
| `Ctrl+C` / `Ctrl+V` | Copy / paste objects |
| `Ctrl+D` | Duplicate selection |
| `Ctrl+A` | Select all objects |
| `Delete` / `Backspace` | Delete selection |
| `Ctrl+G` / `Ctrl+Shift+G` | Group / ungroup |
| `Ctrl+Shift+C` | Connect the two selected objects |
| `]` / `[` | Bring to front / send to back |
| `F` | Focus (zoom to) selection |
| `Shift+I` | Isolate container / exit isolation |
| `Escape` | Clear selection, close pop-ups, exit isolation |
| `Space` + drag | Pan the canvas |
| `Ctrl` + drag from an object | Start a connection |
| `Ctrl+K` | Command palette |
| `Ctrl+F` or `/` | Search |

While editing text or a note: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+U` underline,
`Ctrl+Enter` commit, `Escape` cancel. Canvas shortcuts pause during text entry.

## Web version

Try Spatia in your browser at **<https://spatiaweb.surge.sh>** — installable as a
PWA and usable with touch and Apple Pencil on tablets and iPads.

## Getting started (desktop)

### Download a ready-made build

Prebuilt Windows x64 installers are published on
[GitHub Releases](https://github.com/SpatiaLabs/Spatia/releases). Download
`Spatia-0.5.3-win-x64.msi` and run it to install Spatia.

### Build and run from source

Requirements: Node.js 20+ and npm, on Windows 10/11 x64.

```sh
npm ci
npm run dev        # compile and launch the Electron app
```

Produce the Windows ZIP package:

```sh
npm run package:zip   # writes release/Spatia-<version>-win-x64.zip
```

## Web app / website

The site in [`Spatia Download & Web/`](Spatia%20Download%20%26%20Web/) embeds the
web build of Spatia, which compiles the same renderer and shared sources as the
desktop app. After any source change:

```sh
npm run build:web   # regenerates Spatia Download & Web/web/js and web/app.css
```

Then serve that folder however you like:

```sh
npx serve "Spatia Download & Web"
```

The build runs a parity gate that fails if the embedded web app drifts from the
desktop renderer, so the two are never out of sync.

## Development

The source is TypeScript throughout (no plain JS). Common tasks:

| Command | What it does |
| --- | --- |
| `npm run dev` | Build and launch the desktop app. |
| `npm run build` | Compile the main and renderer TypeScript. |
| `npm run build:web` | Rebuild the embedded web app and run the parity gate. |
| `npm run typecheck` | Strict TypeScript check (`tsc --noEmit`). |
| `npm test` | Unit tests for shared logic (`node --test`). |
| `npm run test:server` | Collaboration server API tests. |
| `npm run package:msi` / `package:zip` | Produce Windows installers/ZIP in `release/`. |

## Checks

Run these before opening a pull request:

```sh
npm run typecheck      # strict TypeScript check (tsc --noEmit)
npm test               # unit tests for shared logic
npm run test:server    # collaboration server API tests
npm run build:web      # web build + desktop/web parity gate (fails on drift)
node scripts/bench-startup.cjs   # measures desktop startup (needs a built dist/)
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron main process: windowing, IPC, storage, plugin installs. |
| `src/renderer/` | Canvas engine, UI, and stores — the same code drives desktop and web. |
| `src/shared/` | Pure shared logic: geometry, connection routing, SSON serialization, search, templates, plugins. |
| `src/tests/` | Unit tests for shared logic. |
| `server/` | Optional real-time collaboration server. |
| `scripts/` | Build, asset, and verification scripts. |
| `Spatia Download & Web/` | The public website (including the embedded web app). |

## Plugins

A plugin is a folder containing a `manifest.json` and a `main.js` entry script
that runs inside a sandboxed browsing context. Manifest and permission validation
live in `src/shared/plugins/manifest.ts`, shared by the desktop main process
(install path), the web bridge (browser install path), and the renderer.

- **API v2** — plugins declare an explicit capability set: `notify`, `commands`,
  `view`, `documents`, `selection`, `navigation`. Anything else is rejected so a
  plugin can never silently request more than Spatia understands.
- **v1 compatibility** — plugins without a `permissions` field keep full legacy
  access; unknown extra manifest fields are preserved so the format can grow
  without breaking existing plugins.
- **Built-ins** — the standard plugin set ships in
  `src/shared/plugins/builtin.ts`; the demo plugins live next to the site in
  `Spatia Download & Web/plugins/`.

## Contributing

Contributions are welcome. Please keep these patterns in mind:

- TypeScript for all application code (no plain JS), with `npm run typecheck`
  passing.
- Pure/parseable logic belongs in `src/shared/` with tests in `src/tests/`.
- Before opening a PR, run `npm run typecheck`, `npm test`, and `npm run build:web`
  if the website/web app changed.
- Bugs and ideas go through [GitHub Issues](https://github.com/SpatiaLabs/Spatia/issues).

## License

Spatia is released under the [MIT License](LICENSE). The `package.json` file
declares `"license": "MIT"` and a `LICENSE` file exists at the root of the
repository.
