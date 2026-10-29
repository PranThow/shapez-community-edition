# CLAUDE.md: `ios` branch

This branch is shapez Community Edition plus an iOS app (sideloaded IPA), touch controls, and a
single-file HTML build. `master` mirrors upstream `tobspr-games/shapez-community-edition`. Keep the
two apart: upstream changes come in by merging `master` into `ios`, never the other way.

The owner is Pran. He sideloads the IPA with Feather and plays on an iPhone, and on an iPad with a
Magic Keyboard (keyboard + trackpad). Start replies to him with "Pran,". Push only to his fork
(`PranThow/shapez-community-edition`); never to upstream.

## Commands

```bash
npm i                                        # root (and electron/ for the desktop app)
npx gulp --cwd gulp build.standalone.full    # game -> build/
node html/build.mjs [--skip-web] [--music 128|64|hq|0]   # -> build_output/shapez-ce-<ver>.html
bash ios/build.sh [--skip-web]               # -> build_output/shapez-ce-<ver>-ios.ipa
npx tsc --noEmit -p src                      # upstream already fails (~295 errors): add none
npx eslint <files> && npx prettier --check <files>
```

-   `--skip-web` reuses `build/`. `html/build.mjs` always re-bundles JS from `src/`, but the IPA
    copies `build/`, so rebuild with gulp first whenever `src/` or CSS changed.
-   Needs node, ffmpeg and Java (texture packer). The IPA also needs clang + lld 15+ and Python 3
    with Pillow. `ios/build.sh` sparse-clones `xybp888/iOS-SDKs` (iPhoneOS26.5.sdk) into
    `ios/.sdk`. Don't move to the 27.x SDK: its stubs are arm64e-only and lld rejects them.
-   The IPA is unsigned and linker-signed ad hoc (`-Wl,-adhoc_codesign`). The sideloading tool
    re-signs it. CFBundleVersion is the git commit count.

## Where things are

| Area               | Files                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform detection | `src/js/core/config.ts`: `IS_IOS_APP`, `IS_ELECTRON`, `IS_WEB`, `IS_MOBILE`. `IS_MOBILE` (= touch layout) honours `localStorage["shapez-ce/touchControls"]`, mirrored from the "Touch controls" setting because it is read before settings load                  |
| iOS app            | `ios/main.m` (WKWebView, `shapez://localhost` scheme handler with byte ranges, `shapezIpc` bridge implementing Electron's `fs-job` over `Documents/saves`, document pickers, haptics, save on background), `ios/Info.plist`, `ios/build.sh`, `ios/make_icons.py` |
| iOS JS side        | `src/js/platform/ios.js` installs `window.ipcRenderer` over the bridge. Errors must read `Error invoking remote method 'fs-job': Error: ENOENT: …` because `FsError` parses `message.split(":")[2]`                                                              |
| Browser storage    | `src/js/platform/web.js`: same `fs-job` contract on IndexedDB (memory + warning banner if blocked), file picker import, download export                                                                                                                          |
| Single HTML        | `html/build.mjs` (one rspack chunk, base64 asset blocks resolved to blob: URLs, Worker shim); `src/js/core/asset_url.js` `assetUrl()`. **Any new runtime file URL must go through `assetUrl()`** or the HTML build breaks                                        |
| Touch controls     | `src/js/game/hud/parts/touch_controls.js` + `src/css/ingame_hud/touch_controls.scss`. Gestures drive the camera's mouse signals (`downPreHandler`, `movePreHandler`, `upPostHandler`), so game rules stay in one place                                           |
| Camera input       | `src/js/game/camera.js`: `pinch()`, `zoomAround()`, scroll-to-pan (`scrollPansMap` setting), trackpad pinch (ctrl+wheel and Safari `gesture*` events, on `window` in the capture phase), `contextmenu` fallback for right click                                  |
| Keyboard           | `src/js/core/input_distributor.ts`: a fresh press comes from `KeyboardEvent.repeat`, and modifiers are resynced from every event (iPadOS drops keyups)                                                                                                           |
| Music              | `src/js/platform/sound.js` `MusicInstance` is a plain looping `<audio>`, not Howler, because WebKit reports duration 0 for long tracks. Volume 0 mutes (iOS ignores element volume)                                                                              |
| Saves              | `src/js/core/compression.ts` + `src/js/webworkers/*`: use `new Response(bytes).body`, never `Blob.stream()`, which fails in blob: workers on file:// in WebKit. There is a main-thread fallback if workers can't start                                           |

## Rules that bit before

-   Touch handlers call `preventDefault()` only when `ev.cancelable`, and ignore touches they never
    tracked.
-   After a tap there is no cursor ghost (`setPointer(null)`), so keyboard actions that act "at the
    cursor" need a touch-aware path; see how R is routed through `rotate()`.
-   The body is inset to the safe area. Full-screen layers must be `position: fixed` (canvas,
    vignette, main menu `::after`) or a pale frame shows on notched iPhones.
-   New settings need a version bump + migration in `application_settings.js`, and English text in
    `translations/base-en.yaml` (types are generated into `src/js/built-temp`, so gulp must run
    before `tsc`).
-   Use `@ts-expect-error <reason>`, not `@ts-ignore`. Keep diffs small and reuse upstream signals
    and settings instead of building parallel systems.

## Testing

There are no unit tests. Verify in real engines.

-   **Chromium** (`puppeteer-core`, CDP touch): drive `window.shapez.GLOBAL_APP` and the CDP
    `Input.dispatchTouchEvent`.
    -   Fake the iOS bridge by defining `window.webkit.messageHandlers.shapezIpc.postMessage` before
        load.
    -   CDP touchEnd lifts every finger. To lift one finger, send a touchMove with fewer points.
    -   Puppeteer `goto`/`evaluate` count as user gestures; for autoplay tests use `Runtime.evaluate`
        with `userGesture: false`.
    -   Mobile emulation drops CDP wheel events; dispatch `WheelEvent`s yourself.
    -   Notches: `Emulation.setSafeAreaInsetsOverride`.
-   **WebKit** (Safari's engine): WebKitGTK through Python gi. Wait for the `load-changed` FINISHED
    event before running scripts. It lacks VP9, so the menu video not playing there is expected.
-   **Servers:** music needs byte ranges, which `python -m http.server` lacks; that only matters for
    the multi-file `build/`.
-   **Must keep working:** placing/drawing/pinching/erasing/blueprints by touch, saves surviving a
    reload, and the HTML from file:// and http.

**Untested:** real iOS/iPadOS hardware and Firefox.

**Open issue:** trackpad pinch in iPad Safari. What iPadOS sends is unknown. Pran has
`pinch-probe.html` (it logs every input event); ask for its screenshot before changing the pinch
code again.
