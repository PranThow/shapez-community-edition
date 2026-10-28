/**
 * Plain browser platform (the single-file HTML build, or any static web server).
 * Electron's main process normally handles "fs-job"; here the same contract runs on
 * IndexedDB, or memory (with a warning) where a browser blocks storage.
 */
import { IS_WEB } from "../core/config";

const ENOENT = name =>
    new Error(
        `Error invoking remote method 'fs-job': Error: ENOENT: no such file or directory, open '${name}'`
    );

// Same file name rules as electron/src/fsjob.ts
const safeName = name => String(name ?? "").replace(/[^a-z.0-9_-]/gi, "_");

function indexedDbBackend() {
    const open = new Promise((resolve, reject) => {
        const request = indexedDB.open("shapez-ce", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("files");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const run = (mode, fn) =>
        open.then(
            db =>
                new Promise((resolve, reject) => {
                    const tx = db.transaction("files", mode);
                    const request = fn(tx.objectStore("files"));
                    tx.oncomplete = () => resolve(request.result);
                    tx.onerror = tx.onabort = () => reject(tx.error);
                })
        );
    return {
        ready: open,
        read: name => run("readonly", s => s.get(name)),
        write: (name, data) => run("readwrite", s => s.put(data, name)),
        delete: name => run("readwrite", s => s.delete(name)),
        list: () => run("readonly", s => s.getAllKeys()),
    };
}

function memoryBackend() {
    const files = new Map();
    return {
        read: async name => files.get(name),
        write: async (name, data) => void files.set(name, data),
        delete: async name => void files.delete(name),
        list: async () => [...files.keys()],
    };
}

async function pickBackend() {
    try {
        const backend = indexedDbBackend();
        await backend.ready;
        return backend;
    } catch (err) {
        console.warn("IndexedDB unavailable, progress will not be kept:", err);
    }
    const backend = memoryBackend();
    // Say it once, where people will see it, so nobody loses a factory unknowingly
    const banner = document.createElement("div");
    banner.textContent =
        "This browser blocks storage for local files, so progress is not saved. " +
        "Serve the file instead (python -m http.server) or use the download button on your savegame.";
    banner.style.cssText =
        "position:fixed;left:0;right:0;top:0;z-index:100000;padding:8px 12px;font:14px sans-serif;" +
        "background:#ef5072;color:#fff;text-align:center;pointer-events:none";
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 15000);
    return backend;
}

/** @param {string} extension */
function openFilePicker(extension) {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        if (extension && extension !== "*") {
            input.accept = "." + extension;
        }
        input.addEventListener("change", async () => {
            const file = input.files[0];
            resolve(file ? new Uint8Array(await file.arrayBuffer()) : undefined);
        });
        input.addEventListener("cancel", () => resolve(undefined));
        input.click();
    });
}

/**
 * @param {string} filename
 * @param {Uint8Array} contents
 */
function downloadFile(filename, contents) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([contents], { type: "application/octet-stream" }));
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

if (IS_WEB) {
    let backend = null;
    const getBackend = () => (backend ??= pickBackend());

    // @ts-expect-error not declared on Window
    window.ipcRenderer = {
        invoke(channel, payload) {
            switch (channel) {
                case "fs-job":
                    // The file picker must open synchronously, inside the click that asked for it
                    if (payload.type === "open-external") {
                        return openFilePicker(payload.extension);
                    }
                    if (payload.type === "save-external") {
                        downloadFile(payload.filename, payload.contents);
                        return Promise.resolve();
                    }
                    return getBackend().then(async storage => {
                        const name = safeName(payload.filename);
                        switch (payload.type) {
                            case "initialize":
                                return;
                            case "read": {
                                const data = await storage.read(name);
                                if (data === undefined) {
                                    throw ENOENT(name);
                                }
                                return data;
                            }
                            case "write":
                                return storage.write(name, payload.contents);
                            case "delete":
                                return storage.delete(name);
                            case "list":
                                return storage.list();
                        }
                        throw new Error("Unknown fs job type: " + payload.type);
                    });
                case "get-mods":
                    return Promise.resolve([]);
                case "set-fullscreen":
                    return Promise.resolve();
            }
            return Promise.reject(new Error("Unsupported IPC channel in the browser: " + channel));
        },
        on() {},
        send() {},
    };

    // Copy buttons use the async clipboard, which only exists in secure contexts
    if (!navigator.clipboard) {
        // @ts-expect-error read-only in the DOM typings
        navigator.clipboard = {
            writeText: async text => {
                const area = document.createElement("textarea");
                area.value = text;
                area.style.cssText = "position:fixed;opacity:0";
                document.body.appendChild(area);
                area.select();
                document.execCommand("copy");
                area.remove();
            },
        };
    }
}
