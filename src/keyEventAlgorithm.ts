/**
 * Key-event selection for RawDetection events.
 * Returns all detections that match key-event criteria, sorted by priority:
 * - Prefer face/plate, then person/vehicle/animal; avoid duplicating object-detection results.
 * - Only well-visible objects (sufficient bbox size, not clipped at frame edges).
 * - Never save the same object id twice (dedupe by detection id).
 * - Only moving objects get cropped; stationary objects are tracked separately.
 */

import type { ObjectDetectionResult } from '@scrypted/sdk';
import { sortBy } from 'lodash';
import { classnamePrio, detectionClassesDefaultMap, isMotionClassname } from './detectionClasses';
import { isFaceClassname, isPlateClassname } from './detectionClasses';

export type BoundingBox = [number, number, number, number];

// Inspired by NVR: less restrictive to retain more detections
const MIN_AREA_RATIO = 0.0003; // min ~0.03% of frame area (allow smaller objects e.g. face at distance)
const EDGE_MARGIN_RATIO = 0.005; // object must be at least 0.5% from each edge (when area is small)
const DECENT_AREA_RATIO = 0.002; // ~0.2% of frame: boxes with decent area can touch the edge (10% border zone)
const MIN_AREA_RATIO_FALLBACK = 0.00015; // very small fallback: include tiny objects when none pass strict visibility

function getKeyEventPriority(className: string): number {
  if (isFaceClassname(className)) return 1;
  if (isPlateClassname(className)) return 1;
  const dc = detectionClassesDefaultMap[className];
  const prio = dc != null ? classnamePrio[dc] : undefined;
  return typeof prio === 'number' ? prio : 10;
}

function hasMinArea(bbox: BoundingBox, dims: [number, number], ratio: number): boolean {
  const [, , w, h] = bbox;
  const [imgW, imgH] = dims;
  if (!imgW || !imgH || w <= 0 || h <= 0) return false;
  const area = w * h;
  const frameArea = imgW * imgH;
  return area >= frameArea * ratio;
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

  // Boxes with decent area can touch the edge (up to 10% border zone)
  if (area >= frameArea * DECENT_AREA_RATIO) return true;

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

function getObjectId(d: ObjectDetectionResult): string {
  return d.id ?? (d.label ? `${d.className}_${d.label}` : null) ?? d.className ?? '';
}

/** True if the detection is a pure motion bbox (no real object class). */
function isMotionOnly(d: ObjectDetectionResult): boolean {
  return isMotionClassname(d.className);
}

/** True if the detection has movement data indicating it is actively moving. */
function isMoving(d: ObjectDetectionResult): boolean {
  const movement = (d as any).movement;
  // No movement data = not tracked by NVR, treat as moving (e.g. onboard detections)
  if (!movement) return true;
  return !!movement.moving;
}

export interface SelectKeyEventDetectionProps {
  detections: ObjectDetectionResult[];
  inputDimensions: [number, number] | undefined;
  /** Set of object ids already saved as key events (never save same id twice). */
  objectIdsAlreadyKeyEvent: Set<string>;
  logger?: Console;
}

export interface KeyEventCandidate {
  detection: ObjectDetectionResult;
  objectId: string;
}

/** A stationary object detected but not cropped. */
export interface StationaryObject {
  detection: ObjectDetectionResult;
  objectId: string;
  boundingBox: BoundingBox;
}

export interface KeyEventSelectionResult {
  /** Moving objects to crop as key events. */
  candidates: KeyEventCandidate[];
  /** Stationary objects detected but not cropped (for future use). */
  stationary: StationaryObject[];
}

/**
 * Select all detections that qualify as key events for this raw event,
 * sorted by priority (face/plate first, then by score descending).
 * Excludes: motion-only bboxes, stationary objects, duplicates, and objects not well visible.
 * Stationary objects are returned separately for reference tracking.
 */
export function selectKeyEventDetections(
  props: SelectKeyEventDetectionProps,
): KeyEventSelectionResult {
  const { detections, inputDimensions, objectIdsAlreadyKeyEvent } = props;
  if (!detections?.length || !inputDimensions?.length) return { candidates: [], stationary: [] };

  const dims = inputDimensions as [number, number];

  // Filter: has bbox, is not pure motion class
  const realObjects = detections.filter(
    (d) =>
      d.boundingBox &&
      Array.isArray(d.boundingBox) &&
      d.boundingBox.length >= 4 &&
      !isMotionOnly(d),
  ) as (ObjectDetectionResult & { boundingBox: BoundingBox })[];

  if (!realObjects.length) return { candidates: [], stationary: [] };

  // Split into moving vs stationary
  const moving: typeof realObjects = [];
  const stationaryRaw: typeof realObjects = [];
  for (const d of realObjects) {
    if (isMoving(d)) {
      moving.push(d);
    } else {
      stationaryRaw.push(d);
    }
  }

  // Build stationary references (no dedup check — we want to track all sightings)
  const stationary: StationaryObject[] = stationaryRaw
    .filter((d) => {
      const pixelBox = toPixelBbox(d.boundingBox, dims);
      return hasMinArea(pixelBox, dims, MIN_AREA_RATIO_FALLBACK);
    })
    .map((d) => ({
      detection: d,
      objectId: String(getObjectId(d) || d.className || ''),
      boundingBox: toPixelBbox(d.boundingBox, dims),
    }));

  // Filter moving objects for visibility
  let candidates = moving.filter((d) => {
    const pixelBox = toPixelBbox(d.boundingBox, dims);
    return isBoundingBoxWellVisible(pixelBox, dims);
  });
  // Fallback: when none pass strict visibility, use best available with minimal area
  if (!candidates.length) {
    candidates = moving.filter((d) => {
      const pixelBox = toPixelBbox(d.boundingBox, dims);
      return hasMinArea(pixelBox, dims, MIN_AREA_RATIO_FALLBACK);
    });
  }
  if (!candidates.length) return { candidates: [], stationary };

  // Remove duplicates (already saved object ids)
  const notDuplicate = candidates.filter((d) => {
    const id = getObjectId(d);
    if (!id) return true;
    return !objectIdsAlreadyKeyEvent.has(id);
  });
  if (!notDuplicate.length) return { candidates: [], stationary };

  // Deduplicate by objectId within this event (keep the highest score per id)
  const bestByObjectId = new Map<string, ObjectDetectionResult>();
  for (const d of notDuplicate) {
    const id = getObjectId(d);
    const existing = bestByObjectId.get(id);
    if (!existing || (d.score ?? 0) > (existing.score ?? 0)) {
      bestByObjectId.set(id, d);
    }
  }

  const unique = Array.from(bestByObjectId.values());
  const sorted = sortBy(unique, (d) => [
    getKeyEventPriority(d.className),
    -(d.score ?? 0),
  ]);

  return {
    candidates: sorted.map((d) => ({
      detection: d,
      objectId: String(getObjectId(d) || d.className || ''),
    })),
    stationary,
  };
}
