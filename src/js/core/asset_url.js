/**
 * URL of a file that ships with the game, e.g. "res/logo.png". The single-file HTML build
 * embeds every file and registers a resolver for them; everywhere else the path stays as is.
 * @param {string} path
 * @returns {string}
 */
export function assetUrl(path) {
    // @ts-expect-error set by the single-file HTML build
    return window.shapezEmbeddedAsset?.(path) ?? path;
}
