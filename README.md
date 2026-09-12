# Spatia

Spatia is a local-first visual infinite workspace for notes, sketches, and documents. It runs as a desktop app on Windows and as a web app / PWA in the browser — including on tablets and iPads with Apple Pencil support. Projects are plain files on your machine: no account, no cloud.

> Spatia is open source and released under the [MIT License](#license).

## Features

- **Infinite canvas** — zoom, pan, minimap, plus workspace *focus* and *isolation*.
- **Notes, text, images, files & connections** — drop content straight onto the board.
- **First-class pen & eraser** — real-time ink with smoothing and pressure support, plus partial- and whole-stroke erasing with a live preview of the result.
- **Shapes & selection** — add, resize, rotate, select, and organize objects.
- **Fast fuzzy search** — find anything in a project (`Ctrl+F`, `/`, or the Search button).
- **Templates** — start from a reusable template.
- **Version history & data safety** — desktop autosave plus up to 20 snapshots per project, with manual and on-open captures you can restore at any time.
- **Plugins** — a sandboxed plugin system (API v2) with an explicit permission model ([view][perms]) and shared validation for desktop, web, and renderer.
- **Real-time collaboration** — an optional self-hosted collaboration server ([server/](server/)).
- **Portable & offline** — `.spatia` files are plain text in **SSON**, Spatia's versioned structured object notation; unknown/newer format versions are rejected rather than silently corrupted.

[perms]: src/shared/plugins/manifest.ts

## Web version

Try Spatia in your browser at **<https://spatiaweb.surge.sh>** — installable as a PWA and usable with touch and Apple Pencil on tablets and iPads.

## Getting started (desktop)

### Download a ready-made build

Prebuilt Windows releases (an installer, `.msi`) are published on
[GitHub Releases](https://github.com/ji2-2/Spatia/releases). Download
`Spatia-0.5.0-win-x64.msi` and run it to install, or grab the portable
`Spatia-0.5.0-win-x64.zip` for a no-install option (extract and run
`Spatia.exe`).

### Build and run from source

Requirements: Node.js 20+ and npm, on Windows 10/11 x64.

```sh
npm ci
npm run dev        # compile and launch the Electron app
```

Produce the Windows installer (MSI):

```sh
npm run package:msi   # writes release/Spatia-<version>-x64.msi
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

## Overview

![Spatia — workspace overview](Spatia%20Download%20%26%20Web/assets/screenshots/overview.webp)

![Spatia — workspace detail](Spatia%20Download%20%26%20Web/assets/screenshots/detail.webp)

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
- Bugs and ideas go through [GitHub Issues](https://github.com/ji2-2/Spatia/issues).

## License

Spatia is released under the [MIT License](LICENSE). The `package.json`
file declares `"license": "MIT"` and a `LICENSE` file exists at the root of
the repository.