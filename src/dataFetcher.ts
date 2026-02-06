import fs from 'fs';
import moment from 'moment';
import path from 'path';
import sdk, { EventRecorder, MediaObject, RecordedEvent, RecordedEventOptions, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import { StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { DbDetectionEvent, getEventsInRange, getMotionInRange } from './db';
import { DetectionClass, defaultDetectionClasses, detectionClassesDefaultMap } from './detectionClasses';
import { ApiDetectionEvent, ApiDetectionGroup, filterAndGroupEvents, GroupingParams, RULE_ARTIFACT_SOURCE } from './groupEvents';
import AdvancedNotifierPlugin from './main';
import { getRuleArtifactsInRange } from './rulesRegister';
import { getWebhooks, getWebHookUrls, ScryptedEventSource } from './utils';

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

    async getVideoClips(options?: VideoClipOptions): Promise<(VideoClip & { deviceName: string; deviceId: string; videoclipHref: string })[]> {
        const { startTime, endTime } = options ?? {};
        const { privatePathnamePrefix } = await getWebHookUrls({
            plugin: this.plugin
        });
        const { eventVideoclip } = await getWebhooks();

        const videoclips: (VideoClip & {
            deviceName: string,
            deviceId: string,
            videoclipHref: string,
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

                videoclips.push({
                    ...clip,
                    deviceName: device.name,
                    deviceId: device.id,
                    videoclipHref,
                    detectionClasses: clip.detectionClasses.filter(cl => !cl.includes('debug'))
                });
            }
            index++;
        }

        return videoclips;
    }

    async getVideoClipsPaginated(options: VideoClipOptions & { limit?: number; offset?: number; cameras?: string[]; detectionClasses?: string[] }): Promise<{ clips: (VideoClip & { deviceName: string; deviceId: string; videoclipHref: string })[]; total: number }> {
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
            const sources = Array.isArray(rawSources) && rawSources.length > 0
                ? rawSources.filter((s: string) => ['All', 'Auto'].indexOf(s) < 0) as string[]
                : undefined;
            const { groups, total } = await this.getRecordedEventsGroupedPaginated({
                startTime,
                endTime,
                limit: typeof limit === 'number' ? limit : undefined,
                offset: offsetNum,
                sources: sources && sources.length > 0 ? sources : undefined,
                cameras: Array.isArray(cameras) ? cameras as string[] : [],
                detectionClasses: Array.isArray(detectionClasses) ? detectionClasses as string[] : [],
                eventSource: typeof eventSource === 'string' ? eventSource : 'Auto',
                filter: typeof filter === 'string' ? filter : '',
                groupingRange: typeof groupingRange === 'number' ? groupingRange : 60,
            });
            let ruleArtifactsGroups: ApiDetectionGroup[] = [];
            if (offsetNum === 0) {
                const { storagePath } = plugin.getEventPaths({});
                const deviceDirs = await fs.promises.readdir(storagePath).catch(() => []);
                const camerasSet = Array.isArray(cameras) && cameras.length > 0 ? new Set(cameras as string[]) : null;
                const allArtifacts: { deviceId: string; deviceName: string; ruleName: string; ruleType?: string; timestamp: number; imageUrl?: string; gifUrl?: string; videoUrl?: string }[] = [];
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
                ruleArtifactsGroups = allArtifacts.map((a) => {
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
            }
            return { statusCode: 200, body: { groups, total, ruleArtifacts: ruleArtifactsGroups } };
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
                startTime: c.startTime,
                duration: c.duration,
                detectionClasses: (c as { detectionClasses?: string[] }).detectionClasses,
                source: (c as { source?: string }).source,
            }));
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
}
