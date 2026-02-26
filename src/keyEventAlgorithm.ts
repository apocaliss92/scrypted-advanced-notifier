/**
 * Key-event selection for RawDetection events.
 * Chooses at most one detection per event to mark as keyEvent and save a cropped image:
 * - Prefer face/plate, then person/vehicle/animal; avoid duplicating object-detection results.
 * - Only well-visible objects (sufficient bbox size, not clipped at frame edges).
 * - Never save the same object id twice (dedupe by detection id).
 */

import type { ObjectDetectionResult } from '@scrypted/sdk';
import { sortBy } from 'lodash';
import { classnamePrio, detectionClassesDefaultMap } from './detectionClasses';
import { isFaceClassname, isPlateClassname } from './detectionClasses';

export type BoundingBox = [number, number, number, number];

const MIN_AREA_RATIO = 0.0008; // min ~0.08% of frame area (more permissive to include a decent %)
const EDGE_MARGIN_RATIO = 0.01; // object must be at least 1% from each edge (not clipped)

function getKeyEventPriority(className: string): number {
  if (isFaceClassname(className)) return 1;
  if (isPlateClassname(className)) return 1;
  const dc = detectionClassesDefaultMap[className];
  const prio = dc != null ? classnamePrio[dc] : undefined;
  return typeof prio === 'number' ? prio : 10;
}

/**
 * Check if the bounding box is well visible: sufficient size and not clipped by frame edges.
 * bbox is [x, y, width, height] in pixel coordinates; dims is [width, height].
 */
export function isBoundingBoxWellVisible(
  bbox: BoundingBox,
  dims: [number, number],
): boolean {
  const [x, y, w, h] = bbox;
  const [imgW, imgH] = dims;
  if (!imgW || !imgH || w <= 0 || h <= 0) return false;

  const area = w * h;
  const frameArea = imgW * imgH;
  if (area < frameArea * MIN_AREA_RATIO) return false;

  const marginX = imgW * EDGE_MARGIN_RATIO;
  const marginY = imgH * EDGE_MARGIN_RATIO;
  const left = x;
  const top = y;
  const right = x + w;
  const bottom = y + h;

  if (left < marginX || top < marginY || right > imgW - marginX || bottom > imgH - marginY) {
    return false;
  }
  return true;
}

/**
 * Normalize bounding box from normalized [0-1] to pixels if needed.
 * If bbox values are <= 1 we treat as normalized; otherwise pixels.
 */
export function toPixelBbox(
  bbox: BoundingBox,
  dims: [number, number],
): BoundingBox {
  const [x, y, w, h] = bbox;
  const [imgW, imgH] = dims;
  if (x <= 1 && y <= 1 && w <= 1 && h <= 1) {
    return [x * imgW, y * imgH, w * imgW, h * imgH];
  }
  return bbox;
}

export interface SelectKeyEventDetectionProps {
  detections: ObjectDetectionResult[];
  inputDimensions: [number, number] | undefined;
  /** Set of object ids already saved as key events (never save same id twice). */
  objectIdsAlreadyKeyEvent: Set<string>;
  logger?: Console;
}

/**
 * Select at most one detection to use as key event for this raw event.
 * Returns the best candidate or null if none (duplicate id, not visible, or no bbox).
 */
export function selectKeyEventDetection(
  props: SelectKeyEventDetectionProps,
): { detection: ObjectDetectionResult; objectId: string } | null {
  const { detections, inputDimensions, objectIdsAlreadyKeyEvent, logger } = props;
  if (!detections?.length || !inputDimensions?.length) return null;

  const dims = inputDimensions as [number, number];
  const withBbox = detections.filter(
    (d) => d.boundingBox && Array.isArray(d.boundingBox) && d.boundingBox.length >= 4,
  ) as (ObjectDetectionResult & { boundingBox: BoundingBox })[];

  if (!withBbox.length) return null;

  const visible = withBbox.filter((d) => {
    const pixelBox = toPixelBbox(d.boundingBox, dims);
    return isBoundingBoxWellVisible(pixelBox, dims);
  });
  if (!visible.length) return null;

  const notDuplicate = visible.filter((d) => {
    const id = d.id ?? (d.label ? `${d.className}_${d.label}` : null);
    if (!id) return true;
    if (objectIdsAlreadyKeyEvent.has(id)) return false;
    return true;
  });
  if (!notDuplicate.length) return null;

  const sorted = sortBy(notDuplicate, (d) => [
    getKeyEventPriority(d.className),
    -(d.score ?? 0),
  ]);
  const best = sorted[0];
  const objectId = best.id ?? (best.label ? `${best.className}_${best.label}` : null) ?? best.className ?? '';
  if (objectId && objectIdsAlreadyKeyEvent.has(objectId)) return null;

  return { detection: best, objectId: String(objectId || best.className || '') };
}
