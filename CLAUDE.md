# CLAUDE.md: `master` branch

This branch mirrors upstream shapez Community Edition (`tobspr-games/shapez-community-edition`),
plus this file. Keep it that way: no feature work here, only syncing with upstream. The iOS app, touch controls
and single-file HTML build live on the **`ios` branch**, which has its own, much more detailed
CLAUDE.md. Switch to it (`git switch ios`) for anything about those.

The owner is Pran. Start replies to him with "Pran,". Push only to his fork
(`PranThow/shapez-community-edition`); never to upstream.

## Syncing with upstream

```bash
git remote add upstream https://github.com/tobspr-games/shapez-community-edition  # once
git fetch upstream
git switch master && git merge upstream/master && git push origin master
git switch ios && git merge master   # resolve conflicts on ios, rebuild, retest
```

The merge should never conflict, because this file is the only difference from upstream. If it
does conflict, master has drifted; find out why before forcing anything.

## Commands (upstream game)

```bash
npm i                     # in the root and in electron/
npm run gulp              # build + serve with live reload (ignore the browser tab it opens)
cd electron && npm start  # desktop app; add -- --dev for development mode
npm run package-<win32|linux|darwin>-<x64|arm64>   # release build -> build_output/standalone
npx eslint . && npx prettier --check .
```

Needs Node.js, ffmpeg (audio) and Java (texture packer).

## Layout

- `src/js`: game code. `core/` engine, `game/` simulation + HUD (`game/hud/parts`), `states/`
  screens, `platform/` sound, storage and wrapper, `savegame/`, `mods/`.
- `src/css`: SCSS per state/HUD part. `translations/`: YAML (`base-en.yaml` is the source).
- `electron/`: the desktop shell. Saves and mods go through IPC (`fs-job`, `get-mods`).
- `gulp/`: build pipeline (rspack + swc, texture atlas, sounds, translations).
- Upstream type-checks (`npx tsc --noEmit -p src`) with existing errors; don't add new ones.
