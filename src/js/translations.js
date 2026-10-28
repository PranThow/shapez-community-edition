import { globalConfig, IS_MOBILE } from "./core/config";
import { Logger } from "./core/logging";
import { LANGUAGES } from "./languages";

const logger = new Logger("translations");

// @ts-ignore
import baseTranslations from "./built-temp/base-en.json";

export const T = baseTranslations;

if (IS_MOBILE) {
    // The English texts talk about mice and keys; other languages keep their own wording
    const hints = T.ingame.interactiveTutorial.hints;
    hints["1_2_conveyor"] =
        "Connect the extractor with a <strong>conveyor belt</strong> to your hub!<br><br>Tip: <strong>Drag your finger</strong> to draw the belt!";
    hints["1_3_expand"] =
        "This is <strong>NOT</strong> an idle game! Build more extractors and belts to finish the goal quicker.<br><br>Tip: Buildings stay selected, so just keep tapping, and use <strong>Rotate</strong> to turn them.";
    hints["2_3_more_cutters"] =
        "Good job! Now place <strong>2 more cutters</strong> to speed up this slow process!<br><br>PS: Tap a building on the map and choose <strong>Pick</strong> to build more of it.";
    hints["3_1_rectangles"] =
        "Now let's extract some rectangles! <strong>Build 4 extractors</strong> and connect them to the hub.<br><br>PS: <strong>Hold, then drag</strong> a belt to draw a straight line!";
    hints["21_2_switch_to_wires"] =
        "Switch to the wires layer with the <strong>Wires</strong> button!<br><br>Then <strong>connect all four inputs</strong> of the painter with cables!";
    hints["21_4_press_button"] =
        "<strong>Tap</strong> the switch to make it <strong>emit a truthy signal</strong> and thus activate the painter.<br><br>PS: You don't have to connect all inputs! Try wiring only two.";
    hints["1_2_hold_and_drag"] = "Drag from here";

    const rewards = T.storyRewards;
    rewards.reward_rotator_ccw.desc =
        "You have unlocked a variant of the <strong>rotator</strong> - It allows you to rotate shapes counter-clockwise! To build it, select the rotator and <strong>tap its variant</strong> on the right!";
    rewards.reward_blueprints.desc =
        "You can now <strong>copy and paste</strong> parts of your factory! Select an area (<strong>hold, then drag</strong>, or use the Select tool) and tap <strong>Copy</strong>.<br><br>Pasting it is <strong>not free</strong>, you need to produce <strong>blueprint shapes</strong> to afford it! (Those you just delivered).";
    rewards.reward_wires_painter_and_levers.desc = rewards.reward_wires_painter_and_levers.desc.replace(
        "press <strong>E</strong>",
        "tap the <strong>Wires</strong> button"
    );
    T.mainMenu.noActiveSavegames = "No active savegames found - Tap play to start a new game!";
}

if (G_IS_DEV && globalConfig.debug.testTranslations) {
    // Replaces all translations by fake translations to see whats translated and what not
    const mapTranslations = obj => {
        for (const key in obj) {
            const value = obj[key];
            if (typeof value === "string") {
                obj[key] = value.replace(/[a-z]/gi, "x");
            } else {
                mapTranslations(value);
            }
        }
    };
    mapTranslations(T);
}

// Language key is something like de-DE or en or en-US
function mapLanguageCodeToId(languageKey) {
    const key = languageKey.toLowerCase();
    const shortKey = key.split("-")[0];

    // Try to match by key or short key
    for (const id in LANGUAGES) {
        const data = LANGUAGES[id];
        const code = data.code.toLowerCase();
        if (code === key) {
            console.log("-> Match", languageKey, "->", id);
            return id;
        }
        if (code === shortKey) {
            console.log("-> Match by short key", languageKey, "->", id);
            return id;
        }
    }

    // If none found, try to find a better alternative by using the base language at least
    for (const id in LANGUAGES) {
        const data = LANGUAGES[id];
        const code = data.code.toLowerCase();
        const shortCode = code.split("-")[0];

        if (shortCode === key) {
            console.log("-> Desperate Match", languageKey, "->", id);
            return id;
        }
        if (shortCode === shortKey) {
            console.log("-> Desperate Match by short key", languageKey, "->", id);
            return id;
        }
    }

    return null;
}

/**
 * Tries to auto-detect a language
 * @returns {string}
 */
export function autoDetectLanguageId() {
    const languages = navigator.languages;

    for (const language of languages) {
        logger.log("Trying to find language target for", language);
        const trans = mapLanguageCodeToId(language);
        if (trans) {
            return trans;
        }
    }

    // Fallback
    return "en";
}

/**
 * Loads translation data for the specified language
 * @param {string} code
 * @param {string | ""} region
 */
export async function loadTranslationData(code, region) {
    const locale = code + (region === "" ? "" : `-${region}`);
    return (await import(`./built-temp/base-${locale}.json`)).default;
}

export function matchDataRecursive(dest, src, addNewKeys = false) {
    if (typeof dest !== "object" || typeof src !== "object") {
        return;
    }
    if (dest === null || src === null) {
        return;
    }

    for (const key in dest) {
        if (src[key]) {
            // console.log("copy", key);
            const data = dest[key];
            if (typeof data === "object") {
                matchDataRecursive(dest[key], src[key], addNewKeys);
            } else if (typeof data === "string" || typeof data === "number") {
                // console.log("match string", key);
                dest[key] = src[key];
            } else {
                logger.log("Unknown type:", typeof data, "in key", key);
            }
        }
    }

    if (addNewKeys) {
        for (const key in src) {
            if (!dest[key]) {
                dest[key] = JSON.parse(JSON.stringify(src[key]));
            }
        }
    }
}

export async function updateApplicationLanguage(id) {
    logger.log("Setting application language:", id);

    const data = LANGUAGES[id];

    if (!data) {
        logger.error("Unknown language:", id);
        return;
    }

    if (id !== "en") {
        logger.log("Applying translations ...");
        const translations = await loadTranslationData(data.code, data.region);

        matchDataRecursive(T, translations);
    }

    // Translation overrides are used by mods
    matchDataRecursive(T, data.overrides, true);
}
