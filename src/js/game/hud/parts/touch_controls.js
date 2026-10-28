import { ClickDetector, clickDetectorGlobals } from "../../../core/click_detector";
import { globalConfig } from "../../../core/config";
import { STOP_PROPAGATION } from "../../../core/signal";
import { makeDiv } from "../../../core/utils";
import { Vector } from "../../../core/vector";
import { haptic } from "../../../platform/ios";
import { SOUNDS } from "../../../platform/sound";
import { getBuildingDataFromCode } from "../../building_codes";
import { enumMouseButton } from "../../camera";
import { KEYMAPPINGS } from "../../key_action_mapper";
import { enumHubGoalRewards } from "../../tutorial_goals";
import { BaseHUDPart } from "../base_hud_part";

/**
 * Touch controls. One finger acts (place / erase / select / move a blueprint, or pans
 * when nothing is selected), two fingers always navigate. The game logic itself is
 * driven through the same camera signals the mouse uses, so every existing rule
 * (belt auto-orientation, tunnels, planner, blueprints) behaves exactly as on desktop.
 *
 *   tap               place / erase / toggle selection / inspect a building
 *   drag              draw belts & buildings, erase along a path, box-select, pan
 *   hold, then drag   straight belt planner while placing, otherwise box-select
 *   two fingers       pan + pinch zoom (with fling), a quick two finger tap = back
 */

const TAP_SLOP = 10; // px a finger may wander and still count as a tap
const DRAG_CONFIRM_MS = 70; // a second finger often lands this late; don't build before it could have
const LONG_PRESS_MS = 380;
const TWO_FINGER_TAP_MS = 280;
const TWO_FINGER_TAP_TRAVEL = 30;
const PLACEMENT_HYSTERESIS = 0.22; // tiles past an edge before a drawn belt turns, kills finger jitter
const HINT_SHOW_LIMIT = 4;

const TOOL = { build: "build", erase: "erase", select: "select" };

const ICONS = {
    select: `<rect x="4" y="4" width="16" height="16" rx="2.5" stroke-dasharray="3.2 2.8"/><path d="M12 9v6M9 12h6"/>`,
    erase: `<path d="M8.5 19.5h11"/><path d="M14.6 4.4 20 9.8a1.5 1.5 0 0 1 0 2.1l-7.6 7.6H8.5l-4.1-4.1a1.5 1.5 0 0 1 0-2.1z"/><path d="m9.2 9.8 5.4 5.4"/>`,
    layers: `<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>`,
    close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
    line: `<path d="M5.5 5.5v13h13"/><circle cx="5.5" cy="5.5" r="1.6" fill="currentColor"/><circle cx="18.5" cy="18.5" r="1.6" fill="currentColor"/>`,
    flip: `<path d="M5.5 18.5v-13h13" stroke-dasharray="2.6 2.4"/><path d="M5.5 18.5h13v-13"/>`,
    rotateCw: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.6h-4.6"/>`,
    rotateCcw: `<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4.6h4.6"/>`,
    place: `<path d="M5 12.8l4.6 4.6L19.2 7.6"/>`,
    delete: `<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/><path d="M10.5 11v5.5M13.5 11v5.5"/>`,
    clear: `<circle cx="12" cy="12" r="7.5"/><path d="M6.7 17.3 17.3 6.7"/>`,
    cut: `<circle cx="6.5" cy="17.5" r="2.8"/><circle cx="6.5" cy="6.5" r="2.8"/><path d="M8.6 8.4 20 19.5M8.6 15.6 20 4.5"/>`,
    copy: `<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>`,
    paste: `<rect x="5.5" y="5" width="13" height="15.5" rx="2"/><path d="M9 5V3.5h6V5"/><path d="M9 11h6M9 14.5h4"/>`,
    marker: `<path d="M6 21V4h10.5l-2 4 2 4H6"/>`,
    pick: `<path d="M13.4 6.6 17.4 10.6"/><path d="M15.7 4.3a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3L18 10l-4-4z"/><path d="m14.2 7.4-8.5 8.5L5 19l3.1-.7 8.5-8.5"/>`,
};

const svg = name =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

export class HUDTouchControls extends BaseHUDPart {
    createElements(parent) {
        this.element = makeDiv(parent, "ingame_HUD_TouchControls");
        this.toolsColumn = makeDiv(this.element, null, ["column", "tools"]);
        this.actionsColumn = makeDiv(this.element, null, ["column", "actions"]);
        this.hintElement = makeDiv(this.element, null, ["hint"]);

        this.pillElement = makeDiv(parent, "ingame_HUD_TouchPill");
    }

    initialize() {
        this.tool = TOOL.build;
        this.lineMode = false;

        /** @type {Map<number, Vector>} */
        this.touches = new Map();
        /** @type {null|"pending"|"pan"|"place"|"erase"|"lasso"|"blueprint"|"pinch"|"settle"} */
        this.gesture = null;
        this.startPos = new Vector();
        this.startTime = 0;
        this.longPressTimer = null;
        this.plannerGesture = false;
        this.stableTile = new Vector();
        this.lastPointer = null;
        this.pinchLast = null;
        /** @type {{ start: number, travel: number }|null} */
        this.twoFingerTap = null;

        /** The building the last tap placed: the rotate buttons turn it in place until the map is touched again */
        this.lastTapPlaced = null;
        this.lastPlaced = null;

        /** Blueprint ghost position, kept in world space so it stays put while the map moves */
        this.blueprintCursor = null;
        this.blueprintDragLast = null;

        this.pillEntity = null;
        this.hintCounts = this.loadHintCounts();
        this.hintTimer = null;
        this.uiKey = null;

        this.createButtons();

        const canvas = this.root.canvas;
        this.listeners = {
            touchstart: this.onTouchStart.bind(this),
            touchmove: this.onTouchMove.bind(this),
            touchend: ev => this.onTouchEnd(ev, false),
            touchcancel: ev => this.onTouchEnd(ev, true),
        };
        for (const [type, fn] of Object.entries(this.listeners)) {
            canvas.addEventListener(type, fn, { passive: false });
        }

        this.root.signals.entityManuallyPlaced.add(entity => {
            this.lastPlaced = entity;
            haptic("light");
        });
        this.root.signals.entityQueuedForDestroy.add(entity => {
            if (this.gesture === "erase" || this.erasingTap) {
                haptic("light");
            }
            if (entity === this.pillEntity) {
                this.hidePill();
            }
        });
        this.root.hud.signals.selectedPlacementBuildingChanged.add(building => {
            if (building) {
                this.tool = TOOL.build;
                this.hidePill();
            }
            this.lastTapPlaced = null;
        });
        this.root.signals.editModeChanged.add(() => this.hidePill());
    }

    cleanup() {
        super.cleanup();
        this.cleanupPillDetectors();
        for (const [type, fn] of Object.entries(this.listeners)) {
            this.root.canvas.removeEventListener(type, fn);
        }
        clearTimeout(this.longPressTimer);
        clearTimeout(this.hintTimer);
    }

    // ---------------------------------------------------------------------------------------------
    // Shortcuts

    get parts() {
        return this.root.hud.parts;
    }

    get placer() {
        return this.root.hud.parts.buildingPlacer;
    }

    get blueprint() {
        return this.root.hud.parts.blueprintPlacer.currentBlueprint.get();
    }

    /** @param {Vector|null} pos */
    setPointer(pos) {
        this.root.app.mousePosition = pos;
        if (pos) {
            this.lastPointer = pos;
        }
    }

    /** @param {Vector} pos */
    toTile(pos) {
        return this.root.camera.screenToWorld(pos).toTileSpace();
    }

    primaryPos() {
        return this.touches.values().next().value;
    }

    firstTwo() {
        const it = this.touches.values();
        return [it.next().value, it.next().value];
    }

    /**
     * Sends a full click through the same pipeline as the mouse
     * @param {Vector} pos
     * @param {enumMouseButton} button
     */
    click(pos, button) {
        this.setPointer(pos);
        const result = this.root.camera.downPreHandler.dispatch(pos, button);
        this.root.camera.upPostHandler.dispatch(pos);
        return result;
    }

    // ---------------------------------------------------------------------------------------------
    // Gesture recognition

    /** @param {TouchEvent} ev */
    onTouchStart(ev) {
        if (ev.cancelable) {
            ev.preventDefault();
        }
        clickDetectorGlobals.lastTouchTime = performance.now();
        for (const t of ev.changedTouches) {
            this.touches.set(t.identifier, new Vector(t.clientX, t.clientY));
        }

        if (this.touches.size === 1 && this.gesture === null) {
            const pos = this.primaryPos();
            this.gesture = "pending";
            this.startPos = pos;
            this.startTime = performance.now();
            this.lastTapPlaced = null;
            this.twoFingerTap = null;

            // Catch the map like a scroll view does
            this.root.camera.touchPostMoveVelocity = new Vector(0, 0);

            clearTimeout(this.longPressTimer);
            this.longPressTimer = setTimeout(() => this.onLongPress(), LONG_PRESS_MS);

            if (!this.blueprint && this.placer.currentMetaBuilding.get()) {
                // Ghost under the finger, so you see what you are about to place
                this.setPointer(pos);
            }
            return;
        }

        if (this.touches.size >= 2 && this.gesture !== "pinch") {
            this.startPinch();
        } else if (this.gesture === "pinch") {
            this.pinchLast = this.firstTwo();
        }
    }

    /** @param {TouchEvent} ev */
    onTouchMove(ev) {
        if (ev.cancelable) {
            ev.preventDefault();
        }
        for (const t of ev.changedTouches) {
            if (this.touches.has(t.identifier)) {
                this.touches.set(t.identifier, new Vector(t.clientX, t.clientY));
            }
        }
        const pos = this.primaryPos();
        if (!pos) {
            return;
        }

        switch (this.gesture) {
            case "pending": {
                const distance = pos.distance(this.startPos);
                if (distance < TAP_SLOP) {
                    return;
                }
                if (performance.now() - this.startTime < DRAG_CONFIRM_MS && distance < 3 * TAP_SLOP) {
                    return;
                }
                clearTimeout(this.longPressTimer);
                this.beginDrag(pos);
                return;
            }
            case "pan":
                if (this.twoFingerTap) {
                    this.twoFingerTap.travel += pos.distance(this.root.camera.lastMovingPosition);
                }
                this.root.camera.panTo(pos);
                return;
            case "place":
            case "erase":
            case "lasso":
                this.dragAction(pos);
                return;
            case "blueprint":
                this.moveBlueprint(pos);
                return;
            case "pinch": {
                const [a, b] = this.firstTwo();
                if (!b) {
                    return;
                }
                const [lastA, lastB] = this.pinchLast;
                this.twoFingerTap.travel += a.distance(lastA) + b.distance(lastB);
                this.root.camera.pinch(lastA, lastB, a, b);
                this.pinchLast = [a, b];
            }
        }
    }

    /**
     * @param {TouchEvent} ev
     * @param {boolean} cancelled iOS cancels touches for system gestures; never commit those
     */
    onTouchEnd(ev, cancelled) {
        if (ev.cancelable) {
            ev.preventDefault();
        }
        clickDetectorGlobals.lastTouchTime = performance.now();
        let ours = false;
        for (const t of ev.changedTouches) {
            ours = this.touches.delete(t.identifier) || ours;
        }
        if (!ours) {
            // A finger we never tracked (e.g. one that started on a button)
            return;
        }
        const remaining = this.touches.size;

        switch (this.gesture) {
            case "pending":
                clearTimeout(this.longPressTimer);
                if (cancelled) {
                    this.setPointer(null);
                } else {
                    this.handleTap(this.startPos);
                }
                break;

            case "place":
            case "erase":
            case "lasso":
                this.endAction(cancelled);
                break;

            case "pinch":
                if (remaining >= 2) {
                    this.pinchLast = this.firstTwo();
                    return;
                }
                this.root.camera.endPan();
                if (remaining === 1) {
                    // Keep moving the map with the finger that stayed, like a maps app
                    this.root.camera.beginPan(this.primaryPos());
                    this.gesture = "pan";
                    return;
                }
                this.finishTwoFinger(cancelled);
                break;

            case "pan":
                if (remaining > 0) {
                    return;
                }
                this.root.camera.endPan();
                this.finishTwoFinger(cancelled);
                break;
        }

        this.gesture = remaining > 0 ? "settle" : null;
    }

    onLongPress() {
        if (this.gesture !== "pending" || this.touches.size !== 1 || this.blueprint) {
            return;
        }
        if (this.root.camera.getIsMapOverlayActive()) {
            return;
        }

        haptic("medium");
        this.hidePill();
        const pos = this.primaryPos();
        const building = this.placer.currentMetaBuilding.get();

        if (this.tool === TOOL.build && building) {
            // Hold, then drag: the straight belt planner (shift on desktop)
            const planner = building.getHasDirectionLockAvailable(this.placer.currentVariant.get());
            this.beginAction("place", pos, planner);
        } else {
            // Hold, then drag: box selection. With the eraser it deletes the box on release
            this.beginAction("lasso", pos);
        }
    }

    /** @param {Vector} pos */
    beginDrag(pos) {
        this.hidePill();
        if (this.blueprint) {
            this.gesture = "blueprint";
            this.blueprintDragLast = this.startPos;
            this.moveBlueprint(pos);
            return;
        }

        const overview = this.root.camera.getIsMapOverlayActive();
        if (!overview) {
            if (this.tool === TOOL.select) {
                return this.beginAction("lasso", pos);
            }
            if (this.tool === TOOL.erase) {
                return this.beginAction("erase", pos);
            }
            if (this.placer.currentMetaBuilding.get()) {
                return this.beginAction("place", pos);
            }
        }

        this.gesture = "pan";
        this.setPointer(null);
        this.root.camera.beginPan(this.startPos);
        this.root.camera.panTo(pos);
    }

    /**
     * @param {"place"|"erase"|"lasso"} kind
     * @param {Vector} pos
     * @param {boolean=} planner
     */
    beginAction(kind, pos, planner = false) {
        this.gesture = kind;
        if (kind === "place") {
            this.plannerGesture = planner;
            this.placer.forceDirectionLock = this.lineMode || planner;
            this.stableTile = this.toTile(this.startPos);
        } else if (kind === "lasso") {
            this.parts.massSelector.forceSelect = true;
        }

        this.setPointer(this.startPos);
        const button = kind === "erase" ? enumMouseButton.right : enumMouseButton.left;
        this.root.camera.downPreHandler.dispatch(this.startPos, button);
        this.dragAction(pos);
    }

    /** @param {Vector} pos */
    dragAction(pos) {
        if (this.gesture === "place" && !this.placer.forceDirectionLock) {
            pos = this.stabilize(pos);
        }
        this.setPointer(pos);
        this.root.camera.movePreHandler.dispatch(pos);
    }

    /** @param {boolean} cancelled */
    endAction(cancelled) {
        const mass = this.parts.massSelector;
        if (cancelled) {
            // Nothing pending gets committed: no planner line, no box selection
            this.placer.abortDragging();
            mass.currentSelectionStartWorld = null;
        }

        this.root.camera.upPostHandler.dispatch(this.lastPointer);

        const wasLasso = this.gesture === "lasso";
        this.plannerGesture = false;
        this.placer.forceDirectionLock = this.lineMode;
        mass.forceSelect = false;
        this.setPointer(null);

        if (wasLasso && this.tool === TOOL.erase && !cancelled && mass.selectedUids.size > 0) {
            mass.confirmDelete();
            haptic("medium");
        }
    }

    /**
     * Snaps a finger position to tile centers with hysteresis, so a slightly wobbly
     * straight drag doesn't produce a zig-zag belt
     * @param {Vector} pos
     */
    stabilize(pos) {
        const tileSize = globalConfig.tileSize;
        const world = this.root.camera.screenToWorld(pos).divideScalar(tileSize);
        const tile = this.stableTile;
        if (world.x < tile.x - PLACEMENT_HYSTERESIS || world.x > tile.x + 1 + PLACEMENT_HYSTERESIS) {
            tile.x = Math.floor(world.x);
        }
        if (world.y < tile.y - PLACEMENT_HYSTERESIS || world.y > tile.y + 1 + PLACEMENT_HYSTERESIS) {
            tile.y = Math.floor(world.y);
        }
        return this.root.camera.worldToScreen(
            new Vector((tile.x + 0.5) * tileSize, (tile.y + 0.5) * tileSize)
        );
    }

    startPinch() {
        clearTimeout(this.longPressTimer);
        switch (this.gesture) {
            case "place":
            case "erase":
            case "lasso":
                // A second finger means "I want to navigate": drop the half done planner / box
                this.endAction(true);
                break;
            case "pan":
                this.root.camera.endPan();
                break;
        }
        this.gesture = "pinch";
        this.pinchLast = this.firstTwo();
        this.twoFingerTap = { start: performance.now(), travel: 0 };
        if (!this.blueprint) {
            this.setPointer(null);
        }
    }

    /** @param {boolean} cancelled */
    finishTwoFinger(cancelled) {
        const tap = this.twoFingerTap;
        this.twoFingerTap = null;
        if (
            tap &&
            !cancelled &&
            performance.now() - tap.start < TWO_FINGER_TAP_MS &&
            tap.travel < TWO_FINGER_TAP_TRAVEL
        ) {
            this.back();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Taps

    /** @param {Vector} pos */
    handleTap(pos) {
        if (this.blueprint) {
            if (this.blueprintContains(this.toTile(pos))) {
                this.placeBlueprint();
            } else {
                this.blueprintCursor = this.root.camera.screenToWorld(pos);
            }
            return;
        }

        if (this.root.camera.getIsMapOverlayActive()) {
            // Only map markers react in the overview
            this.click(pos, enumMouseButton.left);
            this.setPointer(null);
            return;
        }

        if (this.tool === TOOL.erase) {
            this.erasingTap = true;
            this.click(pos, enumMouseButton.right);
            this.erasingTap = false;
        } else if (this.tool === TOOL.select) {
            this.toggleSelection(pos);
        } else if (this.placer.currentMetaBuilding.get()) {
            this.lastPlaced = null;
            this.click(pos, enumMouseButton.left);
            this.lastTapPlaced = this.lastPlaced;
        } else if (this.click(pos, enumMouseButton.left) !== STOP_PROPAGATION) {
            // Nothing claimed the tap (levers, constant signals, markers do), so inspect the building
            this.inspect(pos);
        }

        if (!this.pillEntity) {
            this.setPointer(null);
        }
    }

    /** @param {Vector} pos */
    toggleSelection(pos) {
        const tile = this.toTile(pos);
        const entity = this.root.map.getLayerContentXY(tile.x, tile.y, this.root.currentLayer);
        if (!entity || !this.root.logic.canDeleteBuilding(entity)) {
            return;
        }
        const uids = this.parts.massSelector.selectedUids;
        if (uids.has(entity.uid)) {
            uids.delete(entity.uid);
        } else {
            uids.add(entity.uid);
        }
        haptic("selection");
    }

    /** @param {Vector} pos */
    inspect(pos) {
        const tile = this.toTile(pos);
        const entity = this.root.map.getLayerContentXY(tile.x, tile.y, this.root.currentLayer);
        if (!entity || entity === this.pillEntity) {
            this.hidePill();
            return;
        }
        this.pillEntity = entity;
        this.parts.shapeTooltip.forceActive = true;
        haptic("selection");
        this.renderPill();
    }

    hidePill() {
        if (this.pillEntity) {
            this.pillEntity = null;
            this.parts.shapeTooltip.forceActive = false;
            this.pillElement.classList.remove("visible");
            this.setPointer(null);
        }
    }

    renderPill() {
        const entity = this.pillEntity;
        const deletable = this.root.logic.canDeleteBuilding(entity);
        this.pillElement.innerHTML = "";
        this.cleanupPillDetectors();

        const add = (icon, label, cls, handler) => {
            const button = makeDiv(this.pillElement, null, ["tcBtn", cls]);
            button.innerHTML = svg(icon) + `<span>${label}</span>`;
            const detector = new ClickDetector(button, { consumeEvents: true });
            detector.click.add(handler);
            this.pillDetectors.push(detector);
        };

        add("pick", "Pick", "pick", () => {
            const center = entity.components.StaticMapEntity.getTileSpaceBounds().getCenter().toWorldSpace();
            this.hidePill();
            this.setPointer(this.root.camera.worldToScreen(center));
            this.placer.startPipette();
            this.setPointer(null);
        });
        if (deletable) {
            add("select", "Select", "selectOne", () => {
                this.parts.massSelector.selectedUids.add(entity.uid);
                this.hidePill();
            });
            add("delete", "Delete", "danger", () => {
                if (this.root.logic.tryDeleteBuilding(entity)) {
                    this.root.soundProxy.playUi(SOUNDS.destroyBuilding);
                    haptic("medium");
                }
                this.hidePill();
            });
        }
        this.pillElement.classList.add("visible");
        this.updatePillPosition();
    }

    cleanupPillDetectors() {
        for (const detector of this.pillDetectors || []) {
            detector.cleanup();
        }
        this.pillDetectors = [];
    }

    updatePillPosition() {
        const entity = this.pillEntity;
        const bounds = entity.components.StaticMapEntity.getTileSpaceBounds();
        const camera = this.root.camera;
        const center = bounds.getCenter().toWorldSpace();
        const top = camera.worldToScreen(new Vector(center.x, bounds.y * globalConfig.tileSize));
        const bottom = camera.worldToScreen(new Vector(center.x, bounds.bottom() * globalConfig.tileSize));

        // Above the building if there is room, otherwise below it
        const pillHeight = this.pillElement.offsetHeight || 60;
        const above = top.y - pillHeight - 12 > 8;
        const x = Math.max(8, Math.min(this.root.gameWidth - 8, top.x));
        this.pillElement.style.left = x + "px";
        this.pillElement.style.top = (above ? top.y - 12 : bottom.y + 12) + "px";
        this.pillElement.classList.toggle("below", !above);

        // Keeps the shape tooltip pointed at the inspected building while the map moves
        this.setPointer(camera.worldToScreen(center));
    }

    // ---------------------------------------------------------------------------------------------
    // Blueprints

    /** @param {Vector} pos */
    moveBlueprint(pos) {
        // Relative movement: the ghost keeps its offset to the finger and stays visible
        const delta = pos.sub(this.blueprintDragLast).divideScalar(this.root.camera.zoomLevel);
        this.blueprintCursor = this.blueprintCursor.add(delta);
        this.blueprintDragLast = pos;
    }

    /** @param {Vector} tile */
    blueprintContains(tile) {
        const anchor = this.blueprintCursor.toTileSpace();
        // @ts-ignore private in TS, fine to read
        return this.blueprint.entities.some(entity =>
            entity.components.StaticMapEntity.getTileSpaceBounds().containsPoint(
                tile.x - anchor.x + 0.5,
                tile.y - anchor.y + 0.5
            )
        );
    }

    placeBlueprint() {
        const before = this.root.entityMgr.entities.size;
        this.parts.blueprintPlacer.onMouseDown(this.root.app.mousePosition, enumMouseButton.left);
        haptic(this.root.entityMgr.entities.size > before ? "medium" : "error");
    }

    // ---------------------------------------------------------------------------------------------
    // Buttons

    createButtons() {
        const tools = this.toolsColumn;
        const actions = this.actionsColumn;
        const mass = () => this.parts.massSelector;

        /**
         * @type {Array<{ id: string, icon: string, label: string, column: HTMLElement, cls?: string,
         *  sound?: boolean, visible: (s: any) => boolean, active?: (s: any) => boolean, run: () => void }>}
         */
        this.buttons = [
            {
                id: "select",
                icon: "select",
                label: "Select",
                column: tools,
                visible: s => !s.overview,
                active: () => this.tool === TOOL.select,
                run: () => this.setTool(TOOL.select),
            },
            {
                id: "erase",
                icon: "erase",
                label: "Erase",
                column: tools,
                visible: s => !s.overview,
                active: () => this.tool === TOOL.erase,
                run: () => this.setTool(TOOL.erase),
            },
            {
                id: "layers",
                icon: "layers",
                label: "Wires",
                column: tools,
                visible: s => s.wiresUnlocked && !s.overview,
                active: s => s.layer === "wires",
                run: () => this.root.keyMapper.getBinding(KEYMAPPINGS.ingame.switchLayers).signal.dispatch(),
            },

            {
                id: "close",
                icon: "close",
                label: "Done",
                column: actions,
                visible: s => s.mode !== "idle",
                run: () => this.back(),
            },
            {
                id: "line",
                icon: "line",
                label: "Line",
                column: actions,
                visible: s => s.mode === "placing" && s.lockAvailable,
                active: () => this.lineMode,
                run: () => {
                    this.lineMode = !this.lineMode;
                    this.placer.forceDirectionLock = this.lineMode;
                    this.showHint(this.lineMode ? "line" : "placing", true);
                },
            },
            {
                id: "flip",
                icon: "flip",
                label: "Corner",
                column: actions,
                sound: false,
                visible: s =>
                    s.mode === "placing" && s.lockAvailable && (this.lineMode || this.plannerGesture),
                run: () => this.placer.switchDirectionLockSide(),
            },
            {
                id: "delete",
                icon: "delete",
                label: "Delete",
                cls: "danger",
                column: actions,
                visible: s => s.mode === "selection",
                run: () => mass().confirmDelete(),
            },
            {
                id: "clear",
                icon: "clear",
                label: "Clear",
                column: actions,
                visible: s => s.mode === "selection",
                run: () => mass().clearBelts(),
            },
            {
                id: "cut",
                icon: "cut",
                label: "Cut",
                column: actions,
                visible: s => s.mode === "selection",
                run: () => mass().confirmCut(),
            },
            {
                id: "copy",
                icon: "copy",
                label: "Copy",
                column: actions,
                visible: s => s.mode === "selection",
                run: () => mass().startCopy(),
            },
            {
                id: "marker",
                icon: "marker",
                label: "Marker",
                column: actions,
                visible: s => s.mode === "idle" && s.overview,
                run: () => this.parts.waypoints?.requestSaveMarker({}),
            },
            {
                id: "paste",
                icon: "paste",
                label: "Paste",
                column: actions,
                visible: s => s.mode === "idle" && s.canPaste && !s.overview,
                run: () => this.parts.blueprintPlacer.pasteBlueprint(),
            },
            {
                id: "rotateCcw",
                icon: "rotateCcw",
                label: "Rotate",
                column: actions,
                sound: false,
                visible: s => s.mode === "placing" || s.mode === "blueprint",
                run: () => this.rotate(true),
            },
            {
                id: "rotateCw",
                icon: "rotateCw",
                label: "Rotate",
                column: actions,
                sound: false,
                visible: s => s.mode === "placing" || s.mode === "blueprint",
                run: () => this.rotate(false),
            },
            {
                id: "place",
                icon: "place",
                label: "Place",
                cls: "primary",
                column: actions,
                sound: false,
                visible: s => s.mode === "blueprint",
                run: () => this.placeBlueprint(),
            },
        ];

        for (const button of this.buttons) {
            const element = makeDiv(button.column, null, ["tcBtn", button.id, button.cls].filter(Boolean));
            element.innerHTML = svg(button.icon) + `<span>${button.label}</span>`;
            this.trackClicks(
                element,
                () => {
                    if (button.sound === false) {
                        haptic("selection");
                    }
                    button.run();
                    this.uiKey = null; // refresh right away
                },
                button.sound === false ? { clickSound: null } : {}
            );
            button.element = element;
        }

        // Shows which way the next building faces
        this.directionBadge = makeDiv(this.buttons.find(b => b.id === "rotateCw").element, null, [
            "direction",
        ]);
    }

    /** @param {string} tool */
    setTool(tool) {
        this.tool = this.tool === tool ? TOOL.build : tool;
        if (this.tool !== TOOL.build) {
            this.placer.currentMetaBuilding.set(null);
            this.parts.blueprintPlacer.abortPlacement();
        }
        this.hidePill();
    }

    /** @param {boolean} inverse */
    rotate(inverse) {
        const blueprint = this.blueprint;
        if (blueprint) {
            if (inverse) {
                blueprint.rotateCcw();
            } else {
                blueprint.rotateCw();
            }
            return;
        }

        const placer = this.placer;
        placer.tryRotate(inverse);

        // Just tapped a building down and it faces the wrong way? Turn that one too.
        const entity = this.lastTapPlaced;
        const building = placer.currentMetaBuilding.get();
        if (!entity || entity.destroyed || entity.queuedForDestroy || !building) {
            return;
        }
        const staticComp = entity.components.StaticMapEntity;
        const data = getBuildingDataFromCode(staticComp.code);
        if (
            data.metaInstance !== building ||
            data.variant !== placer.currentVariant.get() ||
            building.getFlipOrientationAfterPlacement()
        ) {
            return;
        }

        const origin = staticComp.origin.copy();
        const oldRotation = staticComp.originalRotation;
        if (!this.root.logic.tryDeleteBuilding(entity)) {
            return;
        }
        this.lastPlaced = null;
        if (!placer.tryPlaceCurrentBuildingAt(origin)) {
            // The turned footprint doesn't fit, put it back as it was
            const wanted = placer.currentBaseRotation;
            placer.currentBaseRotation = oldRotation;
            placer.tryPlaceCurrentBuildingAt(origin);
            placer.currentBaseRotation = wanted;
            haptic("error");
        } else {
            this.root.soundProxy.playUi(building.getPlacementSound());
        }
        this.lastTapPlaced = this.lastPlaced;
    }

    /** Escape / right click equivalent */
    back() {
        const mass = this.parts.massSelector;
        if (this.parts.blueprintPlacer.abortPlacement() === STOP_PROPAGATION) {
            // Dropped the blueprint
        } else if (mass.selectedUids.size > 0) {
            mass.clearSelection();
        } else if (this.placer.currentMetaBuilding.get()) {
            this.placer.currentMetaBuilding.set(null);
        } else if (this.tool !== TOOL.build) {
            this.tool = TOOL.build;
        } else if (this.pillEntity) {
            this.hidePill();
        } else {
            return;
        }
        haptic("selection");
    }

    // ---------------------------------------------------------------------------------------------
    // Per frame

    update() {
        const root = this.root;
        const blueprint = this.blueprint;

        // A blueprint appeared (copy, cut or paste): put its ghost in the middle of the screen
        if (blueprint && !this.blueprintCursor) {
            this.blueprintCursor = root.camera.center.copy();
        } else if (!blueprint && this.blueprintCursor) {
            this.blueprintCursor = null;
            this.setPointer(null);
        }
        if (this.blueprintCursor) {
            this.setPointer(root.camera.worldToScreen(this.blueprintCursor));
        }

        if (this.pillEntity) {
            if (root.camera.getIsMapOverlayActive() || this.tool !== TOOL.build) {
                this.hidePill();
            } else {
                this.updatePillPosition();
            }
        }

        if (!this.gesture && this.placer.forceDirectionLock !== this.lineMode) {
            this.placer.forceDirectionLock = this.lineMode;
        }

        this.updateUi();
    }

    updateUi() {
        const root = this.root;
        const building = this.placer.currentMetaBuilding.get();
        const mass = this.parts.massSelector;
        const blueprintPlacer = this.parts.blueprintPlacer;

        let mode = "idle";
        if (this.blueprint) {
            mode = "blueprint";
        } else if (mass.selectedUids.size > 0) {
            mode = "selection";
        } else if (building) {
            mode = "placing";
        }

        const state = {
            mode,
            overview: root.camera.getIsMapOverlayActive(),
            layer: root.currentLayer,
            wiresUnlocked:
                root.gameMode.getSupportsWires() &&
                root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_wires_painter_and_levers),
            lockAvailable:
                building && building.getHasDirectionLockAvailable(this.placer.currentVariant.get()),
            canPaste:
                !!blueprintPlacer.lastBlueprintUsed &&
                blueprintPlacer.lastBlueprintUsed.layer === root.currentLayer,
            hidden: root.hud.hasBlockingOverlayOpen(),
        };

        const key = JSON.stringify([state, this.tool, this.lineMode, this.plannerGesture]);
        if (key !== this.uiKey) {
            this.uiKey = key;
            this.element.classList.toggle("hidden", state.hidden);
            for (const button of this.buttons) {
                button.element.classList.toggle("hidden", !button.visible(state));
                button.element.classList.toggle("active", !!button.active?.(state));
            }
            for (const column of [this.toolsColumn, this.actionsColumn]) {
                column.classList.toggle("empty", !column.querySelector(".tcBtn:not(.hidden)"));
            }
            document.documentElement.dataset.touchTool = this.tool;

            const hintId = this.tool !== TOOL.build && mode === "idle" ? this.tool : mode;
            if (hintId !== this.lastHintId) {
                this.lastHintId = hintId;
                this.showHint(this.lineMode && hintId === "placing" ? "line" : hintId);
            }
        }

        if (building) {
            this.directionBadge.style.transform = `rotate(${this.placer.currentBaseRotation}deg)`;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Hints: a short line on what the fingers do, the first few times each mode comes up

    loadHintCounts() {
        try {
            return JSON.parse(localStorage.getItem("touchHints") || "{}");
        } catch {
            return {};
        }
    }

    /**
     * @param {string} id
     * @param {boolean=} force
     */
    showHint(id, force = false) {
        const texts = {
            idle: "Drag to look around · Pinch to zoom · Tap a building for options",
            placing:
                "Tap to place · Drag to draw · Hold, then drag: straight line · Two fingers: move & zoom",
            line: "Drag for a straight line · Corner flips the bend",
            blueprint: "Drag to move · Tap the copy to place it",
            selection: "Copy, cut or delete · Hold and drag to add more",
            select: "Drag a box or tap buildings",
            erase: "Tap or drag to remove · Hold, then drag: clear an area",
        };
        clearTimeout(this.hintTimer);
        const text = texts[id];
        const count = this.hintCounts[id] || 0;
        if (!text || (!force && count >= HINT_SHOW_LIMIT)) {
            this.hintElement.classList.remove("visible");
            return;
        }
        this.hintCounts[id] = count + 1;
        try {
            localStorage.setItem("touchHints", JSON.stringify(this.hintCounts));
        } catch {
            // Hints just show again next time
        }
        this.hintElement.textContent = text;
        this.hintElement.classList.add("visible");
        this.hintTimer = setTimeout(() => this.hintElement.classList.remove("visible"), 4500);
    }
}
