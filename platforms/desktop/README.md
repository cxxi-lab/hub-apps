# desktop-app

Electron app (React 19 + Vite + Tailwind v4) talking to the Symfony backend.

## Dev / Build

```
npm install
npm run dev      # electron-vite dev
npm run build    # electron-vite build → out/
npm run dist     # build + electron-builder → dist/ (AppImage on Linux)
```

## Bundled binaries: wireproxy

The app embeds [wireproxy](https://github.com/whyvl/wireproxy) — a userspace
WireGuard client exposing a local SOCKS5 proxy — so it can route its own HTTP
traffic through the VPN tunnel without enabling WireGuard at the OS level.

### Layout

```
resources/
└── wireproxy/
    └── <platform>-<arch>/
        └── wireproxy[.exe]
```

Currently bundled: **linux-x64** only. Other platforms can be added by
dropping the matching binary in `resources/wireproxy/<platform>-<arch>/`.
Download from the [wireproxy releases](https://github.com/whyvl/wireproxy/releases),
mark `+x`, commit.

### Path resolution

`src/main/wireproxy.ts` → `resolveWireproxyBinary()`:

- **dev**: `process.cwd()/resources/wireproxy/<platform>-<arch>/<bin>`
  (electron-vite runs with cwd at the project root)
- **packaged**: `process.resourcesPath/wireproxy/<platform>-<arch>/<bin>`
  (electron-builder `extraResources` copies the folder next to the app)

Returns `null` when no binary is bundled for the current platform/arch
— the caller is expected to fall back to a "VPN disabled" state.

### Build config

`package.json` `build.extraResources` maps `resources/wireproxy → <app>/resources/wireproxy` at packaging time. No code changes needed when adding new platform binaries.

### Binary size & git-lfs

Each wireproxy binary is ~10 MB stripped. Committed directly to git as long
as we stay under a handful of platforms; that's ~30–40 MB for the full set
(linux-x64, darwin-x64/arm64, win32-x64), which is on the edge of acceptable
for plain git but still workable.

If we ever add more platforms, ship updates often, or pile up other large
assets, **switch the `resources/wireproxy/**/wireproxy*` paths to git-lfs**:

```sh
git lfs install
git lfs track "resources/wireproxy/**/wireproxy"
git lfs track "resources/wireproxy/**/wireproxy.exe"
git add .gitattributes
```

Existing committed binaries can be migrated with `git lfs migrate import --include="resources/wireproxy/**/wireproxy*"`.

Alternative if we want to keep the repo lean: drop binaries from git entirely
and add a `scripts/fetch-wireproxy.sh` invoked from a `prebuild` npm script
that downloads the right release per platform at install time.
