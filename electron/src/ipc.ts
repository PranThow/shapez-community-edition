import { BrowserWindow, IpcMainInvokeEvent, ipcMain } from "electron";
import { FsJob, FsJobHandler } from "./fsjob.js";
import { ModLoader } from "./mods/loader.js";

export class IpcHandler {
    private readonly fsHandlers = new Map([
        ["saves", new FsJobHandler("saves")],
        // Same folder the mod host loads .asar mods from; the game itself loads .js mods there
        ["mods", new FsJobHandler("mods")],
    ]);
    private readonly modLoader: ModLoader;

    constructor(modLoader: ModLoader) {
        this.modLoader = modLoader;
    }

    install(window: BrowserWindow) {
        ipcMain.handle("fs-job", this.handleFsJob.bind(this));
        ipcMain.handle("get-mods", this.getMods.bind(this));
        ipcMain.handle("set-fullscreen", this.setFullscreen.bind(this, window));

        // Not implemented
        // ipcMain.handle("open-mods-folder", ...)
    }

    private handleFsJob(_event: IpcMainInvokeEvent, job: FsJob) {
        const handler = this.fsHandlers.get(job.id);
        if (handler === undefined) {
            throw new Error(`Storage ${job.id}/ is not implemented`);
        }

        return handler.handleJob(job);
    }

    private async getMods() {
        // TODO: Split mod reloads into a different IPC request
        await this.modLoader.loadMods();
        return this.modLoader.getAllMods();
    }

    private setFullscreen(window: BrowserWindow, _event: IpcMainInvokeEvent, flag: boolean) {
        if (window.isFullScreen() != flag) {
            window.setFullScreen(flag);
        }
    }
}
