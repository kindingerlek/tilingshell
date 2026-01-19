import { registerGObjectClass } from '../../utils/gjs';
import SignalHandling from '../../utils/signalHandling';
import { GObject, Meta, Mtk, Clutter, Graphene } from '../../gi/ext';
import { KeyBindingsDirection } from '../../keybindings';
import { getWindows, buildRectangle, buildMargin, buildTileGaps } from '../../utils/ui';
import Tile from '../layout/Tile';
import TileUtils from '../layout/TileUtils';
import ExtendedWindow from '../tilingsystem/extendedWindow';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Settings from '../../settings/settings';
import GlobalState from '../../utils/globalState';

class CachedWindowProperties {
    private _is_initialized: boolean = false;
    public maximized: boolean = false;

    constructor(window: Meta.Window, manager: TilingShellWindowManager) {
        this.update(window, manager);
        this._is_initialized = true;
    }

    public update(window: Meta.Window, manager: TilingShellWindowManager) {
        const newMaximized =
            window.maximizedVertically && window.maximizedHorizontally;
        if (this._is_initialized) {
            if (this.maximized && !newMaximized)
                manager.emit('unmaximized', window);
            else if (!this.maximized && newMaximized)
                manager.emit('maximized', window);
        }

        this.maximized = newMaximized;
    }
}

interface WindowWithCachedProps extends Meta.Window {
    __ts_cached: CachedWindowProperties | undefined;
}

export default class TilingShellWindowManager extends GObject.Object {
    static { registerGObjectClass(this, {
        GTypeName: 'TilingShellWindowManager',
        Signals: {
            unmaximized: {
                param_types: [Meta.Window.$gtype],
            },
            maximized: {
                param_types: [Meta.Window.$gtype],
            },
        },
    })};

    private static _instance: TilingShellWindowManager | null;

    private readonly _signals: SignalHandling;

    static get(): TilingShellWindowManager {
        if (!this._instance) this._instance = new TilingShellWindowManager();

        return this._instance;
    }

    static destroy() {
        if (this._instance) {
            this._instance._signals.disconnect();
            this._instance = null;
        }
    }

    constructor() {
        super();

        this._signals = new SignalHandling();
        global.get_window_actors().forEach((winActor) => {
            (winActor.metaWindow as WindowWithCachedProps).__ts_cached =
                new CachedWindowProperties(winActor.metaWindow, this);
        });

        this._signals.connect(
            global.display,
            'window-created',
            (_, window: Meta.Window) => {
                (window as WindowWithCachedProps).__ts_cached =
                    new CachedWindowProperties(window, this);
            },
        );
        this._signals.connect(
            global.windowManager,
            'minimize',
            (_, actor: Meta.WindowActor) => {
                (actor.metaWindow as WindowWithCachedProps).__ts_cached?.update(
                    actor.metaWindow,
                    this,
                );
            },
        );
        this._signals.connect(
            global.windowManager,
            'unminimize',
            (_, actor: Meta.WindowActor) => {
                (actor.metaWindow as WindowWithCachedProps).__ts_cached?.update(
                    actor.metaWindow,
                    this,
                );
            },
        );
        this._signals.connect(
            global.windowManager,
            'size-changed',
            (_, actor: Meta.WindowActor) => {
                // TODO disable default window animations Main.wm.skipNextEffect(actor);
                (actor.metaWindow as WindowWithCachedProps).__ts_cached?.update(
                    actor.metaWindow,
                    this,
                );
            },
        );
    }

    public swap(window: ExtendedWindow, direction: KeyBindingsDirection): void {
        const windowTile = window.assignedTile;
        const monitorIndex = window.get_monitor();
        const currentWs = window.get_workspace();
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        // Get all tiled windows on the same monitor and workspace
        const tiledWindows = getWindows(currentWs)
            .filter((w): w is ExtendedWindow => {
                const extWin = w as ExtendedWindow;
                return (
                    extWin !== window &&
                    extWin.assignedTile !== undefined &&
                    !extWin.minimized &&
                    extWin.get_monitor() === monitorIndex
                );
            });

        // Handle untiled windows - find the nearest tile in the direction and move there
        if (!windowTile) {
            const destinationTile = this._findNearestTileInDirection(
                window.get_frame_rect(),
                direction,
                monitorIndex,
                currentWs.index(),
            );
            if (destinationTile) {
                const targetRect = this._getTileRect(destinationTile, workArea);
                window.assignedTile = new Tile({ ...destinationTile });
                window.originalSize = window.get_frame_rect().copy();
                this._easeWindowRect(window, targetRect, monitorIndex);
            }
            return;
        }

        // Find the best window to swap with in the given direction
        const targetWindow = this._findSwapTarget(
            windowTile,
            tiledWindows,
            direction,
        );

        // Find an empty tile in the direction
        const emptyTile = this._findEmptyTileInDirection(
            windowTile,
            tiledWindows,
            direction,
            monitorIndex,
            currentWs.index(),
        );

        // Determine which is closer: the swap target or the empty tile
        const currentCenter = this._getTileCenter(windowTile);
        
        let swapDistance = Infinity;
        if (targetWindow?.assignedTile) {
            const targetCenter = this._getTileCenter(targetWindow.assignedTile);
            swapDistance = this._getDirectionalDistance(currentCenter, targetCenter, direction);
        }

        let emptyDistance = Infinity;
        if (emptyTile) {
            const emptyCenter = this._getTileCenter(emptyTile);
            emptyDistance = this._getDirectionalDistance(currentCenter, emptyCenter, direction);
        }

        // Prefer the closer target (empty tile or swap window)
        if (emptyTile && emptyDistance <= swapDistance) {
            // Move to empty tile
            const targetRect = this._getTileRect(emptyTile, workArea);
            window.assignedTile = new Tile({ ...emptyTile });
            this._easeWindowRect(window, targetRect, monitorIndex);
        } else if (targetWindow?.assignedTile) {
            // Swap with the window - resize both to fit their destination tiles
            const targetTile = targetWindow.assignedTile;
            
            // Get the proper rects for both tiles
            const windowDestRect = this._getTileRect(targetTile, workArea);
            const targetDestRect = this._getTileRect(windowTile, workArea);

            // Swap assigned tiles
            window.assignedTile = new Tile({ ...targetTile });
            targetWindow.assignedTile = new Tile({ ...windowTile });

            // Animate windows to their destination tiles (properly sized and positioned)
            this._easeWindowRect(window, windowDestRect, monitorIndex);
            this._easeWindowRect(targetWindow, targetDestRect, monitorIndex);
        }
    }

    /**
     * Get the distance in the direction axis between two points
     */
    private _getDirectionalDistance(
        from: { x: number; y: number },
        to: { x: number; y: number },
        direction: KeyBindingsDirection,
    ): number {
        switch (direction) {
            case KeyBindingsDirection.LEFT:
                return from.x - to.x;
            case KeyBindingsDirection.RIGHT:
                return to.x - from.x;
            case KeyBindingsDirection.UP:
                return from.y - to.y;
            case KeyBindingsDirection.DOWN:
                return to.y - from.y;
            default:
                return Infinity;
        }
    }

    /**
     * Find the nearest tile in the given direction from a window's frame rect.
     * This is used for untiled windows to find a tile to move to.
     * Similar to how tilingLayout.findNearestTileDirection works for the move behavior.
     */
    private _findNearestTileInDirection(
        windowRect: Mtk.Rectangle,
        direction: KeyBindingsDirection,
        monitorIndex: number,
        workspaceIndex: number,
    ): Tile | undefined {
        const layout = GlobalState.get().getSelectedLayoutOfMonitor(
            monitorIndex,
            workspaceIndex,
        );
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        // Calculate search point offset in the direction (similar to tilingLayout.findNearestTileDirection)
        const enlargeFactor = 64;
        const searchPoint = {
            x: windowRect.x + windowRect.width / 2,
            y: windowRect.y + windowRect.height / 2,
        };

        switch (direction) {
            case KeyBindingsDirection.RIGHT:
                searchPoint.x = windowRect.x + windowRect.width + enlargeFactor;
                break;
            case KeyBindingsDirection.LEFT:
                searchPoint.x = windowRect.x - enlargeFactor;
                break;
            case KeyBindingsDirection.DOWN:
                searchPoint.y = windowRect.y + windowRect.height + enlargeFactor;
                break;
            case KeyBindingsDirection.UP:
                searchPoint.y = windowRect.y - enlargeFactor;
                break;
        }

        // Clamp search point to work area
        searchPoint.x = Math.max(workArea.x, Math.min(searchPoint.x, workArea.x + workArea.width));
        searchPoint.y = Math.max(workArea.y, Math.min(searchPoint.y, workArea.y + workArea.height));

        // Convert search point to normalized coordinates (0-1 range)
        const normalizedPoint = {
            x: (searchPoint.x - workArea.x) / workArea.width,
            y: (searchPoint.y - workArea.y) / workArea.height,
        };

        // Find the tile that contains this point
        for (const tile of layout.tiles) {
            if (
                normalizedPoint.x >= tile.x &&
                normalizedPoint.x <= tile.x + tile.width &&
                normalizedPoint.y >= tile.y &&
                normalizedPoint.y <= tile.y + tile.height
            ) {
                return tile;
            }
        }

        return undefined;
    }

    /**
     * Find an empty tile in the given direction.
     * An empty tile is one from the current layout that has no window assigned to it.
     */
    private _findEmptyTileInDirection(
        currentTile: Tile,
        tiledWindows: ExtendedWindow[],
        direction: KeyBindingsDirection,
        monitorIndex: number,
        workspaceIndex: number,
    ): Tile | undefined {
        const layout = GlobalState.get().getSelectedLayoutOfMonitor(
            monitorIndex,
            workspaceIndex,
        );

        const epsilon = 0.001;

        // Find tiles that are empty (no window occupying them)
        const emptyTiles = layout.tiles.filter((tile) => {
            // Check if any tiled window occupies this tile
            const isOccupied = tiledWindows.some((win) => {
                const winTile = win.assignedTile;
                if (!winTile) return false;
                return this._tilesOverlap(tile, winTile);
            });

            // Also check if the current window's tile overlaps with this tile
            if (this._tilesOverlap(tile, currentTile)) return false;

            return !isOccupied;
        });

        // Filter empty tiles that are in the given direction and have overlapping range
        const validTiles = emptyTiles.filter((tile) => {
            switch (direction) {
                case KeyBindingsDirection.LEFT:
                    return (
                        tile.x + tile.width <= currentTile.x + epsilon &&
                        this._hasVerticalOverlap(currentTile, tile)
                    );
                case KeyBindingsDirection.RIGHT:
                    return (
                        tile.x >= currentTile.x + currentTile.width - epsilon &&
                        this._hasVerticalOverlap(currentTile, tile)
                    );
                case KeyBindingsDirection.UP:
                    return (
                        tile.y + tile.height <= currentTile.y + epsilon &&
                        this._hasHorizontalOverlap(currentTile, tile)
                    );
                case KeyBindingsDirection.DOWN:
                    return (
                        tile.y >= currentTile.y + currentTile.height - epsilon &&
                        this._hasHorizontalOverlap(currentTile, tile)
                    );
                default:
                    return false;
            }
        });

        if (validTiles.length === 0) return undefined;

        // Sort by distance (closest first)
        validTiles.sort((a, b) => {
            const centerA = this._getTileCenter(a);
            const centerB = this._getTileCenter(b);
            const currentCenter = this._getTileCenter(currentTile);

            let distA: number, distB: number;

            switch (direction) {
                case KeyBindingsDirection.LEFT:
                    distA = currentCenter.x - centerA.x;
                    distB = currentCenter.x - centerB.x;
                    break;
                case KeyBindingsDirection.RIGHT:
                    distA = centerA.x - currentCenter.x;
                    distB = centerB.x - currentCenter.x;
                    break;
                case KeyBindingsDirection.UP:
                    distA = currentCenter.y - centerA.y;
                    distB = currentCenter.y - centerB.y;
                    break;
                case KeyBindingsDirection.DOWN:
                    distA = centerA.y - currentCenter.y;
                    distB = centerB.y - currentCenter.y;
                    break;
                default:
                    return 0;
            }

            return distA - distB;
        });

        return validTiles[0];
    }

    /**
     * Check if two tiles overlap (share interior area, not just edges)
     */
    private _tilesOverlap(a: Tile, b: Tile): boolean {
        const epsilon = 0.001;
        // Use epsilon to require actual interior overlap, not just edge touching
        return (
            a.x < b.x + b.width - epsilon &&      // a.left < b.right (with margin)
            a.x + a.width > b.x + epsilon &&      // a.right > b.left (with margin)
            a.y < b.y + b.height - epsilon &&     // a.top < b.bottom (with margin)
            a.y + a.height > b.y + epsilon        // a.bottom > b.top (with margin)
        );
    }

    /**
     * Find the best window to swap with based on direction.
     * 
     * The algorithm:
     * 1. Filter windows that are in the given direction from the current tile
     * 2. For LEFT/RIGHT: find windows that have overlapping vertical range
     * 3. For UP/DOWN: find windows that have overlapping horizontal range
     * 4. Among candidates, pick the closest one (by center distance in the direction axis)
     * 5. For UP/DOWN with multiple candidates at same distance, prefer rightmost (for consistency)
     */
    private _findSwapTarget(
        currentTile: Tile,
        candidates: ExtendedWindow[],
        direction: KeyBindingsDirection,
    ): ExtendedWindow | undefined {
        const epsilon = 0.001;

        // Filter candidates that are in the given direction and have overlapping range
        const validCandidates = candidates.filter((win) => {
            const tile = win.assignedTile;
            if (!tile) return false;

            switch (direction) {
                case KeyBindingsDirection.LEFT:
                    // Target must be to the left and have vertical overlap
                    return (
                        tile.x + tile.width <= currentTile.x + epsilon &&
                        this._hasVerticalOverlap(currentTile, tile)
                    );
                case KeyBindingsDirection.RIGHT:
                    // Target must be to the right and have vertical overlap
                    return (
                        tile.x >= currentTile.x + currentTile.width - epsilon &&
                        this._hasVerticalOverlap(currentTile, tile)
                    );
                case KeyBindingsDirection.UP:
                    // Target must be above and have horizontal overlap
                    return (
                        tile.y + tile.height <= currentTile.y + epsilon &&
                        this._hasHorizontalOverlap(currentTile, tile)
                    );
                case KeyBindingsDirection.DOWN:
                    // Target must be below and have horizontal overlap
                    return (
                        tile.y >= currentTile.y + currentTile.height - epsilon &&
                        this._hasHorizontalOverlap(currentTile, tile)
                    );
                default:
                    return false;
            }
        });

        if (validCandidates.length === 0) return undefined;

        // Sort candidates by distance in the direction axis
        // For UP/DOWN, also use rightmost as tiebreaker (as per test cases)
        validCandidates.sort((a, b) => {
            const tileA = a.assignedTile!;
            const tileB = b.assignedTile!;

            const centerA = this._getTileCenter(tileA);
            const centerB = this._getTileCenter(tileB);
            const currentCenter = this._getTileCenter(currentTile);

            let distA: number, distB: number;

            switch (direction) {
                case KeyBindingsDirection.LEFT:
                    distA = currentCenter.x - centerA.x;
                    distB = currentCenter.x - centerB.x;
                    break;
                case KeyBindingsDirection.RIGHT:
                    distA = centerA.x - currentCenter.x;
                    distB = centerB.x - currentCenter.x;
                    break;
                case KeyBindingsDirection.UP:
                    distA = currentCenter.y - centerA.y;
                    distB = currentCenter.y - centerB.y;
                    break;
                case KeyBindingsDirection.DOWN:
                    distA = centerA.y - currentCenter.y;
                    distB = centerB.y - currentCenter.y;
                    break;
                default:
                    return 0;
            }

            // Sort by distance first
            if (Math.abs(distA - distB) > epsilon) {
                return distA - distB;
            }

            // Tiebreaker for UP/DOWN: prefer rightmost tile
            if (
                direction === KeyBindingsDirection.UP ||
                direction === KeyBindingsDirection.DOWN
            ) {
                return (tileB.x + tileB.width) - (tileA.x + tileA.width);
            }

            return 0;
        });

        return validCandidates[0];
    }

    /**
     * Check if two tiles have vertical overlap (for LEFT/RIGHT swapping)
     */
    private _hasVerticalOverlap(a: Tile, b: Tile): boolean {
        const epsilon = 0.001;
        const aTop = a.y;
        const aBottom = a.y + a.height;
        const bTop = b.y;
        const bBottom = b.y + b.height;

        // They overlap if one doesn't end before the other starts
        return !(aBottom <= bTop + epsilon || bBottom <= aTop + epsilon);
    }

    /**
     * Check if two tiles have horizontal overlap (for UP/DOWN swapping)
     */
    private _hasHorizontalOverlap(a: Tile, b: Tile): boolean {
        const epsilon = 0.001;
        const aLeft = a.x;
        const aRight = a.x + a.width;
        const bLeft = b.x;
        const bRight = b.x + b.width;

        // They overlap if one doesn't end before the other starts
        return !(aRight <= bLeft + epsilon || bRight <= aLeft + epsilon);
    }

    private _tilesEqual(a: Tile, b: Tile): boolean {
        const epsilon = 0.001;
        return Math.abs(a.x - b.x) < epsilon &&
               Math.abs(a.y - b.y) < epsilon &&
               Math.abs(a.width - b.width) < epsilon &&
               Math.abs(a.height - b.height) < epsilon;
    }

    private _getTileCenter(tile: Tile) {
        return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
    }

    private _isTileInDirection(current: Tile, target: Tile, direction: KeyBindingsDirection): boolean {
        const c = this._getTileCenter(current);
        const t = this._getTileCenter(target);
        
        const epsilon = 0.01;
        switch (direction) {
            case KeyBindingsDirection.UP: return t.y < c.y - epsilon;
            case KeyBindingsDirection.DOWN: return t.y > c.y + epsilon;
            case KeyBindingsDirection.LEFT: return t.x < c.x - epsilon;
            case KeyBindingsDirection.RIGHT: return t.x > c.x + epsilon;
            default: return false;
        }
    }

    private _getTileRect(tile: Tile, workArea: Mtk.Rectangle): Mtk.Rectangle {
        const innerGaps = buildMargin(Settings.get_inner_gaps());
        const outerGaps = buildMargin(Settings.get_outer_gaps());

        // Apply tile proportions to the work area
        const scaledRect = TileUtils.apply_props(tile, workArea);

        // Ensure the rect doesn't go beyond the workarea
        if (scaledRect.x + scaledRect.width > workArea.x + workArea.width) {
            scaledRect.width = workArea.x + workArea.width - scaledRect.x;
        }
        if (scaledRect.y + scaledRect.height > workArea.y + workArea.height) {
            scaledRect.height = workArea.y + workArea.height - scaledRect.y;
        }

        // Calculate gaps - buildTileGaps uses the container to determine edge positions
        const { gaps } = buildTileGaps(scaledRect, innerGaps, outerGaps, workArea);

        return buildRectangle({
            x: scaledRect.x + gaps.left,
            y: scaledRect.y + gaps.top,
            width: scaledRect.width - gaps.left - gaps.right,
            height: scaledRect.height - gaps.top - gaps.bottom,
        });
    }

    private _easeWindowRect(window: Meta.Window, destRect: Mtk.Rectangle, monitorIndex: number) {
        const windowActor = window.get_compositor_private() as Clutter.Actor;
        if (!windowActor) return;

        const beforeRect = window.get_frame_rect();
        // do not animate the window if it will not move or scale
        if (
            destRect.x === beforeRect.x &&
            destRect.y === beforeRect.y &&
            destRect.width === beforeRect.width &&
            destRect.height === beforeRect.height
        )
            return;

        // apply animations when tiling the window
        windowActor.remove_all_transitions();
        // @ts-expect-error "Main.wm has the private function _prepareAnimationInfo"
        Main.wm._prepareAnimationInfo(
            global.windowManager,
            windowActor,
            beforeRect.copy(),
            Meta.SizeChange.UNMAXIMIZE,
        );

        // move and resize the window
        window.move_to_monitor(monitorIndex);
        window.move_resize_frame(
            false,
            destRect.x,
            destRect.y,
            destRect.width,
            destRect.height,
        );
    }

    public static easeMoveWindow(params: {
        window: Meta.Window;
        from: Mtk.Rectangle;
        to: Mtk.Rectangle;
        duration: number;
        monitorIndex?: number;
    }): void {
        const winActor =
            params.window.get_compositor_private() as Meta.WindowActor;
        if (!winActor) return;

        // create a clone and hide the window actor
        // then we can change the actual window size
        // without showing that to the user
        const winRect = params.window.get_frame_rect();
        const xExcludingShadow = winRect.x - winActor.get_x();
        const yExcludingShadow = winRect.y - winActor.get_y();
        const staticClone = new Clutter.Clone({
            source: winActor,
            reactive: false,
            scale_x: 1,
            scale_y: 1,
            x: params.from.x,
            y: params.from.y,
            width: params.from.width,
            height: params.from.height,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
        });
        global.windowGroup.add_child(staticClone);
        winActor.opacity = 0;
        staticClone.ease({
            x: params.to.x - xExcludingShadow,
            y: params.to.y - yExcludingShadow,
            width: params.to.width + 2 * yExcludingShadow,
            height: params.to.height + 2 * xExcludingShadow,
            duration: params.duration,
            onStopped: () => {
                winActor.opacity = 255;
                winActor.set_scale(1, 1);
                staticClone.destroy();
            },
        });
        // finally move the window
        // the actor has opacity = 0, so this is not seen by the user
        winActor.set_pivot_point(0, 0);
        winActor.set_position(params.to.x, params.to.y);
        winActor.set_size(params.to.width, params.to.height);
        const user_op = false;
        if (params.monitorIndex)
            params.window.move_to_monitor(params.monitorIndex);
        params.window.move_frame(user_op, params.to.x, params.to.y);
        params.window.move_resize_frame(
            user_op,
            params.to.x,
            params.to.y,
            params.to.width,
            params.to.height,
        );
        // while we hide the preview, show the actor to the new position,
        // this has opacity of 0 so it is hidden. Later we immediately swap
        // the animating actor with this
        winActor.show();
    }
}
