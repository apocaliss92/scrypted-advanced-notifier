import { identity, uniq } from 'lodash';
import { DetectionClass, detectionClassesDefaultMap } from './detectionClasses';
import { ScryptedEventSource } from './utils';

/** Event shape come restituito dall'API (id, timestamp, classes, ...). */
export interface ApiDetectionEvent {
    id: string;
    timestamp: number;
    classes: string[];
    label?: string;
    thumbnailUrl: string;
    imageUrl: string;
    source: string;
    deviceName: string;
    deviceId?: string;
    /** Rule artifact type (e.g. Detection, Timelapse) for icon display. */
    ruleType?: string;
    /** Rule artifact video/gif for expansion dialog. */
    videoUrl?: string;
    gifUrl?: string;
    /** Raw key event: one varied detection per object with cropped thumbnail. */
    keyEvent?: boolean;
    /** URL for key-event cropped thumbnail (when keyEvent is true). */
    croppedThumbnailUrl?: string;
}

export interface ApiDetectionGroup {
    events: ApiDetectionEvent[];
    representative: ApiDetectionEvent;
    classes: string[];
    labels: string[];
}

export interface GroupingParams {
    cameras: string[];
    detectionClasses: string[];
    eventSource: string;
    filter: string;
    groupingRange: number;
}

export const RULE_ARTIFACT_SOURCE = 'RuleArtifact';

const SOURCE_PRIORITY: Partial<Record<string, number>> = {
    [RULE_ARTIFACT_SOURCE]: 0,
    [ScryptedEventSource.NVR]: 1,
    [ScryptedEventSource.Frigate]: 2,
    [ScryptedEventSource.RawDetection]: 3,
    ['Auto']: 99,
    ['Default']: 99,
};

export function filterAndGroupEvents(
    events: ApiDetectionEvent[],
    params: GroupingParams
): ApiDetectionGroup[] {
    const { cameras, detectionClasses, eventSource, filter, groupingRange } = params;
    const isOnlyMotion =
        detectionClasses.length === 1 && detectionClasses[0] === DetectionClass.Motion;
    const isAuto = eventSource === 'Auto' || eventSource === ScryptedEventSource.Default || eventSource === ScryptedEventSource.All;
    const timeThreshold = isAuto ? groupingRange * 1000 : 0;

    // Un solo evento per id: evita duplicati da NVR/Frigate/DB e key duplicate in React
    const seenIds = new Set<string>();
    const dedupedEvents = events.filter((e) => {
        if (seenIds.has(e.id)) return false;
        seenIds.add(e.id);
        return true;
    });

    // Empty detectionClasses = no filter (show all)
    const hasClassFilter = detectionClasses.length > 0;

    const sortedEvents = dedupedEvents
        .filter((event) => {
            const isSourceOk =
                eventSource === 'Auto' ||
                eventSource === ScryptedEventSource.All ||
                event.source === eventSource;

            const isClassOk = !hasClassFilter
                ? true
                : isOnlyMotion
                    ? event.classes.length === 1 && event.classes[0] === DetectionClass.Motion
                    : event.classes.some(
                          (c) =>
                              detectionClasses.includes(c) ||
                              detectionClasses.includes(detectionClassesDefaultMap[c] ?? '')
                      ) ||
                      (!!event.label &&
                          (detectionClasses.includes(event.label) ||
                              detectionClasses.includes(detectionClassesDefaultMap[event.label] ?? '')));

            const isCameraOk = !cameras.length
                ? true
                : cameras.includes(event.deviceName)
                || (!!event.deviceId && cameras.includes(event.deviceId))
                || cameras.some((c) => c && event.deviceId && (c === event.deviceId || c.endsWith('_' + event.deviceId) || c.includes(event.deviceId)));
            return (
                isSourceOk &&
                isClassOk &&
                isCameraOk &&
                (filter
                    ? !!(event.label && event.label.toLowerCase().includes(filter.toLowerCase()))
                    : true)
            );
        })
        .map((event) => {
            let classes = event.classes.filter((cl) => cl !== 'any_object');
            if (classes.length > 1) {
                classes = classes.filter((cl) => cl !== 'motion');
            }
            return { ...event, classes };
        })
        .sort((a, b) => b.timestamp - a.timestamp);

    const groups: ApiDetectionGroup[] = [];
    const assigned = new Set<string>();

    for (const event of sortedEvents) {
        if (assigned.has(event.id)) continue;

        const groupEvents: ApiDetectionEvent[] = [event];
        assigned.add(event.id);
        const groupClasses = new Set(event.classes);
        if (event.label) {
            const labelClass = detectionClassesDefaultMap[event.label];
            if (labelClass) groupClasses.add(labelClass);
        }

        for (const other of sortedEvents) {
            if (assigned.has(other.id) || other.deviceName !== event.deviceName) continue;
            const timeDiff = Math.abs(other.timestamp - event.timestamp);
            if (timeDiff > timeThreshold) continue;

            const shared =
                other.classes.some(
                    (c) =>
                        groupClasses.has(detectionClassesDefaultMap[c] ?? c) || groupClasses.has(c)
                ) ||
                (!!other.label &&
                    (groupClasses.has(detectionClassesDefaultMap[other.label] ?? other.label) ||
                        groupClasses.has(other.label)));

            if (shared) {
                if (!assigned.has(other.id)) {
                    groupEvents.push(other);
                    assigned.add(other.id);
                    other.classes.forEach((c) => groupClasses.add(c));
                    if (other.label) {
                        const labelClass = detectionClassesDefaultMap[other.label];
                        if (labelClass) groupClasses.add(labelClass);
                    }
                }
            }
        }

        const rep = groupEvents.reduce((best, cur) => {
            // Prefer key events (varied detection with cropped thumbnail) when in Auto mode
            const key1 = !!best.keyEvent;
            const key2 = !!cur.keyEvent;
            if (key2 && !key1) return cur;
            if (key1 && !key2) return best;

            const p1 = SOURCE_PRIORITY[best.source] ?? 99;
            const p2 = SOURCE_PRIORITY[cur.source] ?? 99;
            if (p2 < p1) return cur;
            if (p2 > p1) return best;
            const hasLabel1 = !!best.label;
            const hasLabel2 = !!cur.label;
            if (hasLabel2 && !hasLabel1) return cur;
            if (hasLabel1 && !hasLabel2) return best;
            return best;
        });
        const representative = rep.croppedThumbnailUrl
            ? { ...rep, thumbnailUrl: rep.croppedThumbnailUrl }
            : rep;

        const classes = uniq(groupEvents.flatMap((e) => e.classes));
        groups.push({
            events: groupEvents,
            representative,
            classes,
            labels: uniq(groupEvents.map((e) => e.label!).filter(identity)),
        });
    }

    return groups;
}
