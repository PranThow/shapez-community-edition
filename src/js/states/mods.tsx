import { ModAuthor, ModInfo } from "@/mods/mod_metadata";
import { MODS } from "@/mods/modloader";
import { deleteLocalModFile, parseModFile, STORAGE_MODS, writeLocalModFile } from "@/mods/local_mods";
import { TextualGameState } from "../core/textual_game_state";
import { T } from "../translations";

export class ModsState extends TextualGameState {
    constructor() {
        super("ModsState");
    }

    getStateHeaderTitle() {
        return T.mods.title;
    }

    protected getInitialContent() {
        // TODO: implement proper UI for disabled, errored mods etc.
        const modElements = MODS.allMods.map(info => this.getModElement(info));
        const hasMods = modElements.length > 0;

        if (!hasMods) {
            modElements.push(this.getNoModsMessage());
        }

        return (
            <>
                <div class="modsToolbar">
                    <button class="styledButton installMod">{T.mods.installMod}</button>
                    <span class="hint">{T.mods.installHint}</span>
                </div>
                <div class={`modsGrid ${hasMods ? "" : "noMods"}`}>{modElements}</div>
            </>
        );
    }

    onEnter() {
        this.trackClicks(this.htmlElement.querySelector(".installMod"), this.installMod);
        this.htmlElement.querySelectorAll<HTMLElement>(".removeMod").forEach(button => {
            this.trackClicks(button, () => this.removeMod(button.dataset.file));
        });
    }

    private getModElement({ mod, source, file }: ModInfo): HTMLElement {
        // TODO: Ensure proper design and localization once mods are reworked
        const error = mod.errors[0];
        return (
            <div class="mod">
                <div class="title">
                    <b>{mod.metadata.name}</b> by <i>{this.formatAuthors(mod.metadata.authors)}</i>
                </div>
                <div class="description">{mod.metadata.description}</div>
                {error && <div class="error">{error.message}</div>}
                <div class="advanced">
                    {mod.metadata.id} @ {mod.metadata.version}
                    {source === "user" && (
                        <button class="styledButton removeMod" data-file={this.fileName(file)}>
                            {T.mods.removeMod}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    /** Electron reports absolute paths for its own .asar mods; the storage wants the bare name */
    private fileName(file: string) {
        return file.split(/[\\/]/).pop();
    }

    private async installMod() {
        let bytes: Uint8Array | undefined;
        let name = "";
        try {
            // The browser's file picker has to open inside this click, so ask for it right away
            const picked = await ipcRenderer.invoke("fs-job", {
                id: STORAGE_MODS,
                type: "open-external",
                extension: "*",
            });
            if (!picked) {
                return;
            }
            bytes = new Uint8Array(picked);
            const file = parseModFile("the picked file", bytes);
            name = file.metadata.name;
            await writeLocalModFile(file.fileName, bytes);
        } catch (err) {
            this.dialogs.showWarning(T.mods.installFailed, String(err instanceof Error ? err.message : err));
            return;
        }
        this.askRestart(T.mods.installed.replace("<name>", name));
    }

    private async removeMod(file: string) {
        try {
            await deleteLocalModFile(file);
        } catch (err) {
            this.dialogs.showWarning(T.mods.installFailed, String(err instanceof Error ? err.message : err));
            return;
        }
        this.askRestart(T.mods.removed.replace("<name>", file));
    }

    private askRestart(text: string) {
        const { restart } = this.dialogs.showInfo(T.mods.title, text, ["later:bad", "restart:good"]);
        restart.add(() => window.location.reload());
    }

    private formatAuthors(authors: readonly ModAuthor[]): string {
        return authors.map(author => author.name).join(", ");
    }

    private getNoModsMessage(): HTMLElement {
        return <div class="noModsMessage">No mods are currently installed.</div>;
    }

    getDefaultPreviousState() {
        return "SettingsState";
    }
}
