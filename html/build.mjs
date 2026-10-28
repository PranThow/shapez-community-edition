#!/usr/bin/env node
// Packs all of shapez CE into one .html file that runs by double-clicking it (file://) or
// from any static server (python -m http.server).
//
//   node html/build.mjs                 full build, music re-encoded at 128 kbps
//   node html/build.mjs --skip-web      reuse build/ from an earlier gulp build
//   node html/build.mjs --music 96      music bitrate in kbps; "hq" keeps the original files, 0 drops music
//
// Every file becomes a base64 <script type="text/plain"> block. A tiny resolver turns them into
// blob: URLs on first use (game code asks through assetUrl(), Workers through a Worker shim),
// and saves go to IndexedDB through src/js/platform/web.js.
import { rspack } from "@rspack/core";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "build");
const argv = process.argv.slice(2);
const musicArg = argv.includes("--music") ? argv[argv.indexOf("--music") + 1] : "128";

if (!argv.includes("--skip-web")) {
    console.log("==> Building the game");
    execSync("npx gulp --cwd gulp build.standalone.full", { cwd: root, stdio: "inherit" });
}
if (!fs.existsSync(path.join(build, "index.html"))) {
    throw new Error("build/ is missing, run without --skip-web");
}

// ---- 1. JavaScript as one bundle, plus the three worker scripts ----------------------------------

console.log("==> Bundling the code into one chunk");
const jsOut = path.join(root, "build_output", "html-js");
fs.rmSync(jsOut, { recursive: true, force: true });
process.chdir(path.join(root, "gulp")); // the rspack config resolves its paths from gulp/
const { default: prod } = await import(
    pathToFileURL(path.join(root, "gulp/rspack.production.config.js")).href
);
await new Promise((resolve, reject) =>
    rspack(
        {
            ...prod,
            // There is no script URL to derive a public path from when the code is inline
            output: { ...prod.output, path: jsOut, publicPath: "" },
            // Translations etc. load through import(); pull them into the main bundle
            module: { ...prod.module, parser: { javascript: { dynamicImportMode: "eager" } } },
            // Keep each worker self-contained instead of sharing chunks with the main bundle
            optimization: { ...prod.optimization, splitChunks: false },
        },
        (err, stats) =>
            err || stats.hasErrors() ? reject(err ?? new Error(stats.toString("errors-only"))) : resolve()
    )
);
process.chdir(root);

// ---- 2. Music --------------------------------------------------------------------------------------

/** @returns {Map<string, string>} url path -> file */
function music() {
    const files = new Map();
    if (musicArg === "0") {
        return files;
    }
    if (musicArg === "hq") {
        for (const name of fs.readdirSync(path.join(build, "res/sounds/music"))) {
            files.set("res/sounds/music/" + name, path.join(build, "res/sounds/music", name));
        }
        return files;
    }
    const kbps = parseInt(musicArg, 10);
    if (!(kbps >= 32 && kbps <= 320)) {
        throw new Error("--music takes a bitrate between 32 and 320, hq or 0");
    }
    const sources = path.join(root, "res_raw/sounds/music");
    const cache = path.join(root, "build_output", `html-music-${kbps}k`);
    fs.mkdirSync(cache, { recursive: true });
    for (const source of fs.readdirSync(sources).filter(f => /\.(mp3|wav)$/i.test(f))) {
        const name = source.replace(/\.(mp3|wav)$/i, ".mp3");
        const dest = path.join(cache, name);
        const src = path.join(sources, source);
        if (!fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs) {
            console.log(`==> Encoding ${name} at ${kbps} kbps`);
            // Same volume as gulp/sounds.js applies to the regular builds
            execFileSync("ffmpeg", [
                "-y",
                "-v",
                "error",
                "-i",
                src,
                "-af",
                "volume=0.15",
                "-c:a",
                "libmp3lame",
                "-b:a",
                `${kbps}k`,
                "-ac",
                "2",
                "-ar",
                "44100",
                dest,
            ]);
        }
        files.set("res/sounds/music/" + name, dest);
    }
    return files;
}

// ---- 3. Everything else the game loads by URL ------------------------------------------------------

const assets = new Map();
const walk = dir =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const file of walk(path.join(build, "res"))) {
    const url = path.relative(build, file).split(path.sep).join("/");
    // Fonts are inlined into the CSS, music is added below
    if (!url.startsWith("res/fonts/") && !url.startsWith("res/sounds/music/")) {
        assets.set(url, file);
    }
}
for (const [url, file] of music()) {
    assets.set(url, file);
}
assets.set("async-resources.css", path.join(build, "async-resources.css"));
for (const name of fs.readdirSync(jsOut).filter(f => f.endsWith(".js") && f !== "bundle.js")) {
    assets.set(name, path.join(jsOut, name)); // worker scripts, looked up by file name
}

const MIME = {
    png: "image/png",
    gif: "image/gif",
    jpg: "image/jpeg",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    mp3: "audio/mpeg",
    webm: "video/webm",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
};

// ---- 4. The page -----------------------------------------------------------------------------------

const fontUrl =
    "data:font/woff2;base64," +
    fs.readFileSync(path.join(build, "res/fonts/GameFont.woff2")).toString("base64");
const inlineFont = css => css.replaceAll("url(res/fonts/GameFont.woff2)", `url(${fontUrl})`);

let page = inlineFont(fs.readFileSync(path.join(build, "index.html"), "utf8"));
const swap = (from, to) => {
    if (!page.includes(from)) {
        throw new Error("index.html changed, cannot find " + from);
    }
    page = page.replace(from, () => to);
};
swap(
    '<link rel="stylesheet" href="main.css">',
    `<style>${inlineFont(fs.readFileSync(path.join(build, "main.css"), "utf8"))}</style>`
);
swap('<script src="bundle.js"></script>', "");
const [head, tail] = page.split("</body>");

// Runs before the game: hands out blob: URLs for the embedded files, decoded on first use
const resolver = () => {
    const urls = new Map();
    let blocks = null;
    const decode = text => {
        if (Uint8Array.fromBase64) {
            return Uint8Array.fromBase64(text);
        }
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; ++i) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    };
    window.shapezEmbeddedAsset = path => {
        const key = String(path).replace(/^\.?\//, "");
        if (!urls.has(key)) {
            blocks ??= new Map(
                [...document.querySelectorAll("script[data-asset]")].map(el => [el.dataset.asset, el])
            );
            const el = blocks.get(key);
            if (!el) {
                return undefined;
            }
            urls.set(key, URL.createObjectURL(new Blob([decode(el.textContent)], { type: el.dataset.mime })));
            el.remove(); // the base64 text is no longer needed
        }
        return urls.get(key);
    };
    // Workers are created from "<chunk>.bundle.js" next to the page, which does not exist here
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
        constructor(url, options) {
            const name = String(url).split(/[?#]/)[0].split("/").pop();
            super(window.shapezEmbeddedAsset(name) ?? url, options);
        }
    };
};

const bundle = fs
    .readFileSync(path.join(jsOut, "bundle.js"), "utf8")
    // Keep the HTML parser inside the script element
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const outFile = path.join(root, "build_output", `shapez-ce-${version}.html`);
const fd = fs.openSync(outFile, "w");
fs.writeSync(fd, head);
for (const [url, file] of assets) {
    const mime = MIME[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
    fs.writeSync(fd, `<script type="text/plain" data-asset="${url}" data-mime="${mime}">`);
    fs.writeSync(fd, fs.readFileSync(file).toString("base64"));
    fs.writeSync(fd, "</script>\n");
}
fs.writeSync(fd, `<script>(${resolver.toString()})();</script>\n<script>${bundle}</script>\n</body>${tail}`);
fs.closeSync(fd);
fs.rmSync(jsOut, { recursive: true, force: true });

const mb = (fs.statSync(outFile).size / 1e6).toFixed(1);
console.log(`==> ${outFile} (${mb} MB, ${assets.size} embedded files)`);
