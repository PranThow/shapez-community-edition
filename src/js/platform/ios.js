/**
 * iOS (WKWebView) platform shim. The Electron build talks to its main process
 * through `window.ipcRenderer`; on iOS the native wrapper exposes two script
 * message handlers instead:
 *   - shapezIpc    (with reply): fs-job, mirrors electron/src/fsjob.ts
 *   - shapezNative (fire and forget): haptics, open URL
 * This module installs a compatible `ipcRenderer` so the rest of the game is unchanged.
 */
import { IS_IOS_APP } from "../core/config";
import { GLOBAL_APP } from "../core/globals";

// @ts-expect-error only exists inside WKWebView
const handlers = window.webkit?.messageHandlers;

/**
 * Sends a fire-and-forget message to the native side
 * @param {object} msg
 */
export function nativePost(msg) {
    handlers?.shapezNative?.postMessage(msg);
}

let lastHaptic = 0;
/**
 * Plays a haptic tick. Rate limited so long belt drags feel like a ratchet, not a buzz.
 * @param {"light"|"medium"|"rigid"|"selection"|"error"|"success"} style
 */
export function haptic(style = "light") {
    const now = performance.now();
    if (style === "light" && now - lastHaptic < 40) {
        return;
    }
    lastHaptic = now;
    nativePost({ type: "haptic", style });
}

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** @param {string} text */
function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

if (IS_IOS_APP) {
    // @ts-expect-error not declared on Window
    window.ipcRenderer = {
        async invoke(channel, payload) {
            switch (channel) {
                case "fs-job": {
                    const job = { ...payload };
                    if (job.contents) {
                        job.contents = toBase64(job.contents);
                    }
                    let result;
                    try {
                        result = await handlers.shapezIpc.postMessage(job);
                    } catch (err) {
                        // Same shape as Electron's error so FsError can parse the code (ENOENT etc.)
                        throw new Error(
                            `Error invoking remote method 'fs-job': Error: ${err instanceof Error ? err.message : err}`
                        );
                    }
                    if ((job.type === "read" || job.type === "open-external") && typeof result === "string") {
                        return fromBase64(result);
                    }
                    return result ?? undefined;
                }
                case "get-mods":
                    return [];
                case "set-fullscreen":
                    return;
            }
            throw new Error("Unsupported IPC channel on iOS: " + channel);
        },
        on() {},
        send() {},
    };

    // Called by the native side (callAsyncJavaScript) when the app is about to be suspended.
    // @ts-expect-error called by the native app
    window.shapezIOS = {
        async onBackground() {
            const state = GLOBAL_APP?.stateMgr?.getCurrentState();
            if (state && state.key === "InGameState") {
                // @ts-expect-error doSave only exists on InGameState
                await state.doSave();
                return "saved";
            }
            return "idle";
        },
    };
}
