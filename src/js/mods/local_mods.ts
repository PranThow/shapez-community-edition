/**
 * Mods loaded by the game itself from the "mods" storage, so they work where there is no
 * Electron mod host (the iOS app, the browser) and so plain shapez 1.5 (Steam) mod files work
 * everywhere. Two formats are accepted:
 *   - .asar: a Community Edition mod (mod.json + ES module entry). Electron loads these itself,
 *     so they are only read here on iOS and in the browser.
 *   - .js: a shapez 1.5 single-file mod (`METADATA` + `class Mod`), run the way 1.5 runs them.
 *
 * Storage locations: <userData>/mods on desktop, Documents/mods on iOS (Files app), IndexedDB in
 * the browser.
 */
import type { Application } from "@/application";
import { IS_ELECTRON } from "@/core/config";
import { Mod, ModConstructor } from "./mod";
import { ModMetadata } from "./mod_metadata";
import type { ModLoader } from "./modloader";

export const STORAGE_MODS = "mods";

/** A parsed mod file: its metadata, plus how to construct it */
export interface LocalModFile {
    metadata: ModMetadata;
    fileName: string;
    create(app: Application, loader: ModLoader): Promise<Mod>;
}

interface LegacyMetadata {
    id: string;
    name: string;
    version: string;
    author?: string;
    description?: string;
    website?: string;
    doesNotAffectSavegame?: boolean;
    settings?: unknown;
}

type AsarNode = { files: Record<string, AsarNode> } | { offset: string; size: number; unpacked?: boolean };

function fsJob(job: { type: string; filename?: string; contents?: Uint8Array }): Promise<unknown> {
    return ipcRenderer.invoke("fs-job", { id: STORAGE_MODS, ...job });
}

export function isModFileName(name: string) {
    return /\.(js|asar)$/i.test(name);
}

export async function listLocalModFiles(): Promise<string[]> {
    try {
        const names = ((await fsJob({ type: "list", filename: "" })) ?? []) as string[];
        return names.filter(isModFileName).sort();
    } catch {
        // The folder doesn't exist yet
        return [];
    }
}

export async function readLocalModFile(fileName: string): Promise<Uint8Array> {
    return new Uint8Array((await fsJob({ type: "read", filename: fileName })) as ArrayBufferLike);
}

export async function writeLocalModFile(fileName: string, contents: Uint8Array): Promise<void> {
    await fsJob({ type: "write", filename: fileName, contents });
}

export async function deleteLocalModFile(fileName: string): Promise<void> {
    await fsJob({ type: "delete", filename: fileName });
}

/** Whether this file is loaded by the renderer (true) or left to the Electron mod host */
export function isLoadedHere(fileName: string) {
    return !(IS_ELECTRON && /\.asar$/i.test(fileName));
}

export function isAsar(bytes: Uint8Array) {
    // Pickle header: UInt32 4 (size of the next field), then the header pickle size
    return bytes.length > 16 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === 4;
}

/**
 * Parses a mod file of either format. Throws with a readable message if it isn't a mod.
 * @param fileName only used for error messages and the legacy entry name
 */
export function parseModFile(fileName: string, bytes: Uint8Array): LocalModFile {
    return isAsar(bytes) ? parseAsarMod(bytes) : parseLegacyMod(fileName, bytes);
}

function parseAsarMod(bytes: Uint8Array): LocalModFile {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(4, true);
    const jsonSize = view.getUint32(12, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + jsonSize))) as AsarNode;
    const base = 8 + headerSize;

    const readFile = (path: string): Uint8Array | null => {
        let node: AsarNode | undefined = header;
        for (const part of path.replace(/^\.?\//, "").split("/")) {
            node = "files" in node ? node.files[part] : undefined;
            if (!node) {
                return null;
            }
        }
        if ("files" in node || node.unpacked) {
            return null;
        }
        const start = base + Number(node.offset);
        return bytes.subarray(start, start + node.size);
    };

    const json = readFile("mod.json");
    if (!json) {
        throw new Error("This .asar has no mod.json, so it isn't a shapez CE mod");
    }
    const raw = JSON.parse(new TextDecoder().decode(json));
    if (typeof raw.id !== "string" || typeof raw.entry !== "string" || typeof raw.version !== "string") {
        throw new Error("mod.json needs id, entry and version");
    }
    const metadata: ModMetadata = {
        id: raw.id,
        entry: raw.entry,
        name: raw.name ?? raw.id,
        description: raw.description,
        authors: Array.isArray(raw.authors) ? raw.authors : [],
        version: raw.version,
        savegameResident: raw.savegameResident ?? true,
        website: raw.website,
        source: raw.source,
    };

    const entry = readFile(metadata.entry);
    if (!entry) {
        throw new Error(`Entry ${metadata.entry} is missing from the .asar`);
    }

    return {
        metadata,
        fileName: metadata.id + ".asar",
        async create(app, loader) {
            // ponytail: entry is imported from a blob: URL, so a mod split into several ES modules
            // (relative imports) won't resolve. Bundle mods into one entry file, as CE mods usually are.
            const url = URL.createObjectURL(new Blob([entry], { type: "text/javascript" }));
            let module;
            try {
                module = await import(/* webpackIgnore: true */ url);
            } finally {
                URL.revokeObjectURL(url);
            }
            if (!(module.default?.prototype instanceof Mod)) {
                throw new Error("Default export is not a Mod constructor");
            }
            const mod: Mod = new (module.default as ModConstructor)(metadata, app, loader);

            // Assets (stylesheets, images) inside the .asar resolve to blob: URLs
            const urls = new Map<string, string>();
            // @ts-expect-error modInterface is protected; the resolver is ours to replace
            mod.modInterface.resolve = (path: string) => {
                if (!urls.has(path)) {
                    const data = readFile(path);
                    urls.set(path, data ? URL.createObjectURL(new Blob([data])) : "");
                }
                return urls.get(path)!;
            };
            return mod;
        },
    };
}

function parseLegacyMod(fileName: string, bytes: Uint8Array): LocalModFile {
    const code = new TextDecoder().decode(bytes);
    let found: { modClass: ModConstructor; meta: LegacyMetadata } | null = null;

    // Same contract as the shapez 1.5 mod loader
    const win = window as unknown as { $shapez_registerMod?: typeof register };
    const register = (modClass: ModConstructor, meta: LegacyMetadata) => {
        found = { modClass, meta };
    };
    win.$shapez_registerMod = register;
    try {
        new Function(
            code +
                `
            if (typeof Mod !== "undefined") {
                if (typeof METADATA !== "object") {
                    throw new Error("No METADATA variable found");
                }
                window.$shapez_registerMod(Mod, METADATA);
            }`
        )();
    } finally {
        delete win.$shapez_registerMod;
    }

    if (!found) {
        throw new Error(`${fileName} doesn't define a Mod class, so it isn't a shapez mod`);
    }
    const { modClass, meta } = found as { modClass: ModConstructor; meta: LegacyMetadata };
    if (typeof meta.id !== "string" || !meta.id) {
        throw new Error("METADATA.id is missing");
    }

    const metadata: ModMetadata = {
        id: meta.id,
        entry: meta.id + ".js",
        name: meta.name ?? meta.id,
        description: meta.description,
        authors: meta.author ? [{ name: meta.author }] : [],
        version: String(meta.version ?? "0"),
        savegameResident: !meta.doesNotAffectSavegame,
        website: meta.website,
    };

    return {
        metadata,
        fileName: metadata.entry,
        async create(app, loader) {
            const mod = new modClass(metadata, app, loader);
            if (meta.settings !== undefined) {
                await attachLegacySettings(mod, meta.id, meta.settings);
            }
            return mod;
        },
    };
}

/** shapez 1.5 mods get `this.settings` and `this.saveSettings()`; CE has no equivalent yet */
async function attachLegacySettings(mod: Mod, id: string, defaults: unknown) {
    const fileName = id + ".settings.json";
    let settings = structuredClone(defaults);
    try {
        settings = JSON.parse(new TextDecoder().decode(await readLocalModFile(fileName)));
    } catch {
        // No stored settings yet
    }
    const legacy = mod as Mod & { settings: unknown; saveSettings(): Promise<void> };
    legacy.settings = settings;
    legacy.saveSettings = () =>
        writeLocalModFile(fileName, new TextEncoder().encode(JSON.stringify(legacy.settings)));
}
