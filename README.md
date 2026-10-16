# Spatia

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: Windows • Web • Tablet](https://img.shields.io/badge/platform-Windows%20%7C%20Web%20%7C%20Tablet-informational.svg)](https://github.com/SpatiaLabs/Spatia/releases)
[![Version: 0.5.2](https://img.shields.io/badge/version-0.5.2-success.svg)](https://github.com/SpatiaLabs/Spatia/releases)
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

- [Features](#features)
- [Screenshots](#screenshots)
- [Web version](#web-version)
- [Getting started (desktop)](#getting-started-desktop)
- [Web app / website](#web-app--website)
- [Checks](#checks)
- [Project layout](#project-layout)
- [Plugins](#plugins)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Infinite canvas** — zoom, pan, minimap, plus workspace *focus* and *isolation*.
- **Notes, text, images, files & connections** — drop content straight onto the board. Connections are a real graph: a frame can fan out to many targets and many sources can converge on one, with edges that stay independent and are cleaned up automatically when an endpoint is deleted.
- **Rich text formatting** — bold, italic, underline, code, links, headings, bullets and numbered lists inside notes and text objects, stored as lightweight inline markup.
- **First-class pen & eraser** — real-time ink with centripetal Catmull-Rom curve smoothing and pressure support, variable-width tapered strokes, plus partial- and whole-stroke erasing with a live preview of the result.
- **Distinct brushes** — pen, pencil, ballpoint, marker, brush, highlighter and a real **calligraphy nib** whose width depends on stroke direction, each with its own width/opacity response, caps and texture. Built-in and saveable presets carry the brush type, and it round-trips through `.spatia` files.
- **Reliable shortcuts** — a layout-independent resolver (`src/shared/input/shortcuts.ts`) keys off physical key codes, so `Ctrl`/`Cmd` commands fire the same on QWERTY, AZERTY and AltGr layouts; `Ctrl+S`, `Ctrl+Shift+C` (connect), `Ctrl+Shift+S` (Save As) and the rest are handled by one dispatch path.
- **Game controller support** — plug in any standard pad: left stick pans, right stick zooms, A opens / adds, B cancels, X deletes, Y duplicates, LB/RB undo/redo, triggers resize the pen, D-pad steps through objects and tools, Back toggles the sidebar and Start opens the command palette.
- **Shapes & selection** — add, resize, rotate, select, and organize objects.
- **Fast fuzzy search** — find anything in a project (`Ctrl+F`, `/`, or the Search button).
- **Templates** — start from a reusable template.
- **Import interoperability** — import Markdown, OPML, FreeMind, Excalidraw and Miro files onto the canvas as native objects.
- **Version history & data safety** — desktop autosave plus up to 20 snapshots per project, with manual and on-open captures you can restore at any time.
- **Plugins** — a sandboxed plugin system (API v2) with an explicit permission model ([view](src/shared/plugins/manifest.ts)) and shared validation for desktop, web, and renderer.
- **Real-time collaboration** — zero-setup on desktop (click Share and the local server starts automatically); manual server setup also available ([server/](server/)).
- **Portable & offline** — `.spatia` files are plain text in **SSON**, Spatia's versioned structured object notation; unknown/newer format versions are rejected rather than silently corrupted.

## Screenshots

| Workspace with the tools panel and inspector open | A close-up of frames, notes and connections |
| --- | --- |
| ![Spatia with the tools panel open and a note selected](Spatia%20Download%20%26%20Web/assets/screenshots/workspace.webp) | ![Close-up of a Spatia frame with notes and a connection](Spatia%20Download%20%26%20Web/assets/screenshots/detail.webp) |

## Web version

Try Spatia in your browser at **<https://spatiaweb.surge.sh>** — installable as a PWA and usable with touch and Apple Pencil on tablets and iPads.

## Getting started (desktop)

### Download a ready-made build

Prebuilt Windows x64 installers are published on
[GitHub Releases](https://github.com/SpatiaLabs/Spatia/releases). Download
`Spatia-0.5.2-win-x64.msi` and run it to install Spatia.

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

The site in [Spatia Download & Web/](Spatia%20Download%20%26%20Web/) embeds the web build of Spatia, which compiles the same renderer and shared sources as the desktop app. After any source change:

```sh
npm run build:web   # regenerates Spatia Download & Web/web/js and web/app.css
```

Then serve that folder however you like:

```sh
npx serve "Spatia Download & Web"
```

## Checks

```sh
npm run typecheck      # strict TypeScript check (tsc --noEmit)
npm test               # unit tests for shared logic (node --test)
npm run test:server    # collaboration server API tests
npm run build:web      # web build + desktop/web parity gate (fails on drift)
node scripts/bench-startup.cjs   # measures desktop startup (needs a built dist/)
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron main process: windowing, IPC, storage, plugin installs. |
| `src/renderer/` | Canvas engine, UI, and stores — the same code drives desktop and web. |
| `src/shared/` | Pure shared logic: geometry, SSON serialization, search, templates, plugins. |
| `src/tests/` | Unit tests for shared logic. |
| `server/` | Optional real-time collaboration server. |
| `scripts/` | Build, asset, and verification scripts. |
| `Spatia Download & Web/` | The public website (including the embedded web app). |

## Plugins

A plugin is a folder containing a `manifest.json` and a `main.js` entry script that runs inside a sandboxed browsing context. Manifest and permission validation live in `src/shared/plugins/manifest.ts`, shared by the desktop main process (install path), the web bridge (browser install path), and the renderer.

- **API v2** — plugins declare an explicit capability set: `notify`, `commands`, `view`, `documents`, `selection`, `navigation`. Anything else is rejected so a plugin can never silently request more than Spatia understands.
- **v1 compatibility** — plugins without a `permissions` field keep full legacy access; unknown extra manifest fields are preserved so the format can grow without breaking existing plugins.
- **Built-ins** — the standard plugin set ships in `src/shared/plugins/builtin.ts`; the demo plugins live next to the site in `Spatia Download & Web/plugins/`.

## Contributing

Contributions are welcome. Please keep these patterns in mind:

- TypeScript for all application code (no plain JS), with `npm run typecheck` passing.
- Pure/parseable logic belongs in `src/shared/` with tests in `src/tests/`.
- Before opening a PR, run `npm run typecheck`, `npm test`, and `npm run build:web` if the website/web app changed.
- Bugs and ideas go through [GitHub Issues](https://github.com/SpatiaLabs/Spatia/issues).

## License

Spatia is released under the [MIT License](LICENSE). The `package.json`
file declares `"license": "MIT"` and a `LICENSE` file exists at the root of
the repository.
