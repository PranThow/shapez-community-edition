import { GLOBAL_APP } from "@/core/globals";
import { SavegameStoredMods } from "@/savegame/savegame_typedefs";
import { Logger } from "../core/logging";
import { DisabledMod } from "./disabled_mod";
import { ErroredMod } from "./errored_mod";
import { isLoadedHere, listLocalModFiles, parseModFile, readLocalModFile } from "./local_mods";
import { Mod, ModConstructor } from "./mod";
import { ModInfo, ModMetadata, ModQueueEntry } from "./mod_metadata";
import { MOD_SIGNALS } from "./mod_signals";

const LOG = new Logger("mods");

export class ModLoader {
    private readonly mods = new Map<string, ModInfo>();

    // FIXME: Used for ModInterface, should be improved?
    readonly signals = MOD_SIGNALS;

    constructor() {
        LOG.log("modloader created");
    }

    get app() {
        return GLOBAL_APP;
    }

    get allMods(): ModInfo[] {
        return [...this.mods.values()];
    }

    get activeMods(): ModInfo[] {
        const mods: ModInfo[] = [];
        for (const mod of this.mods.values()) {
            if (mod.mod instanceof DisabledMod) {
                continue;
            }

            mods.push(mod);
        }

        return mods;
    }

    getModsListForSavegame(): SavegameStoredMods {
        // FIXME: new implementation TBD
        return this.activeMods
            .filter(info => info.mod.metadata.savegameResident)
            .map(({ mod }) => ({
                id: mod.metadata.id,
                version: mod.metadata.version,
                website: mod.metadata.website,
                name: mod.metadata.name,
                author: mod.metadata.authors.map(a => a.name).join(","),
            }));
    }

    computeModDifference(originalMods: SavegameStoredMods) {
        // FIXME: new implementation TBD
        const missing: SavegameStoredMods = [];
        const current = this.getModsListForSavegame();

        originalMods.forEach(mod => {
            for (let i = 0; i < current.length; ++i) {
                const currentMod = current[i];
                if (currentMod.id === mod.id && currentMod.version === mod.version) {
                    current.splice(i, 1);
                    return;
                }
            }
            missing.push(mod);
        });

        return {
            missing,
            extra: current,
        };
    }

    async initMods() {
        this.exposeExports();
        const queue: ModQueueEntry[] = await ipcRenderer.invoke("get-mods");

        // Mods can be parsed and constructed in parallel
        const loadedMods = await Promise.all(
            queue.map(async e => ({ entry: e, mod: await this.loadMod(e) }))
        );

        // Initialize all mods sequentially
        // TODO: Also collect early errors from the main process
        for (const { entry, mod } of loadedMods) {
            this.mods.set(mod.id, {
                source: entry.source,
                file: entry.file,
                mod,
            });

            await mod.init();
        }

        await this.initLocalMods();
    }

    /**
     * Loads .js (shapez 1.5) and, without an Electron mod host, .asar mods from the mods storage.
     * A broken mod is listed as errored instead of stopping the game from starting.
     */
    private async initLocalMods() {
        for (const fileName of await listLocalModFiles()) {
            if (!isLoadedHere(fileName)) {
                continue;
            }

            let metadata: ModMetadata = {
                id: fileName,
                entry: fileName,
                name: fileName,
                authors: [],
                version: "0",
                savegameResident: false,
            };
            try {
                const file = parseModFile(fileName, await readLocalModFile(fileName));
                metadata = file.metadata;
                if (this.mods.has(metadata.id)) {
                    LOG.warn(`Ignoring ${fileName}: a mod with id ${metadata.id} is already loaded`);
                    continue;
                }

                const mod = await file.create(this.app, this);
                this.mods.set(mod.id, { source: "user", file: fileName, mod });
                await mod.init();
            } catch (err) {
                LOG.error("Failed to load mod", fileName, err);
                const errored = new ErroredMod(metadata, this.app, this);
                errored.errors.push(err instanceof Error ? err : new Error(String(err)));
                this.mods.set(fileName, { source: "user", file: fileName, mod: errored });
            }
        }
    }

    private exposeExports() {
        const exports = {};
        const modules = import.meta.webpackContext("../", {
            recursive: true,
            regExp: /\.[jt]sx?$/,
            // NOTE: Worker scripts are executed if not explicitly excluded, which causes
            // infinite recursion!
            exclude: /\/webworkers\/|\\webworkers\\|\.d\.ts$/,
        });

        Array.from(modules.keys()).forEach(key => {
            const module = modules(key) as object;
            for (const member in module) {
                if (member === "default") {
                    continue;
                }
                if (exports[member]) {
                    throw new Error("Duplicate export of " + member);
                }

                Object.defineProperty(exports, member, {
                    get() {
                        return module[member];
                    },
                });
            }
        });

        window.shapez = exports;
    }

    private async loadMod(entry: ModQueueEntry): Promise<Mod> {
        if (entry.disabled) {
            return new DisabledMod(entry.metadata, this.app, this);
        }

        return await this.createModInstance(entry.metadata);
    }

    private async createModInstance(metadata: ModMetadata): Promise<Mod> {
        const url = this.getModEntryUrl(metadata);
        const module = await import(/* webpackIgnore: true */ url);

        if (!(module.default?.prototype instanceof Mod)) {
            throw new Error("Default export is not a Mod constructor");
        }

        const modClass: ModConstructor = module.default;
        const mod = new modClass(metadata, this.app, this);

        if (mod.id !== metadata.id) {
            throw new Error(`Mod was created with invalid ID "${mod.id}"`);
        }

        return mod;
    }

    private getModEntryUrl(mod: ModMetadata): string {
        return `mod://${mod.id}/${mod.entry}`;
    }
}

export const MODS = new ModLoader();
