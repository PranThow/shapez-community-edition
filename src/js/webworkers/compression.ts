/// <reference lib="WebWorker" />

if (!(typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope)) {
    throw new Error("webworkers should never be run on the main thread!");
}

import { encode } from "@msgpack/msgpack";

async function compress(data: unknown): Promise<Uint8Array> {
    // Response, not Blob.stream(): WebKit fails to read Blobs inside a blob: worker of a file:// page
    const input = new Response(encode(data)).body!;
    const gzip = new CompressionStream("gzip");
    const response = new Response(input.pipeThrough(gzip));

    return new Uint8Array(await response.arrayBuffer());
}

self.addEventListener("message", async ev => {
    try {
        const result = await compress(ev.data);
        self.postMessage({ result, error: null }, [result.buffer]);
    } catch (err) {
        self.postMessage({ result: null, error: err });
    }
});
