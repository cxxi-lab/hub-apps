# hub-apps

hub's apps: the shared React shell (`app/`), the desktop app (`desktop/`, Electron) and the Android app
(`mobile/`, Capacitor), and the module SDK they implement (`packages/hub-sdk`, published as
`@cxxi-lab/hub-sdk`).

The apps ship no module: each one is installed from the server's signed catalogue when enabled. The
modules live in their own repositories (`cxxi-lab/hub-module-*`), the design system and the modules'
CLI in [`cxxi-lab/hub-ui`](https://github.com/cxxi-lab/hub-ui).

## Develop

```
~/dev/hub/apps         this repository
~/dev/hub/modules/<id> the modules' repositories (the development build loads their sources from
                       ../../modules, or HUB_MODULES_DIR)
```

```sh
npm install
npm run dev            # the desktop app, against the local server (server repository, private)
```

## Release

- desktop: a push to `main` with `feat:` / `fix:` / `perf:` / `BREAKING` commits bumps, builds,
  signs and publishes the AppImage (`auto-release.yml`);
- Android: `android-release.yml`, run by hand;
- the SDK: `sdk-publish.yml`, when `packages/hub-sdk`'s version is not on npm yet.

MIT licensed.
