// Converts from degrees to radians.
Math.radians = function (degrees: number): number {
    return (degrees * Math.PI) / 180.0;
};

// Converts from radians to degrees.
Math.degrees = function (radians: number): number {
    return (radians * 180.0) / Math.PI;
};

// Begins a path and draws a circle.
CanvasRenderingContext2D.prototype.beginCircle = function (x: number, y: number, r: number): void {
    this.beginPath();

    if (r < 0.05) {
        this.rect(x, y, 1, 1);
        return;
    }

    this.arc(x, y, r, 0, 2.0 * Math.PI);
};

// Safari < 17.4, Chrome < 119, Firefox < 121
Promise.withResolvers ??= function <T>() {
    let resolve: PromiseWithResolvers<T>["resolve"], reject: PromiseWithResolvers<T>["reject"];
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
};

// Only exists in secure contexts, so plain http on a LAN address lacks it (savegames need it)
crypto.randomUUID ??= () =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
        (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)
    ) as ReturnType<Crypto["randomUUID"]>;
