import { IS_MOBILE } from "../core/config";
import { randomChoice } from "../core/utils";
import { T } from "../translations";

const hintsShown = [];

// Keyboard and mouse tips make no sense on a phone
const desktopOnly = /shift|ctrl|\balt\b|\bF\d\b|\bpress|mouse|click|hotkey|keybind|<b>[A-Z0-9]<\/b>|'[A-Z]'/i;
const getTips = () => (IS_MOBILE ? T.tips.filter(tip => !desktopOnly.test(tip)) : T.tips);

/**
 * Finds a new hint to show about the game which the user hasn't seen within this session
 */
export function getRandomHint() {
    const tips = getTips();
    let maxTries = 100 * tips.length;

    while (maxTries-- > 0) {
        const hint = randomChoice(tips);
        if (!hintsShown.includes(hint)) {
            hintsShown.push(hint);
            return hint;
        }
    }

    // All tips shown so far
    return randomChoice(tips);
}
