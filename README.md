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

## Release

- desktop: a push to `main` with `feat:` / `fix:` / `perf:` / `BREAKING` commits bumps, builds,
  signs and publishes the AppImage (`auto-release.yml`);
- Android: `android-release.yml`, run by hand;
- the SDK: `sdk-publish.yml`, when `packages/hubbyware-sdk`'s version is not on npm yet.

MIT licensed.
