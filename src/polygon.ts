
//https://github.com/koush/scrypted/blob/main/plugins/objectdetector/src/polygon.ts
import type { ClipPath, ObjectDetection, ObjectsDetected, Point } from '@scrypted/sdk';
import { DetectionClass } from './detectionClasses';

// x y w h
export type BoundingBox = [number, number, number, number];
/**
 * Checks if a line segment intersects with another line segment
 */
function lineIntersects(
    [x1, y1]: Point,
    [x2, y2]: Point,
    [x3, y3]: Point,
    [x4, y4]: Point
): boolean {
    // Calculate the denominators for intersection check
    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    if (denom === 0) return false; // Lines are parallel

    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

    // Check if intersection point lies within both line segments
    return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

/**
 * Checks if a point is inside a polygon using ray casting algorithm
 */
function pointInPolygon([x, y]: Point, polygon: ClipPath): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Converts a bounding box to an array of its corner points
 */
function boundingBoxToPoints([x, y, w, h]: BoundingBox): Point[] {
    return [
        [x, y],         // top-left
        [x + w, y],     // top-right
        [x + w, y + h], // bottom-right
        [x, y + h]      // bottom-left
    ];
}

/**
 * Checks if a polygon intersects with a bounding box
 */
export function polygonIntersectsBoundingBox(polygon: ClipPath, boundingBox: BoundingBox): boolean {
    // Get bounding box corners
    const boxPoints = boundingBoxToPoints(boundingBox);

    // Check if any polygon edge intersects with any bounding box edge
    for (let i = 0; i < polygon.length; i++) {
        const nextI = (i + 1) % polygon.length;
        const polygonPoint1 = polygon[i];
        const polygonPoint2 = polygon[nextI];

        // Check against all bounding box edges
        for (let j = 0; j < boxPoints.length; j++) {
            const nextJ = (j + 1) % boxPoints.length;
            const boxPoint1 = boxPoints[j];
            const boxPoint2 = boxPoints[nextJ];

            if (lineIntersects(polygonPoint1, polygonPoint2, boxPoint1, boxPoint2)) {
                return true;
            }
        }
    }

    // If no edges intersect, check if either shape contains a point from the other
    if (pointInPolygon(polygon[0], boxPoints) || pointInPolygon(boxPoints[0], polygon))
        return true;
    return false;
}

/**
 * Checks if a polygon completely contains a bounding box
 */
export function polygonContainsBoundingBox(polygon: ClipPath, boundingBox: BoundingBox): boolean {
    // Check if all corners of the bounding box are inside the polygon
    const boxPoints = boundingBoxToPoints(boundingBox);
    return boxPoints.every(point => pointInPolygon(point, polygon));
}


export function normalizeBox(box: BoundingBox, dims: Point): BoundingBox {
    return [box[0] / dims[0], box[1] / dims[1], box[2] / dims[0], box[3] / dims[1]];
}

export function fixLegacyClipPath(clipPath: ClipPath): ClipPath {
    if (!clipPath)
        return;

    // if any value is over abs 2, then divide by 100.
    // this is a workaround for the old scrypted bug where the path was not normalized.
    // this is a temporary workaround until the path is normalized in the UI.
    let needNormalize = false;
    for (const p of clipPath) {
        for (const c of p) {
            if (Math.abs(c) >= 2)
                needNormalize = true;
        }
    }

    if (!needNormalize)
        return clipPath;

    return clipPath.map(p => p.map(c => c / 100)) as ClipPath;
}


export const getNvrThumbnailCrop = (props: {
    detection: ObjectsDetected
}) => {
    const { detection: { inputDimensions, detections } } = props;

    const prio1Det = detections.find(det => [DetectionClass.Face, DetectionClass.Plate].includes(det.className as DetectionClass));
    const prio2Det = detections.find(det => [DetectionClass.Animal, DetectionClass.Person, DetectionClass.Vehicle].includes(det.className as DetectionClass));

    const detToUse = prio1Det ?? prio2Det ?? detections[0];
    const [x, y, width, height] = detToUse.boundingBox;
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    const side = Math.max(width, height);

    let left = Math.floor(centerX - side / 2);
    let top = Math.floor(centerY - side / 2);
    let right = Math.ceil(centerX + side / 2);
    let bottom = Math.ceil(centerY + side / 2);

    if (inputDimensions) {
        const [videoWidth, videoHeight] = inputDimensions;
        left = Math.max(0, left);
        top = Math.max(0, top);
        right = Math.min(videoWidth, right);
        bottom = Math.min(videoHeight, bottom);
    }

    const params = new URLSearchParams({
        height: '200',
        left: left.toString(),
        top: top.toString(),
        right: right.toString(),
        bottom: bottom.toString(),
    });

    return params.toString();
}