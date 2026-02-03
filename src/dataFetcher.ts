
import sdk, { Camera, EventRecorder, MediaObject, ObjectsDetected, RecordedEvent, RecordedEventOptions, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from '@scrypted/sdk';
import { StorageSettings, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import axios from 'axios';
import { groupBy, uniq } from 'lodash';
import { DetectionData as FrigateEvent } from '../../scrypted-frigate-bridge/src/utils';
import { DbDetectionEvent, getEventsInRange } from './db';
import { DetectionClass, detectionClassesDefaultMap } from './detectionClasses';
import { ApiDetectionEvent, ApiDetectionGroup, filterAndGroupEvents, GroupingParams } from './groupEvents';
import AdvancedNotifierPlugin from './main';
import { getNvrThumbnailCrop } from './polygon';
import { getAssetSource, getDetectionEventKey, getWebHookUrls, getWebhooks, moToB64, ScryptedEventSource } from './utils';

type StorageKeys = string;

export class AdvancedNotifierDataFetcher extends ScryptedDeviceBase implements Settings, EventRecorder, VideoClips {
    initStorage: StorageSettingsDict<StorageKeys> = {
    };
    logger: Console;

    storageSettings = new StorageSettings(this, this.initStorage);

    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId);
    }

    async getRecordedEvents(options: RecordedEventOptions & { sources?: string[] }): Promise<RecordedEvent[]> {
        const { endTime, startTime, sources } = options;
        const { privatePathnamePrefix } = await getWebHookUrls({
            plugin: this.plugin
        });
        const { eventThumbnail, eventImage } = await getWebhooks();
        const logger = this.getLogger();

        const events: RecordedEvent[] = [];

        const nvrPromises: Promise<RecordedEvent[]>[] = [];
        let deviceIds: string[] = [];

        for (const deviceId of Object.keys(this.plugin.currentCameraMixinsMap)) {
            const device = sdk.systemManager.getDeviceById<EventRecorder & ScryptedDeviceBase>(deviceId);
            if (device.interfaces.includes(ScryptedInterface.EventRecorder)) {
                nvrPromises.push(device.getRecordedEvents({
                    startTime,
                    endTime,
                }));
                deviceIds.push(device.id);
            }
        }

        const nvrPromisesRes = await Promise.all(nvrPromises);
        let index = 0;
        for (const nvrCameraEvents of nvrPromisesRes) {
            const deviceId = deviceIds[index];
            const device = sdk.systemManager.getDeviceById<EventRecorder & ScryptedDeviceBase>(deviceId);
            for (const event of nvrCameraEvents) {
                const { isEventsRecorder } = getAssetSource({ sourceId: event.details.mixinId });

                const pluginEventPath = isEventsRecorder ?
                    '@apocaliss92/scrypted-events-recorder' :
                    '@scrypted/nvr';

                if (event.details.eventInterface === ScryptedInterface.ObjectDetector && event.data) {
                    const detection: ObjectsDetected = event.data;
                    const classes = uniq(detection.detections.map(det => det.className)
                        .filter(cl => !cl.includes('debug')));

                    const eventId = getDetectionEventKey({
                        detectionId: detection.detectionId,
                        eventId: event.details.eventId
                    });

                    if (classes.length === 1 && classes[0] === DetectionClass.Motion) {
                        events.push({
                            details: event.details,
                            data: {
                                source: ScryptedEventSource.NVR,
                                eventId,
                                classes: ['motion'],
                                score: 1,
                                detections: detection.detections,
                                id: detection.detectionId,
                                deviceName: device.name,
                                deviceId: device.id,
                                timestamp: detection.timestamp,
                                thumbnailUrl: `${privatePathnamePrefix}/${eventThumbnail}/${deviceId}/${detection.detectionId}/${ScryptedEventSource.NVR}?path=${encodeURIComponent(`endpoint/${pluginEventPath}/thumbnail/${deviceId}/${detection.timestamp}.jpg?height=200`)}`,
                                imageUrl: `${privatePathnamePrefix}/${eventImage}/${deviceId}/${detection.detectionId}/${ScryptedEventSource.NVR}?path=${encodeURIComponent(`endpoint/${pluginEventPath}/thumbnail/${deviceId}/${detection.timestamp}.jpg?height=1200`)}`,
                            } as DbDetectionEvent
                        });
                    } else {
                        const labelDet = detection.detections.find(det => det.label);
                        const thumbnailSearchParams = getNvrThumbnailCrop({ detection });
                        events.push({
                            details: event.details,
                            data: {
                                source: ScryptedEventSource.NVR,
                                classes,
                                eventId,
                                label: labelDet?.label,
                                detections: detection.detections,
                                id: detection.detectionId,
                                deviceName: device.name,
                                deviceId: device.id,
                                timestamp: detection.timestamp,
                                thumbnailUrl: `${privatePathnamePrefix}/${eventThumbnail}/${deviceId}/${detection.detectionId}/${ScryptedEventSource.NVR}?path=${encodeURIComponent(`endpoint/${pluginEventPath}/thumbnail/${deviceId}/${detection.timestamp}.jpg?${thumbnailSearchParams}`)}`,
                                imageUrl: `${privatePathnamePrefix}/${eventImage}/${deviceId}/${detection.detectionId}/${ScryptedEventSource.NVR}?path=${encodeURIComponent(`endpoint/${pluginEventPath}/thumbnail/${deviceId}/${detection.timestamp}.jpg?height=1200`)}`,
                            } as DbDetectionEvent
                        }
                        );
                    }
                }
            }
            index++;
        }

        if (this.plugin.frigateApi) {
            try {
                const frigateEvents = await axios.get<FrigateEvent[]>(`${this.plugin.frigateApi}/events?limit=99999999&has_snapshot=1&after=${startTime / 1000}&before=${endTime / 1000}`);
                const eventsPerCamera = groupBy(frigateEvents.data, e => e.camera);

                for (const cameraMixin of Object.values(this.plugin.currentCameraMixinsMap)) {
                    const { cameraName } = await cameraMixin.getFrigateData();
                    if (cameraName) {
                        const frigateEvents = eventsPerCamera[cameraName] ?? [];

                        for (const event of frigateEvents) {
                            const label = event.label;
                            const subLabel = event.sub_label;
                            const isAudioEvent = event.data.type === 'audio';
                            const timestamp = Math.trunc(event.start_time * 1000);
                            events.push({
                                details: {
                                    eventId: event.id,
                                    eventTime: timestamp
                                },
                                data: {
                                    source: ScryptedEventSource.Frigate,
                                    classes: isAudioEvent ? ['audio'] : ['motion', label],
                                    label: isAudioEvent ? label : subLabel?.[0],
                                    id: event.id,
                                    deviceName: cameraMixin.name,
                                    timestamp,
                                    thumbnailUrl: `${privatePathnamePrefix}/${eventThumbnail}/${cameraMixin.id}/${event.id}/${ScryptedEventSource.Frigate}`,
                                    imageUrl: `${privatePathnamePrefix}/${eventImage}/${cameraMixin.id}/${event.id}/${ScryptedEventSource.Frigate}`,
                                } as DbDetectionEvent,
                            });
                        }
                    }
                }
            } catch (e) {
                logger.info(`Frigate fetching error`, e);
            }
        }

        const { storagePath } = this.plugin.getEventPaths({});
        const rawEvents = await getEventsInRange({
            startTimestamp: startTime,
            endTimestamp: endTime,
            logger,
            storagePath,
        });

        const anEvents = rawEvents.filter(e => e.source === ScryptedEventSource.RawDetection);
        const devicesMap: Record<string, ScryptedDevice> = {};
        for (const event of anEvents) {
            const { deviceId, deviceName } = event;
            const deviceIdentifier = deviceId || deviceName;
            let device: ScryptedDevice = devicesMap[deviceIdentifier];

            if (!device) {
                if (deviceId) {
                    device = sdk.systemManager.getDeviceById(deviceId);
                } else if (deviceName) {
                    device = sdk.systemManager.getDeviceByName(deviceName);
                }
            }

            if (!device) {
                continue;
            }

            devicesMap[deviceIdentifier] = device;

            events.push({
                details: {
                    eventId: event.id,
                    eventTime: event.timestamp,
                },
                data: {
                    ...event,
                    thumbnailUrl: `${privatePathnamePrefix}/${eventThumbnail}/${device.id}/${event.id}/${ScryptedEventSource.RawDetection}`,
                    imageUrl: `${privatePathnamePrefix}/${eventImage}/${device.id}/${event.id}/${ScryptedEventSource.RawDetection}`,
                }
            });
        }

        let filtered = events;
        if (sources && sources.length > 0) {
            const sourceSet = new Set(sources);
            filtered = events.filter(e => e.data?.source && sourceSet.has(e.data.source as string));
        }
        filtered.sort((a, b) => (b.data?.timestamp ?? 0) - (a.data?.timestamp ?? 0));
        return filtered;
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

    async getCameraSnapshots(): Promise<{ deviceId: string; deviceName: string; snapshotDataUrl: string | null }[]> {
        const results: { deviceId: string; deviceName: string; snapshotDataUrl: string | null }[] = [];
        const logger = this.getLogger();

        for (const [deviceId, mixin] of Object.entries(this.plugin.currentCameraMixinsMap)) {
            try {
                const device = sdk.systemManager.getDeviceById(deviceId);
                if (!device?.interfaces?.includes(ScryptedInterface.Camera)) continue;

                const camera = device as unknown as Camera;
                const mo = await camera.takePicture({
                    reason: 'periodic',
                    bulkRequest: true,
                    timeout: 8000,
                    picture: { width: 640 },
                });
                const b64 = await moToB64(mo);
                results.push({
                    deviceId,
                    deviceName: mixin.name,
                    snapshotDataUrl: b64 ? `data:image/jpeg;base64,${b64}` : null,
                });
            } catch (e) {
                logger.info(`Snapshot error for ${mixin.name}: ${(e as Error)?.message}`);
                results.push({ deviceId, deviceName: mixin.name, snapshotDataUrl: null });
            }
        }
        return results;
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
        const { useRuleNotifiers } = this.storageSettings.values;
        this.storageSettings.settings.notifiers.hide = useRuleNotifiers;
        this.storageSettings.settings.activeNotifiers.hide = !useRuleNotifiers;
        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }
}
