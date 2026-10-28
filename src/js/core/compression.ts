import { decodeAsync, encode } from "@msgpack/msgpack";

export interface Compression {
    compress(data: unknown): Promise<Uint8Array>;
    decompress(data: Uint8Array): Promise<unknown>;
}

type CompressionWorkerResponse<T> = { result: T; error: null } | { result: null; error: Error };

// Same as the workers do. Used when a worker cannot start at all (e.g. a WebView that
// refuses worker scripts from its custom scheme), so saving never depends on workers.
async function compressOnMainThread(data: unknown): Promise<Uint8Array> {
    const gzip = new Blob([encode(data)]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(gzip).arrayBuffer());
}

async function decompressOnMainThread(data: Uint8Array): Promise<unknown> {
    return await decodeAsync(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip")));
}

let workersBroken = false;

export class DefaultCompression implements Compression {
    compress(data: unknown): Promise<Uint8Array> {
        if (workersBroken) {
            return compressOnMainThread(data);
        }
        const { promise, reject, resolve } = Promise.withResolvers<Uint8Array>();

        let worker: Worker;
        try {
            // NOTE: new URL(...) has to be inlined for webpack to process it correctly
            worker = new Worker(new URL("../webworkers/compression", import.meta.url));
        } catch {
            workersBroken = true;
            return compressOnMainThread(data);
        }
        worker.addEventListener("error", () => {
            // The worker reports its own failures as messages, so this means it never ran
            workersBroken = true;
            compressOnMainThread(data).then(resolve, reject);
        });

        worker.addEventListener("message", ev => {
            const response = ev.data as CompressionWorkerResponse<Uint8Array>;
            if (response.error !== null) {
                reject(response.error);
                return;
            }

            resolve(response.result);
        });

        this.scheduleWorkerTermination(worker);
        worker.postMessage(data);
        return promise;
    }

    decompress(data: Uint8Array): Promise<unknown> {
        if (workersBroken) {
            return decompressOnMainThread(data);
        }
        const { promise, reject, resolve } = Promise.withResolvers<unknown>();

        // The buffer is transferred to the worker, keep a copy in case the worker never starts
        const backup = data.slice();
        let worker: Worker;
        try {
            worker = new Worker(new URL("../webworkers/decompression", import.meta.url));
        } catch {
            workersBroken = true;
            return decompressOnMainThread(data);
        }
        worker.addEventListener("error", () => {
            workersBroken = true;
            decompressOnMainThread(backup).then(resolve, reject);
        });

        worker.addEventListener("message", ev => {
            const response = ev.data as CompressionWorkerResponse<unknown>;
            if (response.error !== null) {
                reject(response.error);
                return;
            }

            resolve(response.result);
        });

        this.scheduleWorkerTermination(worker);
        worker.postMessage(data, [data.buffer]);
        return promise;
    }

    private scheduleWorkerTermination(worker: Worker): void {
        worker.addEventListener("message", () => worker.terminate(), { once: true });
        worker.addEventListener("error", () => worker.terminate(), { once: true });
    }
}
