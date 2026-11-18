# hubbyware-client

Hubbyware's apps: the shared React shell (`app/`), and its platforms (`platforms/`): the desktop app
(`platforms/desktop/`, Electron) and the Android app (`platforms/mobile/`, Capacitor), and the hubby SDK they implement (`packages/hubbyware-sdk`, published as
`@cxxi-lab/hubbyware-sdk`).

The apps ship no hubby: each one is installed from the server's signed catalogue when enabled. The
hubbies live in their own repositories (`cxxi-lab/hubbyware-hubbies, hubby-*`), the design system and the hubbies'
CLI in [`cxxi-lab/hubbyware-ui`](https://github.com/cxxi-lab/hubbyware-ui).

## Develop

```
~/dev/hubbyware/repos/client   this repository
~/dev/hubbyware/repos/hubbies  the official hubbies (the development build loads their sources from
                              ../hubbies, or HUB_HUBBIES_DIR)
```

```sh
npm install
npm run dev            # the desktop app, against the local server (server repository, private)
```

Every hubby runs isolated, in its frame (docs `plan-isolation.md`, server repository). In
development the app reads the hubbies' `hubby.json` and models from their sources (`../hubbies`,
or `HUB_HUBBIES_DIR`: a folder of hubby folders, symlinks welcome) and serves their frames' files
from the desktop's `out/renderer/modules/<id>/`; the frames' runtime is built as the dev server
starts. To work on a hubby, alongside `npm run dev`:

```sh
cd ~/dev/hubbyware/repos/hubbies/planner   # any hubby's folder
npx hubby dev          # builds it into the dev desktop's modules, again on each change:
                       # its frame reloads (its page kept)
```

A change to its hubby.json or models: rebuilt too, but the app reads them at start (restart it).
In development only the hubbies whose hubby.json says `network.egress: "vpn"` go through the VPN
(their webviews wait for the tunnel), the others' web surfaces load directly.

## Release

- desktop: a push to `main` with `feat:` / `fix:` / `perf:` / `BREAKING` commits bumps, builds,
  signs and publishes the AppImage (`auto-release.yml`);
- Android: `android-release.yml`, run by hand;
- the SDK: `sdk-publish.yml`, when `packages/hubbyware-sdk`'s version is not on npm yet.

MIT licensed.
