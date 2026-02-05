
import sdk, { EventRecorder, MediaObject, RecordedEvent, RecordedEventOptions, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import { StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import { DbDetectionEvent, getEventsInRange } from './db';
import { DetectionClass, detectionClassesDefaultMap } from './detectionClasses';
import { ApiDetectionEvent, ApiDetectionGroup, filterAndGroupEvents, GroupingParams } from './groupEvents';
import AdvancedNotifierPlugin from './main';
import { getWebhooks, getWebHookUrls, ScryptedEventSource } from './utils';

const EVENTS_APP_STATE_JSON_KEY = 'eventsAppStateJson';

type StorageKeys = 'eventsAppStateJson' | string;

export class AdvancedNotifierDataFetcher extends ScryptedDeviceBase implements Settings, EventRecorder, VideoClips {
    initStorage: StorageSettingsDict<StorageKeys> = {
        [EVENTS_APP_STATE_JSON_KEY]: {
            hide: true,
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
}
