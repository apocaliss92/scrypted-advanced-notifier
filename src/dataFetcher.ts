import axios from 'axios';
import fs from 'fs';
import https from 'https';
import moment from 'moment';
import path from 'path';
import sdk, { EventRecorder, MediaObject, RecordedEvent, RecordedEventOptions, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import { StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { DbDetectionEvent, getEventsInRange, getMotionInRange } from './db';
import { DetectionClass, defaultDetectionClasses, detectionClassesDefaultMap } from './detectionClasses';
import { ApiDetectionEvent, ApiDetectionGroup, filterAndGroupEvents, GroupingParams, RULE_ARTIFACT_SOURCE } from './groupEvents';
import AdvancedNotifierPlugin from './main';
import { getRuleArtifactsInRange } from './rulesRegister';
import { getAssetsParams, getWebhooks, getWebHookUrls, NVR_PLUGIN_ID, ScryptedEventSource } from './utils';

export type EventsAppResponse = { statusCode: number; body: unknown };

const EVENTS_APP_STATE_JSON_KEY = 'eventsAppStateJson';

type StorageKeys = 'eventsAppStateJson' | string;

export class AdvancedNotifierDataFetcher extends ScryptedDeviceBase implements Settings, EventRecorder, VideoClips {
    initStorage: StorageSettingsDict<StorageKeys> = {
        [EVENTS_APP_STATE_JSON_KEY]: {
            title: 'Events app state',
            json: true,
        },
    };
    logger: Console;

    storageSettings = new StorageSettings(this, this.initStorage);

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId);
    }

    /**
     * V2: returns only events from plugin DBs (NVR/Frigate/Raw are already saved there).
     * Builds direct thumbnail/image URLs. Use this for GetEvents and timeline (GetCameraDayData).
     */
    async getRecordedEventsV2(options: RecordedEventOptions & { sources?: string[]; deviceIds?: string[] }): Promise<RecordedEvent[]> {
        const { endTime, startTime, sources, deviceIds } = options;
        const logger = this.getLogger();
        const { storagePath } = this.plugin.getEventPaths({});
        const [{ privatePathnamePrefix }, { eventThumbnail, eventImage }] = await Promise.all([
            getWebHookUrls({ plugin: this.plugin }),
            getWebhooks(),
        ]);
        const dbEvents = await getEventsInRange({
            startTimestamp: startTime,
            endTimestamp: endTime,
            logger,
            storagePath,
            deviceIds,
        });
        const sourceStr = (e: DbDetectionEvent) => (e.source as string) ?? ScryptedEventSource.RawDetection;
        const events: RecordedEvent[] = dbEvents.map((e) => {
            const devId = e.deviceId ?? '';
            const eventId = e.id ?? '';
            const source = sourceStr(e);
            const thumbnailUrl = `${privatePathnamePrefix}/${eventThumbnail}/${devId}/${eventId}/${source}`;
            const imageUrl = `${privatePathnamePrefix}/${eventImage}/${devId}/${eventId}/${source}`;
            return {
                details: {
                    eventId: e.id,
                    eventTime: e.timestamp ?? 0,
                },
                data: {
                    ...e,
                    thumbnailUrl,
                    imageUrl,
                },
            };
        });
        let filtered = events;
        if (sources && sources.length > 0) {
            const sourceSet = new Set(sources);
            filtered = events.filter((e) => e.data?.source && sourceSet.has(e.data.source as string));
        }
        filtered.sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
        return filtered;
    }

    /**
     * @deprecated Use getRecordedEventsV2. This plugin saves all events (NVR/Frigate/Raw) to DBs; V2 reads only from DBs and builds direct URLs.
     */
    async getRecordedEvents(options: RecordedEventOptions & { sources?: string[] }): Promise<RecordedEvent[]> {
        return this.getRecordedEventsV2(options);
    }

    async getRecordedEventsPaginated(options: RecordedEventOptions & { limit?: number; offset?: number; sources?: string[] }): Promise<{ events: RecordedEvent[]; total: number }> {
        const { limit, offset = 0, sources, ...rest } = options;
        const allEvents = await this.getRecordedEvents({ ...rest, sources } as RecordedEventOptions & { sources?: string[] });
        const total = allEvents.length;

        const events = typeof limit === 'number' && limit >= 0
            ? allEvents.slice(offset, offset + limit)
            : allEvents;

        return { events, total };
    }

    private recordedToApiEvent(r: RecordedEvent): ApiDetectionEvent {
        return {
            id: r.data?.id ?? r.details?.eventId ?? '',
            timestamp: r.data?.timestamp ?? r.details?.eventTime ?? 0,
            classes: r.data?.classes ?? [],
            label: r.data?.label,
            thumbnailUrl: r.data?.thumbnailUrl ?? '',
            imageUrl: r.data?.imageUrl ?? '',
            source: (r.data?.source as string) ?? 'NVR',
            deviceName: r.data?.deviceName ?? '',
            deviceId: r.data?.deviceId,
        };
    }

    async getRecordedEventsGroupedPaginated(
        options: RecordedEventOptions & {
            limit?: number;
            offset?: number;
            sources?: string[];
        } & GroupingParams
    ): Promise<{ groups: ApiDetectionGroup[]; total: number }> {
        const { limit, offset = 0, sources, cameras = [], detectionClasses = [], eventSource, filter = '', groupingRange = 60, ...rest } = options;
        const allRecorded = await this.getRecordedEvents({ ...rest, sources } as RecordedEventOptions & { sources?: string[] });
        const apiEvents: ApiDetectionEvent[] = allRecorded.map((r) => this.recordedToApiEvent(r));
        const allGroups = filterAndGroupEvents(apiEvents, {
            cameras,
            detectionClasses,
            eventSource: eventSource ?? 'Auto',
            filter,
            groupingRange,
        });
        const total = allGroups.length;
        const groups =
            typeof limit === 'number' && limit >= 0
                ? allGroups.slice(offset, offset + limit)
                : allGroups;
        return { groups, total };
    }

    async getVideoClips(options?: VideoClipOptions): Promise<(VideoClip & { deviceName: string; deviceId: string; videoclipHref: string; thumbnailUrl: string })[]> {
        const { startTime, endTime } = options ?? {};
        const { privatePathnamePrefix } = await getWebHookUrls({
            plugin: this.plugin
        });
        const { eventVideoclip, eventVideoclipThumbnail } = await getWebhooks();

        const videoclips: (VideoClip & {
            deviceName: string,
            deviceId: string,
            videoclipHref: string,
            thumbnailUrl: string,
        })[] = [];
        const promises: Promise<VideoClip[]>[] = [];
        const deviceIds: string[] = [];

        for (const deviceId of Object.keys(this.plugin.currentCameraMixinsMap)) {
            const device = sdk.systemManager.getDeviceById<VideoClips & ScryptedDeviceBase>(deviceId);
            if (device.interfaces.includes(ScryptedInterface.VideoClips)) {
                promises.push(device.getVideoClips({
                    startTime,
                    endTime
                }));
                deviceIds.push(device.id);
            }
        }

        const promisesRes = await Promise.all(promises);
        let index = 0;
        for (const cameraVideoclips of promisesRes) {
            const deviceId = deviceIds[index];
            for (const clip of cameraVideoclips) {
                const device = sdk.systemManager.getDeviceById<VideoClips & ScryptedDeviceBase>(deviceId);
                const videoId = clip.videoId ?? clip.id;
                if (videoId == null || videoId === '') continue;
                const videoclipHref = `${privatePathnamePrefix}/${eventVideoclip}/${device?.id}/${encodeURIComponent(videoId)}`;
                let thumbnailUrl = (clip as { thumbnailUrl?: string }).thumbnailUrl
                    ?? (clip as { resources?: { thumbnail?: { href?: string } } }).resources?.thumbnail?.href
                    ?? `${privatePathnamePrefix}/${eventVideoclipThumbnail}/${device?.id}/${encodeURIComponent(videoId)}`;

                videoclips.push({
                    ...clip,
                    deviceName: device.name,
                    deviceId: device.id,
                    videoclipHref,
                    thumbnailUrl,
                    detectionClasses: clip.detectionClasses.filter(cl => !cl.includes('debug'))
                });
            }
            index++;
        }

        return videoclips;
    }

    async getVideoClipsPaginated(options: VideoClipOptions & { limit?: number; offset?: number; cameras?: string[]; detectionClasses?: string[] }): Promise<{ clips: (VideoClip & { deviceName: string; deviceId: string; videoclipHref: string; thumbnailUrl: string })[]; total: number }> {
        const { limit, offset = 0, cameras: camerasFilter, detectionClasses: detectionClassesFilter, ...rest } = options;
        const allClips = await this.getVideoClips(rest as VideoClipOptions);

        const isOnlyMotion = detectionClassesFilter?.length === 1 && detectionClassesFilter[0] === DetectionClass.Motion;

        const filtered = allClips.filter((clip) => {
            const includeCamera = !camerasFilter?.length || (clip.deviceName && camerasFilter.includes(clip.deviceName));
            if (!includeCamera) return false;

            const clipClasses = clip.detectionClasses ?? [];
            const isClassOk = !detectionClassesFilter?.length
                ? true
                : isOnlyMotion
                    ? clipClasses.length === 1 && clipClasses[0] === DetectionClass.Motion
                    : clipClasses.some(
                        (c) =>
                            detectionClassesFilter.includes(c) ||
                            detectionClassesFilter.includes(detectionClassesDefaultMap[c] ?? '')
                    );
            return isClassOk;
        });

        filtered.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));

        const total = filtered.length;
        const clips = typeof limit === 'number' && limit >= 0
            ? filtered.slice(offset, offset + limit)
            : filtered;
        return { clips, total };
    }

    getVideoClip(videoId: string): Promise<MediaObject> {
        throw new Error('Method not implemented.');
    }

    getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        throw new Error('Method not implemented.');
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error('Method not implemented.');
    }

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = this.plugin.getLoggerInternal({
                console: this.console,
                storage: this.storageSettings,
            });

            if (forceNew) {
                return newLogger;
            } else {
                this.logger = newLogger;
            }
        }

        return this.logger;
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    /**
     * Single entry point for all Events App / webhook API requests.
     * Returns statusCode and body to send as JSON; use for easy maintainability.
     */
    async handleEventsAppRequest(apimethod: string, payload: unknown): Promise<EventsAppResponse> {
        const plugin = this.plugin;
        const logger = this.getLogger();

        if (apimethod === 'GetConfigs') {
            const cameras = Object.entries(plugin.currentCameraMixinsMap).map(([id, m]) => ({
                id,
                name: m.name,
                hasNvr: m.hasNvr,
                accessorySwitchKinds: m.getAccessorySwitchKinds(),
            }));
            return { statusCode: 200, body: { cameras, enabledDetectionSources: plugin.enabledDetectionSources } };
        }

        if (apimethod === 'GetCamerasStatus') {
            const cameras: Record<string, {
                notificationsEnabled: boolean;
                isRecording: boolean;
                isSnapshotsEnabled: boolean;
                isRebroadcastEnabled: boolean;
                accessorySwitchStates: Record<string, boolean>;
            }> = {};
            for (const [id, m] of Object.entries(plugin.currentCameraMixinsMap)) {
                try {
                    const state = await m.getCameraMqttCurrentState();
                    cameras[id] = {
                        notificationsEnabled: state.notificationsEnabled,
                        isRecording: state.isRecording,
                        isSnapshotsEnabled: state.isSnapshotsEnabled,
                        isRebroadcastEnabled: state.isRebroadcastEnabled,
                        accessorySwitchStates: state.accessorySwitchStates || {},
                    };
                } catch (e) {
                    logger.warn(`GetCamerasStatus failed for camera ${id}`, e);
                }
            }
            return { statusCode: 200, body: { cameras } };
        }

        if (apimethod === 'GetEvents') {
            const {
                fromDate,
                tillDate,
                limit,
                offset,
                sources: rawSources,
                cameras = [],
                detectionClasses = [],
                eventSource = 'Auto',
                filter = '',
                groupingRange = 60,
            } = (payload ?? {}) as Record<string, unknown>;
            const startTime = Number(fromDate) ?? Date.now() - 86400000;
            const endTime = Number(tillDate) ?? Date.now();
            const offsetNum = typeof offset === 'number' ? offset : 0;
            const limitNum = typeof limit === 'number' && limit >= 0 ? limit : 50;
            const sources = Array.isArray(rawSources) && rawSources.length > 0
                ? rawSources.filter((s: string) => ['All', 'Auto'].indexOf(s) < 0) as string[]
                : undefined;
            const detectionClassesList = Array.isArray(detectionClasses) ? detectionClasses.filter((c): c is string => typeof c === 'string') : [];
            // "rules" is a virtual filter for rule artifacts; exclude from detection-class filter
            const includeRuleArtifacts = detectionClassesList.length === 0 || detectionClassesList.includes('rules');
            const onlyRulesSelected = detectionClassesList.length > 0 && detectionClassesList.every((c) => c === 'rules');
            // When only "rules" selected: no detection event matches "rules", so we get empty event groups
            const detectionClassesForEvents = onlyRulesSelected
                ? ['rules']
                : detectionClassesList.filter((c) => c !== 'rules');

            const { groups: eventGroups } = await this.getRecordedEventsGroupedPaginated({
                startTime,
                endTime,
                limit: undefined,
                offset: 0,
                sources: sources && sources.length > 0 ? sources : undefined,
                cameras: Array.isArray(cameras) ? cameras as string[] : [],
                detectionClasses: detectionClassesForEvents,
                eventSource: typeof eventSource === 'string' ? eventSource : 'Auto',
                filter: typeof filter === 'string' ? filter : '',
                groupingRange: typeof groupingRange === 'number' ? groupingRange : 60,
            });
            const { storagePath } = plugin.getEventPaths({});
            const deviceDirs = await fs.promises.readdir(storagePath).catch(() => []);
            const camerasSet = Array.isArray(cameras) && cameras.length > 0 ? new Set(cameras as string[]) : null;
            const allArtifacts: { deviceId: string; deviceName: string; ruleName: string; ruleType?: string; timestamp: number; imageUrl?: string; gifUrl?: string; videoUrl?: string }[] = [];
            if (includeRuleArtifacts) {
                for (const deviceId of deviceDirs) {
                    const devicePath = path.join(storagePath, deviceId);
                    const stat = await fs.promises.stat(devicePath).catch(() => null);
                    if (!stat?.isDirectory()) continue;
                    const device = sdk.systemManager.getDeviceById(deviceId);
                    const deviceName = (device?.name as string) ?? deviceId;
                    if (camerasSet && !camerasSet.has(deviceName)) continue;
                    const artifacts = await getRuleArtifactsInRange({ storagePath, deviceId, startTimestamp: startTime, endTimestamp: endTime });
                    for (const a of artifacts) {
                        allArtifacts.push({
                            deviceId,
                            deviceName,
                            ruleName: a.ruleName ?? 'Rule',
                            ruleType: a.ruleType,
                            timestamp: a.timestamp,
                            imageUrl: a.imageUrl,
                            gifUrl: a.gifUrl,
                            videoUrl: a.videoUrl,
                        });
                    }
                }
            }
            const ruleArtifactsGroups: ApiDetectionGroup[] = allArtifacts.map((a) => {
                const eventId = `rule-${a.deviceId}-${a.ruleName}-${a.timestamp}`;
                const imageUrl = a.imageUrl ?? '';
                const ev: ApiDetectionEvent = {
                    id: eventId,
                    timestamp: a.timestamp,
                    classes: [a.ruleName],
                    label: a.ruleName,
                    thumbnailUrl: imageUrl,
                    imageUrl,
                    source: RULE_ARTIFACT_SOURCE,
                    deviceName: a.deviceName,
                    deviceId: a.deviceId,
                    ruleType: a.ruleType,
                    videoUrl: a.videoUrl,
                    gifUrl: a.gifUrl,
                };
                return { events: [ev], representative: ev, classes: [a.ruleName], labels: [a.ruleName] };
            });
            const merged = [...ruleArtifactsGroups, ...eventGroups].sort(
                (a, b) => (b.representative?.timestamp ?? 0) - (a.representative?.timestamp ?? 0),
            );
            const total = merged.length;
            const groups = merged.slice(offsetNum, offsetNum + limitNum);
            return { statusCode: 200, body: { groups, total } };
        }

        if (apimethod === 'GetVideoclips') {
            const { fromDate, tillDate, limit, offset, cameras, detectionClasses } = (payload ?? {}) as Record<string, unknown>;
            const startTime = Number(fromDate) ?? Date.now() - 86400000;
            const endTime = Number(tillDate) ?? Date.now();
            const camerasList = Array.isArray(cameras) ? cameras.filter((c): c is string => typeof c === 'string') : undefined;
            const detectionClassesList = Array.isArray(detectionClasses) ? detectionClasses.filter((c): c is string => typeof c === 'string') : undefined;
            const { clips, total } = await this.getVideoClipsPaginated({
                startTime,
                endTime,
                limit: typeof limit === 'number' ? limit : undefined,
                offset: typeof offset === 'number' ? offset : 0,
                cameras: camerasList?.length ? camerasList : undefined,
                detectionClasses: detectionClassesList?.length ? detectionClassesList : undefined,
            });
            const videoclips = clips.map(c => ({
                id: c.videoId ?? c.id,
                deviceName: (c as { deviceName?: string }).deviceName,
                deviceId: (c as { deviceId?: string }).deviceId,
                videoclipHref: (c as { videoclipHref?: string }).videoclipHref,
                thumbnailUrl: (c as { thumbnailUrl?: string }).thumbnailUrl,
                startTime: c.startTime,
                duration: c.duration,
                detectionClasses: (c as { detectionClasses?: string[] }).detectionClasses,
                source: (c as { source?: string }).source,
            }));
            if (videoclips.length > 0) {
                logger.log(`[GetVideoclips] Returning ${videoclips.length} clips. First thumbnailUrl: ${videoclips[0]?.thumbnailUrl?.slice(0, 150)}...`);
            }
            return { statusCode: 200, body: { videoclips, total } };
        }

        if (apimethod === 'GetCameraDayData') {
            const { deviceId, day } = (payload ?? {}) as { deviceId?: string; day?: string };
            if (!deviceId || typeof deviceId !== 'string' || !day || typeof day !== 'string') {
                return { statusCode: 400, body: { error: 'deviceId and day (YYYYMMDD) required' } };
            }
            if (!moment(day, 'YYYYMMDD').isValid()) {
                return { statusCode: 400, body: { error: 'day must be YYYYMMDD' } };
            }
            const startOfDay = moment(day, 'YYYYMMDD').startOf('day').valueOf();
            const endOfDay = moment(day, 'YYYYMMDD').endOf('day').valueOf();
            const { storagePath } = plugin.getEventPaths({});
            const [recorded, motion, artifacts] = await Promise.all([
                this.getRecordedEventsV2({ startTime: startOfDay, endTime: endOfDay, deviceIds: [deviceId] }),
                getMotionInRange({ startTimestamp: startOfDay, endTimestamp: endOfDay, storagePath, deviceIds: [deviceId] }),
                getRuleArtifactsInRange({ storagePath, deviceId, startTimestamp: startOfDay, endTimestamp: endOfDay }),
            ]);
            const events = recorded.map((r) => ({
                id: r.data?.id ?? r.details?.eventId ?? '',
                timestamp: r.data?.timestamp ?? r.details?.eventTime ?? 0,
                classes: r.data?.classes ?? [],
                label: r.data?.label,
                thumbnailUrl: r.data?.thumbnailUrl ?? '',
                imageUrl: r.data?.imageUrl ?? '',
                source: (r.data?.source as string) ?? 'NVR',
                deviceName: r.data?.deviceName ?? '',
                deviceId: r.data?.deviceId ?? '',
                detections: r.data?.detections ?? [],
            }));
            return { statusCode: 200, body: { events, motion, artifacts } };
        }

        if (apimethod === 'GetClusteredDayData') {
            const {
                deviceId,
                days,
                bucketMs: rawBucketMs,
                enabledClasses: rawEnabledClasses,
                classFilter: rawClassFilter,
            } = (payload ?? {}) as Record<string, unknown>;

            if (!deviceId || typeof deviceId !== 'string') {
                return { statusCode: 400, body: { error: 'deviceId (string) required' } };
            }
            if (!Array.isArray(days) || days.length === 0 || days.some((d: unknown) => typeof d !== 'string')) {
                return { statusCode: 400, body: { error: 'days (string[]) required' } };
            }
            const bucketMs = typeof rawBucketMs === 'number' && rawBucketMs > 0 ? rawBucketMs : 5 * 60 * 1000;
            const enabledClasses: string[] = Array.isArray(rawEnabledClasses) ? rawEnabledClasses.filter((c: unknown) => typeof c === 'string') : [];
            const classFilter = typeof rawClassFilter === 'string' ? rawClassFilter : '';

            const { storagePath } = plugin.getEventPaths({});

            // Fetch events, motion, and artifacts for all requested days in parallel
            const dayResults = await Promise.all(
                (days as string[]).map(async (day: string) => {
                    if (!moment(day, 'YYYYMMDD').isValid()) return { events: [], motion: [], artifacts: [] };
                    const startOfDay = moment(day, 'YYYYMMDD').startOf('day').valueOf();
                    const endOfDay = moment(day, 'YYYYMMDD').endOf('day').valueOf();
                    const [recorded, motion, artifacts] = await Promise.all([
                        this.getRecordedEventsV2({ startTime: startOfDay, endTime: endOfDay, deviceIds: [deviceId as string] }),
                        getMotionInRange({ startTimestamp: startOfDay, endTimestamp: endOfDay, storagePath, deviceIds: [deviceId as string] }),
                        getRuleArtifactsInRange({ storagePath, deviceId: deviceId as string, startTimestamp: startOfDay, endTimestamp: endOfDay }),
                    ]);
                    const events = recorded.map((r) => ({
                        id: r.data?.id ?? r.details?.eventId ?? '',
                        timestamp: r.data?.timestamp ?? r.details?.eventTime ?? 0,
                        classes: r.data?.classes ?? [] as string[],
                        label: r.data?.label as string | undefined,
                        thumbnailUrl: r.data?.thumbnailUrl ?? '',
                        imageUrl: r.data?.imageUrl ?? '',
                        source: (r.data?.source as string) ?? 'NVR',
                        deviceName: r.data?.deviceName ?? '',
                        deviceId: r.data?.deviceId ?? '',
                    }));
                    return { events, motion, artifacts };
                }),
            );

            // Merge all days
            let allEvents: typeof dayResults[0]['events'] = [];
            let allMotion: typeof dayResults[0]['motion'] = [];
            let allArtifacts: typeof dayResults[0]['artifacts'] = [];
            for (const dr of dayResults) {
                allEvents.push(...dr.events);
                allMotion.push(...dr.motion);
                allArtifacts.push(...dr.artifacts);
            }

            // --- Filter by enabledClasses ---
            if (enabledClasses.length > 0) {
                const enabledSet = new Set(enabledClasses);
                allEvents = allEvents.filter((evt) => {
                    const evtClasses = evt.classes ?? [];
                    const parentClasses = evtClasses.map((c) => detectionClassesDefaultMap[c] ?? c);
                    const classMatch = evtClasses.some((c) => enabledSet.has(c))
                        || parentClasses.some((c) => enabledSet.has(c));
                    if (!classMatch) return false;

                    // Label required for face, plate, audio
                    const LABEL_REQUIRED = ['face', 'plate', 'audio'];
                    const isLabelRequired = evtClasses.some((c) => LABEL_REQUIRED.includes(c))
                        || parentClasses.some((c) => LABEL_REQUIRED.includes(c));
                    if (isLabelRequired && !evt.label) return false;

                    // Text filter
                    if (classFilter) {
                        const q = classFilter.toLowerCase();
                        const labelMatch = evt.label?.toLowerCase().includes(q);
                        const classNameMatch = evtClasses.some((c) => c.toLowerCase().includes(q));
                        if (!labelMatch && !classNameMatch) return false;
                    }
                    return true;
                });
            }

            // --- Exclude motion-only events ---
            allEvents = allEvents.filter((evt) => !(evt.classes.length === 1 && evt.classes[0] === 'motion'));

            // --- Deduplicate by timestamp + classes + label ---
            const seenKeys = new Set<string>();
            allEvents = allEvents.filter((evt) => {
                const key = `${evt.timestamp}-${(evt.classes ?? []).slice().sort().join(',')}-${evt.label ?? ''}`;
                if (seenKeys.has(key)) return false;
                seenKeys.add(key);
                return true;
            });

            // --- Fixed-grid bucketing ---
            if (allEvents.length > 0 && bucketMs > 0) {
                const allTimestamps = allEvents.map((e) => e.timestamp);
                const minTs = Math.min(...allTimestamps);
                const maxTs = Math.max(...allTimestamps);
                const firstBucket = Math.floor(minTs / bucketMs) * bucketMs;
                const lastBucket = Math.floor(maxTs / bucketMs) * bucketMs;

                const buckets = new Map<number, typeof allEvents>();
                for (const evt of allEvents) {
                    const bs = Math.floor(evt.timestamp / bucketMs) * bucketMs;
                    const list = buckets.get(bs) ?? [];
                    list.push(evt);
                    buckets.set(bs, list);
                }

                const clusters: {
                    events: typeof allEvents;
                    representative: typeof allEvents[0];
                    classes: string[];
                    labels: string[];
                    startMs: number;
                    endMs: number;
                }[] = [];

                for (let startMs = firstBucket; startMs <= lastBucket; startMs += bucketMs) {
                    const bucketEvents = buckets.get(startMs);
                    if (!bucketEvents?.length) continue;
                    const endMs = startMs + bucketMs;

                    // Pick representative: event with most classes, or earliest
                    const representative = bucketEvents.reduce((best, cur) => {
                        const bestCount = (best.classes ?? []).filter((c) => c !== 'any_object' && c !== 'motion').length;
                        const curCount = (cur.classes ?? []).filter((c) => c !== 'any_object' && c !== 'motion').length;
                        if (curCount > bestCount) return cur;
                        if (curCount === bestCount && cur.timestamp < best.timestamp) return cur;
                        return best;
                    });

                    const clsSet = new Set<string>();
                    const lblSet = new Set<string>();
                    for (const evt of bucketEvents) {
                        for (const c of (evt.classes ?? []).filter((cc) => cc !== 'any_object')) {
                            if (c !== 'motion' || (evt.classes ?? []).length === 1) clsSet.add(c);
                            else if ((evt.classes ?? []).length > 1) { /* skip motion when there are other classes */ }
                            else clsSet.add(c);
                        }
                        // Add non-motion classes
                        for (const c of (evt.classes ?? []).filter((cc) => cc !== 'any_object')) {
                            clsSet.add(c);
                        }
                        if (evt.label) lblSet.add(evt.label);
                    }

                    // Return only representative event per cluster to reduce payload and improve timeline performance.
                    clusters.push({
                        events: [representative],
                        representative,
                        classes: [...clsSet],
                        labels: [...lblSet],
                        startMs,
                        endMs,
                    });
                }

                clusters.sort((a, b) => a.startMs - b.startMs);
                return { statusCode: 200, body: { clusters, motion: allMotion, artifacts: allArtifacts } };
            }

            // No events or invalid bucket → return empty clusters
            return { statusCode: 200, body: { clusters: [], motion: allMotion, artifacts: allArtifacts } };
        }

        /** Get all events in a cluster's time range. Lighter than GetClusteredDayData: loads only the day file(s) covering [startMs, endMs]. */
        if (apimethod === 'GetClusterEvents') {
            const { deviceId, startMs, endMs } = (payload ?? {}) as { deviceId?: string; startMs?: number; endMs?: number };
            if (!deviceId || typeof deviceId !== 'string') {
                return { statusCode: 400, body: { error: 'deviceId (string) required' } };
            }
            const start = typeof startMs === 'number' && Number.isFinite(startMs) ? startMs : undefined;
            const end = typeof endMs === 'number' && Number.isFinite(endMs) ? endMs : undefined;
            if (start == null || end == null || start >= end) {
                return { statusCode: 400, body: { error: 'startMs and endMs (numbers, startMs < endMs) required' } };
            }
            const maxSpanMs = 24 * 60 * 60 * 1000;
            if (end - start > maxSpanMs) {
                return { statusCode: 400, body: { error: `Time range must be <= ${maxSpanMs / 1000 / 60} minutes` } };
            }
            const recorded = await this.getRecordedEventsV2({ startTime: start, endTime: end, deviceIds: [deviceId] });
            const events = recorded.map((r) => ({
                id: r.data?.id ?? r.details?.eventId ?? '',
                timestamp: r.data?.timestamp ?? r.details?.eventTime ?? 0,
                classes: r.data?.classes ?? [],
                label: r.data?.label,
                thumbnailUrl: r.data?.thumbnailUrl ?? '',
                imageUrl: r.data?.imageUrl ?? '',
                source: (r.data?.source as string) ?? 'NVR',
                deviceName: r.data?.deviceName ?? '',
                deviceId: r.data?.deviceId ?? '',
            }));
            return { statusCode: 200, body: { events } };
        }

        if (apimethod === 'GetArtifacts') {
            const { deviceId, startTime, endTime } = (payload ?? {}) as { deviceId?: string; startTime?: number | string; endTime?: number | string };
            if (!deviceId || typeof deviceId !== 'string') {
                return { statusCode: 400, body: { error: 'deviceId required' } };
            }
            const start = typeof startTime === 'number' ? startTime : (typeof startTime === 'string' ? parseInt(startTime, 10) : undefined);
            const end = typeof endTime === 'number' ? endTime : (typeof endTime === 'string' ? parseInt(endTime, 10) : undefined);
            if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) {
                return { statusCode: 400, body: { error: 'startTime and endTime (ms) required' } };
            }
            const { storagePath } = plugin.getEventPaths({});
            const artifacts = await getRuleArtifactsInRange({ storagePath, deviceId, startTimestamp: start, endTimestamp: end });
            return { statusCode: 200, body: { artifacts } };
        }

        if (apimethod === 'GetLatestRuleArtifacts') {
            const limitPerSource = 80;
            const since = typeof (payload as Record<string, unknown>)?.since === 'number'
                ? (payload as Record<string, number>).since
                : Date.now() - 7 * 24 * 60 * 60 * 1000;
            const end = Date.now();
            const fiveMinMs = 5 * 60 * 1000;
            const gapFillThresholdMs = 2 * 60 * 1000;
            const maxRuleArtifactsPerKey = 5;

            type ReelItem = { id: string; deviceId: string; deviceName: string; ruleName: string; timestamp: number; imageUrl?: string; gifUrl?: string; videoUrl?: string; source: string; classes: string[] };
            const toOutput = (item: ReelItem) => ({
                deviceId: item.deviceId,
                ruleName: item.ruleName,
                timestamp: item.timestamp,
                imageUrl: item.imageUrl,
                gifUrl: item.gifUrl,
                videoUrl: item.videoUrl,
                classes: item.classes,
            });

            const isMotionOnly = (classes: string[]) => {
                if (classes.length !== 1) return false;
                const c = classes[0];
                return c === DetectionClass.Motion || c === 'motion';
            };

            // 1) Rule artifacts: prefer but limit when same rule+camera emitted continuously (5-min throttle, max N per key)
            const { storagePath } = plugin.getEventPaths({});
            const deviceDirs = await fs.promises.readdir(storagePath).catch(() => []);
            const ruleArtifacts: ReelItem[] = [];
            const ruleLastByKey = new Map<string, number>();
            for (const deviceId of deviceDirs) {
                const devicePath = path.join(storagePath, deviceId);
                const stat = await fs.promises.stat(devicePath).catch(() => null);
                if (!stat?.isDirectory()) continue;
                const artifacts = await getRuleArtifactsInRange({ storagePath, deviceId, startTimestamp: since, endTimestamp: end });
                for (const a of artifacts) {
                    const key = `${deviceId}|${a.ruleName ?? ''}`;
                    const last = ruleLastByKey.get(key);
                    if (last != null && a.timestamp - last < fiveMinMs) continue;
                    ruleLastByKey.set(key, a.timestamp);
                    const id = `rule-${deviceId}-${a.ruleName ?? ''}-${a.timestamp}`;
                    ruleArtifacts.push({ id, deviceId, deviceName: deviceId, ruleName: a.ruleName ?? 'Rule', timestamp: a.timestamp, imageUrl: a.imageUrl, gifUrl: a.gifUrl, videoUrl: a.videoUrl, source: RULE_ARTIFACT_SOURCE, classes: [a.ruleName ?? DetectionClass.Motion] });
                }
            }
            ruleArtifacts.sort((a, b) => b.timestamp - a.timestamp);
            const ruleCountByKey = new Map<string, number>();
            const ruleOutput: ReturnType<typeof toOutput>[] = [];
            for (const item of ruleArtifacts) {
                const key = `${item.deviceId}|${item.ruleName}`;
                const count = ruleCountByKey.get(key) ?? 0;
                if (count >= maxRuleArtifactsPerKey) continue;
                ruleCountByKey.set(key, count + 1);
                ruleOutput.push(toOutput(item));
                if (ruleOutput.length >= limitPerSource) break;
            }

            // 2) NVR, Frigate, Raw: exclude motion-only; prefer NVR then Frigate then Raw (source priority order)
            const reelSourceOrder: Record<string, number> = {
                [ScryptedEventSource.NVR]: 0,
                [ScryptedEventSource.Frigate]: 1,
                [ScryptedEventSource.RawDetection]: 2,
            };
            const recordedBySource = await Promise.all([
                this.getRecordedEventsV2({ startTime: since, endTime: end, sources: [ScryptedEventSource.NVR] }),
                this.getRecordedEventsV2({ startTime: since, endTime: end, sources: [ScryptedEventSource.Frigate] }),
                this.getRecordedEventsV2({ startTime: since, endTime: end, sources: [ScryptedEventSource.RawDetection] }),
            ]);
            const nvrSlice = recordedBySource[0].slice(0, limitPerSource);
            const frigateSlice = recordedBySource[1].slice(0, limitPerSource);
            const rawSlice = recordedBySource[2].slice(0, limitPerSource);

            const recordedToReel = (r: RecordedEvent, source: string): ReelItem => {
                const id = r.data?.id ?? r.details?.eventId ?? '';
                const deviceId = r.data?.deviceId ?? '';
                const deviceName = r.data?.deviceName ?? deviceId;
                const timestamp = r.data?.timestamp ?? r.details?.eventTime ?? 0;
                const imageUrl = r.data?.imageUrl ?? r.data?.thumbnailUrl ?? '';
                const ruleName = (r.data?.label as string) || source;
                const classes = (r.data?.classes as string[]) ?? [DetectionClass.Motion];
                return { id, deviceId, deviceName, ruleName, timestamp, imageUrl, source, classes };
            };
            const idToReelItem = new Map<string, ReelItem>();
            const nvrReel = nvrSlice.map((r) => { const item = recordedToReel(r, ScryptedEventSource.NVR); idToReelItem.set(item.id, item); return item; });
            const frigateReel = frigateSlice.map((r) => { const item = recordedToReel(r, ScryptedEventSource.Frigate); idToReelItem.set(item.id, item); return item; });
            const rawReel = rawSlice.map((r) => { const item = recordedToReel(r, ScryptedEventSource.RawDetection); idToReelItem.set(item.id, item); return item; });

            const detectionReelItems = [...nvrReel, ...frigateReel, ...rawReel]
                .filter((item) => !isMotionOnly(item.classes))
                .sort((a, b) => {
                    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
                    return (reelSourceOrder[a.source] ?? 99) - (reelSourceOrder[b.source] ?? 99);
                });
            const apiEvents: ApiDetectionEvent[] = detectionReelItems.map((item) => ({
                id: item.id,
                timestamp: item.timestamp,
                classes: item.classes,
                label: item.ruleName,
                thumbnailUrl: item.imageUrl ?? '',
                imageUrl: item.imageUrl ?? '',
                source: item.source,
                deviceName: item.deviceName,
                deviceId: item.deviceId,
            }));
            const groups = filterAndGroupEvents(apiEvents, {
                cameras: [],
                detectionClasses: defaultDetectionClasses.filter((c) => c !== DetectionClass.Motion) as unknown as string[],
                eventSource: 'Auto',
                filter: '',
                groupingRange: 60,
            });
            const detectionOutput = groups
                .map((g) => idToReelItem.get(g.representative.id))
                .filter((x): x is ReelItem => x != null)
                .map(toOutput);

            // 3) Combine rules + detection, sort by timestamp desc
            const combined = [...ruleOutput, ...detectionOutput].sort((a, b) => b.timestamp - a.timestamp);

            // 4) Fill gaps > 2 min with Raw events (so reel has no long empty stretches)
            const rawCandidates = rawReel
                .filter((item) => !isMotionOnly(item.classes))
                .map(toOutput);
            const rawByTs = new Map<number, ReturnType<typeof toOutput>>();
            for (const out of rawCandidates) {
                rawByTs.set(out.timestamp, out);
            }
            const fillItems: ReturnType<typeof toOutput>[] = [];
            const usedRawTs = new Set<number>();
            const maxFillPerGap = 3;
            for (let i = 0; i < combined.length - 1; i++) {
                const newerTs = combined[i].timestamp;
                const olderTs = combined[i + 1].timestamp;
                const gap = newerTs - olderTs;
                if (gap <= gapFillThresholdMs) continue;
                let added = 0;
                for (const [ts, out] of rawByTs.entries()) {
                    if (ts <= olderTs || ts >= newerTs) continue;
                    if (usedRawTs.has(ts)) continue;
                    usedRawTs.add(ts);
                    fillItems.push(out);
                    added++;
                    if (added >= maxFillPerGap) break;
                }
            }
            const artifacts = [...combined, ...fillItems].sort((a, b) => b.timestamp - a.timestamp);

            return { statusCode: 200, body: { artifacts } };
        }

        if (apimethod === 'RemoteLog') {
            const { content } = (payload ?? {}) as { content?: string };
            if (typeof content === 'string' && content.length > 0) {
                logger.info('[Events App] ' + content);
            }
            return { statusCode: 200, body: {} };
        }

        return { statusCode: 404, body: { error: `Unknown apimethod: ${apimethod}` } };
    }

    // --- EventsAppApi interface (socket SDK) ---
    private async callApi<T>(apimethod: string, payload?: unknown): Promise<T> {
        const logger = this.plugin.getLogger();
        logger.info('[Events App] callApi:', apimethod, payload);
        const { statusCode, body } = await this.handleEventsAppRequest(apimethod, payload);
        if (statusCode !== 200) {
            const err = (body as { error?: string })?.error ?? JSON.stringify(body);
            throw new Error(err);
        }
        return body as T;
    }

    async getConfigs(): Promise<{ cameras: Array<{ id: string; name: string; hasNvr?: boolean; accessorySwitchKinds?: string[] }>; enabledDetectionSources?: string[] }> {
        return this.callApi('GetConfigs');
    }

    async getCamerasStatus(): Promise<Record<string, { notificationsEnabled: boolean; isRecording: boolean; isSnapshotsEnabled: boolean; isRebroadcastEnabled: boolean; accessorySwitchStates: Record<string, boolean> }>> {
        const r = await this.callApi<{ cameras: Record<string, { notificationsEnabled: boolean; isRecording: boolean; isSnapshotsEnabled: boolean; isRebroadcastEnabled: boolean; accessorySwitchStates: Record<string, boolean> }> }>('GetCamerasStatus');
        return r.cameras ?? {};
    }

    async getEvents(payload: {
        fromDate: number;
        tillDate: number;
        limit?: number;
        offset?: number;
        sources?: string[];
        cameras?: string[];
        detectionClasses?: string[];
        eventSource?: string;
        filter?: string;
        groupingRange?: number;
    }): Promise<{ groups: ApiDetectionGroup[]; total: number }> {
        return this.callApi('GetEvents', payload);
    }

    async getVideoclips(payload: {
        fromDate: number;
        tillDate: number;
        limit?: number;
        offset?: number;
        cameras?: string[];
        detectionClasses?: string[];
    }): Promise<{ videoclips: Array<{ id: string; deviceName?: string; deviceId?: string; videoclipHref?: string; thumbnailUrl?: string; startTime?: number; duration?: number; detectionClasses?: string[]; source?: string }>; total: number }> {
        return this.callApi('GetVideoclips', payload);
    }

    async getCameraDayData(payload: { deviceId: string; day: string }): Promise<{ events: unknown[]; motion: unknown[]; artifacts: unknown[] }> {
        return this.callApi('GetCameraDayData', payload);
    }

    async getClusteredDayData(payload: {
        deviceId: string;
        days: string[];
        bucketMs?: number;
        enabledClasses?: string[];
        classFilter?: string;
    }): Promise<{ clusters: unknown[]; motion: unknown[]; artifacts: unknown[] }> {
        return this.callApi('GetClusteredDayData', payload);
    }

    async getClusterEvents(payload: { deviceId: string; startMs: number; endMs: number }): Promise<{ events: unknown[] }> {
        return this.callApi('GetClusterEvents', payload);
    }

    async getArtifacts(payload: { deviceId: string; startTime: number; endTime: number }): Promise<{ artifacts: unknown[] }> {
        return this.callApi('GetArtifacts', payload);
    }

    async getLatestRuleArtifacts(payload?: { since?: number }): Promise<{ artifacts: unknown[] }> {
        return this.callApi('GetLatestRuleArtifacts', payload ?? {});
    }

    async remoteLog(payload: { content: string }): Promise<void> {
        await this.callApi('RemoteLog', payload);
    }

    /**
     * Get videoclip thumbnail as base64 data. Uses device.getVideoClipThumbnail via SDK.
     * Prefer this over getAsset for videoclip thumbnails.
     */
    async getVideoClipThumbnailData(payload: { deviceId: string; videoId: string }): Promise<{ mimeType: string; data: string }> {
        const { deviceId, videoId } = payload;
        const device = sdk.systemManager.getDeviceById<VideoClips>(deviceId);
        const thumbMo = await device.getVideoClipThumbnail(videoId);
        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(thumbMo, 'image/jpeg');
        return { mimeType: 'image/jpeg', data: jpeg.toString('base64') };
    }

    /**
     * Parse NVR videoId to extract startTime and duration.
     * NVR uses JSON: {"startTime":123,"duration":456} or filename: "123-456-1.mp4".
     */
    private parseNvrVideoIdForClip(videoId: string): { startTime: number; duration: number; filename: string } | null {
        if (!videoId?.trim()) return null;
        try {
            const parsed = JSON.parse(videoId) as { startTime?: number; duration?: number };
            const startTime = parsed?.startTime;
            const duration = parsed?.duration;
            if (typeof startTime === 'number' && typeof duration === 'number' && duration > 0) {
                return { startTime, duration, filename: `${startTime}-${duration}-1.mp4` };
            }
        } catch {
            /* try filename format */
        }
        const match = videoId.match(/^(\d+)-(\d+)(?:-\d+)?(?:\.mp4)?$/);
        if (match) {
            const startTime = parseInt(match[1], 10);
            const duration = parseInt(match[2], 10);
            if (duration > 0) {
                const filename = videoId.includes('.mp4') ? videoId : `${match[1]}-${match[2]}-1.mp4`;
                return { startTime, duration, filename };
            }
        }
        return null;
    }

    /**
     * Get videoclip as base64 stream via socket. Bypasses CORS.
     * For NVR: fetches from Scrypted NVR endpoint (convertMediaObjectToBuffer not supported).
     * For others (Frigate etc): uses convertMediaObjectToBuffer.
     */
    async *getVideoClipData(payload: { deviceId: string; videoId: string; username?: string; password?: string }): AsyncGenerator<{ mimeType?: string; data?: string; done?: boolean }> {
        const { deviceId, videoId, username, password } = payload;
        const logger = this.getLogger();
        const CHUNK_SIZE = 64 * 1024;
        const device = sdk.systemManager.getDeviceById<VideoClips>(deviceId);
        const nvrParsed = this.parseNvrVideoIdForClip(videoId);

        if (nvrParsed) {
            const { assetsOrigin, localAssetsOrigin } = await getAssetsParams({ plugin: this.plugin });
            const base = assetsOrigin || localAssetsOrigin;
            if (!base) {
                logger.warn(`[getVideoClipData] NVR: no assetsOrigin, cannot fetch`);
            } else {
                const nvrClipUrl = `${base}/endpoint/${NVR_PLUGIN_ID}/clip/${deviceId}/${nvrParsed.filename}`;
                const authHeader = username && password
                    ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
                    : {};
                logger.log(`[getVideoClipData] NVR: fetching from ${nvrClipUrl.slice(0, 120)}...`);
                try {
                    const res = await axios.get<Buffer>(nvrClipUrl, {
                        responseType: 'arraybuffer',
                        headers: authHeader,
                        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                    });
                const buffer = Buffer.from(res.data);
                if (!buffer?.length) throw new Error('Empty NVR video response');
                logger.log(`[getVideoClipData] NVR: got ${buffer.length} bytes`);
                yield { mimeType: 'video/mp4' };
                let offset = 0;
                while (offset < buffer.length) {
                    const slice = buffer.subarray(offset, Math.min(offset + CHUNK_SIZE, buffer.length));
                    offset += slice.length;
                    yield { data: slice.toString('base64') };
                }
                yield { done: true };
                return;
                } catch (e) {
                    logger.warn(`[getVideoClipData] NVR fetch failed:`, (e as Error)?.message);
                    throw new Error(`NVR clip fetch failed: ${(e as Error)?.message ?? e}`);
                }
            }
        }

        const mo = await device.getVideoClip(videoId);
        logger.log(`[getVideoClipData] converting MediaObject to buffer...`);
        const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'video/mp4');
        if (!buffer?.length) throw new Error('Empty video buffer');
        logger.log(`[getVideoClipData] got ${buffer.length} bytes`);
        yield { mimeType: 'video/mp4' };
        let offset = 0;
        while (offset < buffer.length) {
            const slice = buffer.subarray(offset, Math.min(offset + CHUNK_SIZE, buffer.length));
            offset += slice.length;
            yield { data: slice.toString('base64') };
        }
        yield { done: true };
    }

    /**
     * Passthrough for image assets (event thumbnails, rule images, clip thumbnails).
     * Maps onRequest handlers to SDK. Path format: "type/deviceId/id/extra" or "type/deviceId/id".
     * Returns base64 data for use in data URLs.
     */
    async getAsset(payload: { path: string; pathParam?: string }): Promise<{ mimeType: string; data: string }> {
        const pathStr = payload.path.replace(/^\/+/, '').split('?')[0];
        const parts = pathStr.split('/');

        const type = parts[0];
        const deviceId = parts[1] ? decodeURIComponent(parts[1]) : '';
        const id = parts[2] ? decodeURIComponent(parts[2]) : '';
        const extra = parts[3] ? decodeURIComponent(parts[3]) : '';
        const pathParam = payload.pathParam;

        const logger = this.getLogger();
        logger.log(`[getAsset] IN: path=${payload.path?.slice(0, 120)}, pathParam=${pathParam?.slice(0, 80)}... | parsed: type=${type}, deviceId=${deviceId}, id=${id?.slice(0, 30)}..., extra=${extra}`);

        const toBase64 = (buf: Buffer, mime: string) => ({ mimeType: mime, data: buf.toString('base64') });

        if (type === 'eventVideoclipThumbnail') {
            const device = sdk.systemManager.getDeviceById<VideoClips>(deviceId);
            const thumbMo = await device.getVideoClipThumbnail(id);
            const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(thumbMo, 'image/jpeg');
            return toBase64(jpeg, 'image/jpeg');
        }

        if (type === 'eventThumbnail' || type === 'eventImage') {
            const source = extra || ScryptedEventSource.RawDetection;
            const cameraId = this.plugin.currentCameraMixinsMap[deviceId]?.id ?? deviceId;
            const { eventThumbnailPath, eventImagePath } = this.plugin.getEventPaths({ cameraId, fileName: id });
            const localPath = type === 'eventThumbnail' ? eventThumbnailPath : eventImagePath;

            if (localPath) {
                try {
                    const jpeg = await fs.promises.readFile(localPath);
                    return toBase64(jpeg, 'image/jpeg');
                } catch {
                    /* fall through */
                }
            }

            if (source === ScryptedEventSource.NVR && pathParam) {
                const { localAssetsOrigin } = await getAssetsParams({ plugin: this.plugin });
                const pathToFetch = (pathParam.startsWith('/') ? pathParam.slice(1) : pathParam);
                const imageUrl = `${localAssetsOrigin}/${pathToFetch}`;
                logger.log(`[getAsset] eventThumbnail NVR: fetching ${imageUrl.slice(0, 100)}...`);
                const res = await axios.get<Buffer>(imageUrl, {
                    responseType: 'arraybuffer',
                    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
                });
                logger.log(`[getAsset] eventThumbnail NVR: got ${res.data?.length ?? 0} bytes`);
                return toBase64(Buffer.from(res.data), 'image/jpeg');
            }

            if (source === ScryptedEventSource.Frigate && this.plugin.frigateApi) {
                const imagePath = type === 'eventThumbnail' ? 'thumbnail' : 'snapshot';
                const imageUrl = `${this.plugin.frigateApi}/events/${id}/${imagePath}.jpg`;
                const res = await axios.get<Buffer>(imageUrl, { responseType: 'arraybuffer' });
                return toBase64(Buffer.from(res.data), 'image/jpeg');
            }

            logger.log(`[getAsset] eventThumbnail/eventImage: NOT FOUND - no localPath, source=${source}, hasPathParam=${!!pathParam}`);
            throw new Error(`Asset not found: ${type}/${deviceId}/${id}`);
        }

        if (type === 'imageRule' || type === 'recordedClipThumbnail') {
            const triggerTime = extra ? Number(extra.split('.')[0]) : undefined;
            const localPath = type === 'imageRule'
                ? this.plugin.getRulePaths({ cameraId: deviceId, ruleName: id, triggerTime }).imageHistoricalPath
                : this.plugin.getRecordedEventPath({ cameraId: deviceId, fileName: id.split('.')[0] }).recordedThumbnailPath;
            if (!localPath) throw new Error(`Asset not found: ${type}/${deviceId}/${id}`);
            const buf = await fs.promises.readFile(localPath);
            return toBase64(buf, 'image/jpeg');
        }

        if (type === 'gifRule') {
            const triggerTime = extra ? Number(extra.split('.')[0]) : undefined;
            const { gifHistoricalPath } = this.plugin.getRulePaths({ cameraId: deviceId, ruleName: id, triggerTime });
            if (!gifHistoricalPath) throw new Error(`Asset not found: ${type}/${deviceId}/${id}`);
            const buf = await fs.promises.readFile(gifHistoricalPath);
            return toBase64(buf, 'image/gif');
        }

        throw new Error(`Unknown asset type: ${type}`);
    }
}
