import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  type Layer,
  type StoryCanvas,
} from "../../../lib/story-canvas.ts";

export const LAYER_MIN_SIZE = 50;
export const LAYER_MAX_WIDTH = CANVAS_WIDTH * 2;
export const LAYER_MAX_HEIGHT = CANVAS_HEIGHT * 2;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function computeMovedLayerPosition(
  layer: Pick<Layer, "x" | "y" | "width" | "height">,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const nextCenterX = clamp(layer.x + layer.width / 2 + dx, 0, CANVAS_WIDTH);
  const nextCenterY = clamp(layer.y + layer.height / 2 + dy, 0, CANVAS_HEIGHT);
  return {
    x: nextCenterX - layer.width / 2,
    y: nextCenterY - layer.height / 2,
  };
}

export function computeResizedLayerBounds(
  layer: Pick<Layer, "x" | "y" | "width" | "height">,
  scaleFactor: number,
): { x: number; y: number; width: number; height: number } {
  const safeFactor =
    Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const maxScale = Math.min(
    LAYER_MAX_WIDTH / Math.max(1, layer.width),
    LAYER_MAX_HEIGHT / Math.max(1, layer.height),
  );
  const minScale = Math.max(
    LAYER_MIN_SIZE / Math.max(1, layer.width),
    LAYER_MIN_SIZE / Math.max(1, layer.height),
  );
  const applied = clamp(
    safeFactor,
    Math.min(minScale, maxScale),
    Math.max(minScale, maxScale),
  );
  const nextWidth = Math.max(LAYER_MIN_SIZE, layer.width * applied);
  const nextHeight = Math.max(LAYER_MIN_SIZE, layer.height * applied);
  const centerX = layer.x + layer.width / 2;
  const centerY = layer.y + layer.height / 2;
  return {
    x: centerX - nextWidth / 2,
    y: centerY - nextHeight / 2,
    width: nextWidth,
    height: nextHeight,
  };
}

export function computeRotatedLayerAngle(
  rotation: number,
  deltaDeg: number,
): number {
  const next = (rotation + deltaDeg) % 360;
  return next < 0 ? next + 360 : next;
}

interface UseStoryLayerActionsOptions {
  storyCanvas: StoryCanvas | null;
  selectedLayerId: string | null;
  selectLayer: (id: string | null) => void;
  onUpdate: () => void;
}

export function useStoryLayerActions(opts: UseStoryLayerActionsOptions) {
  const resolveLayer = (layerId?: string): Layer | null => {
    const id = layerId ?? opts.selectedLayerId;
    if (!opts.storyCanvas || !id) return null;
    const layer = opts.storyCanvas.getLayer(id);
    if (!layer || layer.type === "background") return null;
    return layer;
  };

  const handleUpdateLayer = (updates: Partial<Layer>) => {
    if (!opts.storyCanvas || !opts.selectedLayerId) return;

    opts.storyCanvas.updateLayer(opts.selectedLayerId, updates);
    opts.onUpdate();
  };

  const handleMoveLayer = (dx: number, dy: number, layerId?: string) => {
    const layer = resolveLayer(layerId);
    if (!opts.storyCanvas || !layer) return;

    opts.storyCanvas.updateLayer(
      layer.id,
      computeMovedLayerPosition(layer, dx, dy),
    );
    opts.onUpdate();
  };

  const handleResizeLayer = (scaleFactor: number, layerId?: string) => {
    const layer = resolveLayer(layerId);
    if (!opts.storyCanvas || !layer) return;

    opts.storyCanvas.updateLayer(
      layer.id,
      computeResizedLayerBounds(layer, scaleFactor),
    );
    opts.onUpdate();
  };

  const handleRotateLayer = (deltaDeg: number, layerId?: string) => {
    const layer = resolveLayer(layerId);
    if (!opts.storyCanvas || !layer) return;

    opts.storyCanvas.updateLayer(layer.id, {
      rotation: computeRotatedLayerAngle(layer.rotation, deltaDeg),
    });
    opts.onUpdate();
  };

  const handleDeleteLayer = (layerId?: string) => {
    const id = layerId ?? opts.selectedLayerId;
    if (!opts.storyCanvas || !id) return;

    opts.storyCanvas.removeLayer(id);
    if (opts.selectedLayerId === id) {
      opts.selectLayer(null);
    }
    opts.onUpdate();
  };

  const handleBringToFront = () => {
    if (!opts.storyCanvas || !opts.selectedLayerId) return;

    opts.storyCanvas.bringToFront(opts.selectedLayerId);
    opts.onUpdate();
  };

  const handleSendToBack = () => {
    if (!opts.storyCanvas || !opts.selectedLayerId) return;

    opts.storyCanvas.sendToBack(opts.selectedLayerId);
    opts.onUpdate();
  };

  return {
    handleUpdateLayer,
    handleMoveLayer,
    handleResizeLayer,
    handleRotateLayer,
    handleDeleteLayer,
    handleBringToFront,
    handleSendToBack,
  };
}
