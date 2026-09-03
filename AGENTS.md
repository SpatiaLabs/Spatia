# Spatia — Development Guidelines

Spatia is a **local-first visual infinite workspace** built with Electron +
TypeScript. These rules keep the architecture consistent as the app grows.

## Stack & constraints

- **Electron + TypeScript + HTML + CSS.** No JavaScript for application source —
  TypeScript everywhere.
- **Strict TypeScript.** `strict: true` with all strictness flags enabled. The
  umbrella `tsconfig.json` runs `--noEmit` typecheck across all sources.
- **Minimal dependencies.** Prefer the platform (Electron, Web APIs, Node
  built-ins) over npm packages. Only add a dependency when there is a strong
  architectural reason, and document why.

## Architecture

Code is split into four responsibility areas:

- `src/main/` — Electron **main process**: window lifecycle, secure preload,
  and all privileged filesystem/dialog IPC. Never expose Node to the renderer.
- `src/renderer/` — Renderer: canvas engine, state stores, project store, UI.
- `src/shared/` — Pure, framework-free logic used by multiple contexts:
  geometry transforms, project serialization, core types, id generation.
  Shared code MUST NOT import Node or DOM APIs (it compiles for both contexts).
- `src/tests/` — Unit tests for pure logic (geometry, serialization).

### State separation

Keep these as **separate stores**, never one giant state object:

1. **Project/document state** (`ProjectStore`): project meta + objects array.
2. **Viewport state** (`ViewportStore`): camera x/y + zoom.
3. **Selection state** (`SelectionStore`): selected object id.
4. **UI state**: kept inside the App controller / thin `AppUI` DOM layer.

State stores notify subscribers via a lightweight `Emitter`. Canvas movement
must not cause application-wide re-renders.

### Canvas

- Use HTML5 **Canvas 2D** for the surface (dependency-free, GPU-accelerated,
  scales to thousands of objects via viewport culling).
- **World space vs screen space are always kept separate.** Objects live in
  world coordinates. Screen position is derived on demand via
  `worldToScreen` / `screenToWorld` in `src/shared/geometry/viewport.ts`.
- Rendering is driven by a coalesced `requestAnimationFrame` loop that only
  redraws when relevant state changed.
- Cull objects against the visible world rect before drawing.

### Persistence

- Local-first: no account, no cloud, works offline.
- The renderer **never touches the filesystem**. All file I/O happens in the
  main process through validated IPC (`src/main/storage.ts`).
- Project files use a **versioned JSON** format (`formatVersion`). Parse/validate
  happens in `src/shared/project/serialize.ts`; unknown or future versions are
  rejected rather than silently corrupting state.
- Writes are **atomic** (temp file + rename) to avoid corrupting a project on
  crash.

## Commands

- `npm run typecheck` — strict typecheck of all sources.
- `npm test` — build + run unit tests (`node --test dist/test/tests/*.test.js`).
- `npm run build` — compile main + renderer and copy static assets.
- `npm run dev` / `npm start` — build then launch Electron.

## Out of scope for Phase 1

Connections, groups, frames, media objects (image/video/audio/PDF/files),
rich text, collab/cloud/accounts, minimap, plugins, AI, mobile. These belong to
later phases; keep the core stores and canvas engine ready for them without
implementing them now.
