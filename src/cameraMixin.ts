import sdk, { EventDetails, EventListenerRegister, Image, ImageEmbedding, MediaObject, MediaStreamDestination, Notifier, ObjectDetection, ObjectDetectionResult, ObjectsDetected, PanTiltZoomCommand, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, Settings, TextEmbedding, VideoClip, VideoClipOptions, VideoClipThumbnailOptions, VideoClips, VideoFrame, VideoFrameGenerator } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import fs from 'fs';
import { cloneDeep, sortBy, uniqBy } from "lodash";
import moment from "moment";
import { Config, JsonDB } from "node-json-db";
import { getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import { filterOverlappedDetections } from '../../scrypted-basic-object-detector/src/util';
import { FrigateObjectDetection, objectDetectorNativeId } from '../../scrypted-frigate-bridge/src/utils';
import { Deferred } from "../../scrypted/server/src/deferred";
import { DetectionClass, defaultDetectionClasses, detectionClassesDefaultMap, isFaceClassname, isMotionClassname, isObjectClassname, isPlateClassname, levenshteinDistance } from "./detectionClasses";
import HomeAssistantUtilitiesProvider from "./main";
import { idPrefix, publishBasicDetectionData, publishCameraValues, publishClassnameImages, publishOccupancy, publishPeopleData, publishResetDetectionsEntities, publishResetRuleEntities, publishRuleData, publishRuleEnabled, setupCameraAutodiscovery, subscribeToCameraMqttTopics } from "./mqtt-utils";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from "./polygon";
import { ADVANCED_NOTIFIER_INTERFACE, AudioRule, BaseRule, DECODER_FRAME_MIN_TIME, DETECTION_CLIP_PREFIX, DecoderType, DelayType, DetectionRule, DeviceInterface, GetImageReason, ImageSource, IsDelayPassedProps, MatchRule, MixinBaseSettingKey, NVR_PLUGIN_ID, ObserveZoneData, OccupancyRule, RuleSource, RuleType, SNAPSHOT_WIDTH, ScryptedEventSource, TIMELAPSE_CLIP_PREFIX, TimelapseRule, VIDEO_ANALYSIS_PLUGIN_ID, ZoneMatchType, b64ToMo, convertSettingsToStorageSettings, filterAndSortValidDetections, getActiveRules, getAllDevices, getAudioRulesSettings, getB64ImageLog, getDetectionEventKey, getDetectionKey, getDetectionRulesSettings, getDetectionsLog, getMixinBaseSettings, getOccupancyRulesSettings, getRuleKeys, getRulesLog, getTimelapseRulesSettings, getWebHookUrls, moToB64, similarityConcidenceThresholdMap, splitRules } from "./utils";
import { addZoneClipPathToImage } from "./drawingUtils";
import { checkObjectsOccupancy } from "./aiUtils";

const { systemManager } = sdk;

interface CurrentOccupancyState {
    occupancyToConfirm?: boolean,
    confirmationStart?: number,
    lastChange: number,
    lastCheck: number,
    score: number,
    b64Image: string;
    confirmedFrames: number;
    rejectedFrames: number;
    referenceZone: ObserveZoneData;
    occupies: boolean;
    objectsDetected: number;
}

const getInitOccupancyState = (rule: OccupancyRule): CurrentOccupancyState => {
    return {
        lastChange: undefined,
        confirmationStart: undefined,
        occupancyToConfirm: undefined,
        confirmedFrames: 0,
        rejectedFrames: 0,
        lastCheck: undefined,
        score: undefined,
        b64Image: undefined,
        referenceZone: undefined,
        occupies: rule.occupies,
        objectsDetected: rule.detectedObjects,
    }
}

export type OccupancyRuleData = {
    rule: OccupancyRule;
    occupies: boolean;
    changed?: boolean;
    image?: MediaObject;
    b64Image?: string;
    triggerTime: number;
    objectsDetected?: number;
    objectsDetectedResult: ObjectsDetected[];
};

interface AccumulatedDetection { detect: ObjectsDetected, eventId: string, eventSource: ScryptedEventSource };

type CameraSettingKey =
    | 'ignoreCameraDetections'
    | 'notificationsEnabled'
    | 'aiEnabled'
    | 'schedulerEnabled'
    | 'startTime'
    | 'endTime'
    | 'notifierActions'
    | 'minSnapshotDelay'
    | 'minMqttPublishDelay'
    | 'detectionSourceForMqtt'
    | 'motionDuration'
    | 'checkOccupancy'
    | 'useDecoder'
    | 'decoderType'
    | 'lastSnapshotWebhook'
    | 'lastSnapshotWebhookCloudUrl'
    | 'lastSnapshotWebhookLocalUrl'
    | 'postDetectionImageWebhook'
    | 'postDetectionImageUrls'
    | 'postDetectionImageClasses'
    | 'postDetectionImageMinDelay'
    | MixinBaseSettingKey;

export class AdvancedNotifierCameraMixin extends SettingsMixinDeviceBase<any> implements Settings, VideoClips {
    initStorage: StorageSettingsDict<CameraSettingKey> = {
        ...getMixinBaseSettings({
            plugin: this.plugin,
            mixin: this,
            refreshSettings: this.refreshSettings.bind(this)
        }),
        ignoreCameraDetections: {
            title: 'Ignore camera detections',
            description: 'If checked, the detections reported by the camera will be ignored. Make sure to have an object detector mixin enabled',
            type: 'boolean',
            immediate: true,
            subgroup: 'Advanced',
        },
        notificationsEnabled: {
            title: 'Notifications enabled',
            description: 'Enable notifications related to this camera',
            type: 'boolean',
            subgroup: 'Notifier',
            immediate: true,
            defaultValue: true,
        },
        aiEnabled: {
            title: 'AI descriptions',
            description: 'Use configured AI to generate descriptions',
            type: 'boolean',
            subgroup: 'Notifier',
            immediate: true,
            defaultValue: false,
        },
        schedulerEnabled: {
            type: 'boolean',
            subgroup: 'Notifier',
            title: 'Scheduler',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        startTime: {
            title: 'Start time',
            subgroup: 'Notifier',
            type: 'time',
            immediate: true,
        },
        endTime: {
            title: 'End time',
            subgroup: 'Notifier',
            type: 'time',
            immediate: true,
        },
        notifierActions: {
            title: 'Default actions',
            description: 'Actions to show on every notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door", "url": "url"}',
            subgroup: 'Notifier',
            type: 'string',
            multiple: true,
            defaultValue: [],
        },
        minSnapshotDelay: {
            title: 'Minimum snapshot acquisition delay',
            description: 'Minimum amount of seconds to wait until a new snapshot is taken from the camera',
            type: 'number',
            defaultValue: 5,
            subgroup: 'Advanced',
        },
        minMqttPublishDelay: {
            title: 'Minimum MQTT publish delay',
            description: 'Minimum amount of seconds to wait a new image is published to MQTT for the basic detections',
            type: 'number',
            defaultValue: 5,
            subgroup: 'Advanced',
        },
        detectionSourceForMqtt: {
            title: 'Detections source',
            description: 'Which source should be used to update MQTT. Default will use the plugin setting',
            type: 'string',
            immediate: true,
            combobox: true,
            defaultValue: 'Default',
            choices: [],
        },
        motionDuration: {
            title: 'Off motion duration',
            type: 'number',
            defaultValue: 10,
            subgroup: 'Advanced',
        },
        checkOccupancy: {
            title: 'Check objects occupancy',
            description: 'Regularly check objects presence and report it to MQTT, performance intensive',
            type: 'boolean',
            immediate: true,
        },
        useDecoder: {
            title: 'Snapshot from Decoder',
            description: '[ATTENTION] Performance intensive and high cpu prone, ONLY use if you see many timeout errors on snapshot for cameras with frequent motion',
            type: 'boolean',
            immediate: true,
        },
        decoderType: {
            title: 'Snapshot from Decoder',
            description: 'Define when to run a decoder to get more frequent snapshots. It will be enabled only if there is any running timelapse rule, occupancy rule or detection rule with videoclips',
            type: 'string',
            immediate: true,
            choices: [
                DecoderType.Off,
                DecoderType.OnMotion,
                DecoderType.Always,
            ]
        },
        // WEBHOOKS
        lastSnapshotWebhook: {
            subgroup: 'Webhooks',
            title: 'Last snapshot',
            description: 'Check README for possible IMAGE_NAME to use',
            type: 'boolean',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        lastSnapshotWebhookCloudUrl: {
            subgroup: 'Webhooks',
            type: 'html',
            title: 'Cloud URL',
            readonly: true,
        },
        lastSnapshotWebhookLocalUrl: {
            subgroup: 'Webhooks',
            type: 'html',
            title: 'Local URL',
            readonly: true,
        },
        postDetectionImageWebhook: {
            subgroup: 'Webhooks',
            title: 'Post detection image',
            description: 'Execute a POST call to multiple URLs with the selected detection classes',
            type: 'boolean',
            immediate: true,
            onPut: async () => await this.refreshSettings()
        },
        postDetectionImageUrls: {
            subgroup: 'Webhooks',
            title: 'URLs',
            type: 'string',
            multiple: true,
            defaultValue: [],
        },
        postDetectionImageClasses: {
            subgroup: 'Webhooks',
            title: 'Detection classes',
            multiple: true,
            combobox: true,
            type: 'string',
            choices: defaultDetectionClasses,
            defaultValue: []
        },
        postDetectionImageMinDelay: {
            subgroup: 'Webhooks',
            title: 'Minimum posting delay',
            type: 'number',
            defaultValue: 15,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    mqttClient: MqttClient;
    cameraDevice: DeviceInterface;
    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    binaryListener: EventListenerRegister;
    audioVolumesListener: EventListenerRegister;
    audioSensorListener: EventListenerRegister;
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    mainLoopListener: NodeJS.Timeout;
    isActiveForMqttReporting: boolean;
    isActiveForNvrNotifications: boolean;
    isActiveForDoorbelDetections: boolean;
    isActiveForAudioVolumesDetections: boolean;
    isActiveForAudioSensorDetections: boolean;
    initializingMqtt: boolean;
    lastAutoDiscovery: number;
    lastFramesCleanup: number;
    logger: Console;
    killed: boolean;
    framesGeneratorSignal = new Deferred<void>().resolve();
    frameGenerationStartTime: number;
    runningOccupancyRules: OccupancyRule[] = [];
    runningDetectionRules: DetectionRule[] = [];
    runningTimelapseRules: TimelapseRule[] = [];
    runningAudioRules: AudioRule[] = [];
    availableTimelapseRules: TimelapseRule[] = [];
    allAvailableRules: BaseRule[] = [];
    audioRuleSamples: Record<string, {
        timestamp: number;
        dBs: number;
        dev: number;
    }[]> = {};
    detectionRuleListeners: Record<string, {
        disableNvrRecordingTimeout?: NodeJS.Timeout;
        turnOffTimeout?: NodeJS.Timeout;
    }> = {};
    lastDelaySet: Record<string, number> = {};
    lastObserveZonesFetched: number;
    observeZoneData: ObserveZoneData[];
    frigateLabels: string[];
    frigateZones: string[];
    frigateCameraName: string;
    lastFrigateDataFetched: number;
    occupancyState: Record<string, CurrentOccupancyState> = {};
    timelapseLastCheck: Record<string, number> = {};
    timelapseLastGenerated: Record<string, number> = {};
    lastImage?: MediaObject;
    lastFrame?: Buffer;
    lastFrameAcquired?: number;
    lastB64Image?: string;
    lastPictureTaken?: number;
    processingOccupanceData?: boolean;
    rtspUrl: string;
    decoderStream: MediaStreamDestination;
    decoderResize: boolean;
    checkingOutatedRules: boolean;

    accumulatedDetections: AccumulatedDetection[] = [];
    accumulatedRules: MatchRule[] = [];
    processDetectionsInterval: NodeJS.Timeout;
    processingAccumulatedDetections = false;
    clientId: string;

    snoozeUntilDic: Record<string, number> = {};
    consumedDetectionIdsSet: Set<string> = new Set();

    lastMotionEnd: number;
    currentSnapshotTimeout = 4000;

    clipGenerationTimeout: Record<string, NodeJS.Timeout> = {};

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: HomeAssistantUtilitiesProvider
    ) {
        super(options);
        const logger = this.getLogger();

        this.clientId = `scrypted_an_camera_${this.id}`;
        this.plugin.currentCameraMixinsMap[this.id] = this;

        this.cameraDevice = systemManager.getDeviceById<DeviceInterface>(this.id);

        this.initValues().catch(logger.log);

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).catch(logger.log);
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const videoClips: VideoClip[] = [];

        try {
            const deviceClips = await this.mixinDevice.getVideoClips(options);
            videoClips.push(...deviceClips);
        } catch { }

        const internalClips = await this.getVideoClipsInternal(options);
        videoClips.push(...internalClips);

        return sortBy(videoClips, 'startTime');
    }

    async getVideoClipsInternal(options?: VideoClipOptions): Promise<VideoClip[]> {
        const videoClips: VideoClip[] = [];
        const logger = this.getLogger();
        const cameraFolder = this.name;

        const cameraDevice = sdk.systemManager.getDeviceByName<ScryptedDeviceBase>(cameraFolder);
        const { rulesPath } = this.plugin.getRulePaths({ cameraName: cameraFolder });

        let hasRules = true;

        try {
            await fs.promises.access(rulesPath);
        } catch (e) {
            hasRules = false;
        }

        if (hasRules) {
            const rulesFolder = await fs.promises.readdir(rulesPath);

            for (const ruleFolder of rulesFolder) {
                const { generatedPath } = this.plugin.getRulePaths({
                    cameraName: cameraFolder,
                    ruleName: ruleFolder
                });

                const files = await fs.promises.readdir(generatedPath);

                for (const file of files) {
                    const [fileName, extension] = file.split('.');
                    if (extension === 'mp4') {
                        const timestamp = Number(fileName);

                        if (timestamp > options.startTime && timestamp < options.endTime) {
                            const { fileId } = this.plugin.getRulePaths({
                                cameraName: cameraFolder,
                                fileName,
                                ruleName: ruleFolder
                            });
                            const { videoclipThumbnailUrl, videoclipStreamUrl } = await getWebHookUrls({
                                fileId: fileId,
                                cloudEndpoint: this.plugin.cloudEndpoint,
                                secret: this.plugin.storageSettings.values.privateKey
                            });

                            videoClips.push({
                                id: fileName,
                                startTime: timestamp,
                                duration: 30000,
                                event: 'timelapseClip',
                                description: ADVANCED_NOTIFIER_INTERFACE,
                                thumbnailId: fileId,
                                videoId: fileId,
                                detectionClasses: ['timelapseClip'],
                                resources: {
                                    thumbnail: {
                                        href: videoclipThumbnailUrl
                                    },
                                    video: {
                                        href: videoclipStreamUrl
                                    }
                                }
                            });
                        }
                    }
                }
            }
        }

        let clipsPath: string;

        let hasClips = true;
        try {
            const { generatedPath } = this.plugin.getShortClipPaths({ cameraName: cameraDevice.name });
            await fs.promises.access(generatedPath);
            clipsPath = generatedPath;
        } catch (e) {
            hasClips = false;
        }

        if (hasClips) {
            const files = await fs.promises.readdir(clipsPath);

            try {
                for (const file of files) {
                    const [fileName, extension] = file.split('.');
                    if (extension === 'mp4') {
                        const timestamp = Number(fileName);

                        if (timestamp > options.startTime && timestamp < options.endTime) {
                            const { fileId } = this.plugin.getShortClipPaths({
                                cameraName: cameraDevice.name,
                                fileName,
                            });
                            const { videoclipThumbnailUrl, videoclipStreamUrl } = await getWebHookUrls({
                                fileId: fileId,
                                cloudEndpoint: this.plugin.cloudEndpoint,
                                secret: this.plugin.storageSettings.values.privateKey
                            });

                            videoClips.push({
                                id: fileName,
                                startTime: timestamp,
                                duration: 30,
                                event: 'detectionClip',
                                description: ADVANCED_NOTIFIER_INTERFACE,
                                detectionClasses: ['detectionClip'],
                                thumbnailId: fileId,
                                videoId: fileId,
                                resources: {
                                    thumbnail: {
                                        href: videoclipThumbnailUrl
                                    },
                                    video: {
                                        href: videoclipStreamUrl
                                    }
                                }
                            });
                        }
                    }
                }
            } catch (e) {
                logger.log(`Error fetching videoclips for camera ${cameraDevice.name}`, e);
            }
        }

        return sortBy(videoClips, 'startTime');
    }

    getFilePath(props: { fileId: string }) {
        const { fileId } = props;

        if (fileId.startsWith(TIMELAPSE_CLIP_PREFIX)) {
            const [_, cameraName, ruleName, fileName] = fileId.split('_');
            return this.plugin.getRulePaths({
                cameraName,
                fileName,
                ruleName
            });
        } else if (fileId.startsWith(DETECTION_CLIP_PREFIX)) {
            const [_, cameraName, fileName] = fileId.split('_');
            return this.plugin.getShortClipPaths({
                cameraName,
                fileName,
            });
        }
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();
        const filePathsRes = this.getFilePath({ fileId: videoId });

        let videoclipMo: MediaObject;

        if (filePathsRes) {
            const { videoclipPath } = filePathsRes;
            logger.info('Fetching videoclip ', videoId, videoclipPath);

            const { videoclipStreamUrl } = await getWebHookUrls({
                fileId: videoId,
                cloudEndpoint: this.plugin.cloudEndpoint,
                secret: this.plugin.storageSettings.values.privateKey
            });
            videoclipMo = await sdk.mediaManager.createMediaObject(Buffer.from(videoclipStreamUrl), ScryptedMimeTypes.LocalUrl, {
                sourceId: this.plugin.id
            })
        }

        if (videoclipMo) {
            return videoclipMo;
        } else {
            return this.mixinDevice.getVideoClip(videoId);
        }
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        const filePathsRes = this.getFilePath({ fileId: thumbnailId });

        let thumbnailMo: MediaObject;

        if (filePathsRes) {
            const { snapshotPath } = filePathsRes;

            logger.info('Fetching thumbnail ', thumbnailId, snapshotPath);

            const imageBuf = await fs.promises.readFile(snapshotPath);
            thumbnailMo = await sdk.mediaManager.createMediaObject(imageBuf, 'image/jpeg');
        }

        if (thumbnailMo) {
            return thumbnailMo;
        } else {
            return this.mixinDevice.getVideoClipThumbnail(thumbnailId, options);
        }
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        return this.mixinDevice.removeVideoClips(...videoClipIds);
    }

    ensureMixinsOrder() {
        const logger = this.getLogger();
        const nvrObjectDetector = systemManager.getDeviceById('@scrypted/nvr', 'detection')?.id;
        const basicObjectDetector = systemManager.getDeviceById('@apocaliss92/scrypted-basic-object-detector')?.id;
        const frigateObjectDetector = systemManager.getDeviceById('@apocaliss92/scrypted-frigate-bridge', objectDetectorNativeId)?.id;
        const nvrId = systemManager.getDeviceById('@scrypted/nvr')?.id;
        let shouldBeMoved = false;
        const thisMixinOrder = this.mixins.indexOf(this.plugin.id);

        if (nvrObjectDetector && this.mixins.indexOf(nvrObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }
        if (basicObjectDetector && this.mixins.indexOf(basicObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }
        if (frigateObjectDetector && this.mixins.indexOf(frigateObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }
        if (nvrId && this.mixins.indexOf(nvrId) > thisMixinOrder) {
            shouldBeMoved = true
        }

        if (shouldBeMoved) {
            logger.log('This plugin needs object detection and NVR plugins to come before, fixing');
            setTimeout(() => {
                const currentMixins = this.mixins.filter(mixin => mixin !== this.plugin.id);
                currentMixins.push(this.plugin.id);
                this.cameraDevice.setMixins(currentMixins);
            }, 1000);
        }
    }

    async getMqttClient() {
        if (!this.mqttClient && !this.initializingMqtt) {
            const { mqttEnabled, useMqttPluginCredentials, pluginEnabled, mqttHost, mqttUsename, mqttPassword } = this.plugin.storageSettings.values;
            if (mqttEnabled && pluginEnabled) {
                this.initializingMqtt = true;
                const logger = this.getLogger();

                try {
                    this.mqttClient = await getMqttBasicClient({
                        logger,
                        useMqttPluginCredentials,
                        mqttHost,
                        mqttUsename,
                        mqttPassword,
                        clientId: this.clientId,
                        configTopicPattern: `homeassistant/+/${idPrefix}-${this.id}/+/config`
                    });
                    await this.mqttClient?.getMqttClient();
                } catch (e) {
                    logger.error('Error setting up MQTT client', e);
                } finally {
                    this.initializingMqtt = false;
                }
            }
        }

        return this.mqttClient;
    }

    public async startStop(enabled: boolean) {
        if (enabled) {
            await this.startCheckInterval();
            this.ensureMixinsOrder();
        } else {
            await this.release();
        }
    }

    async toggleRecording(device: Settings, enabled: boolean) {
        await device.putSetting(`recording:privacyMode`, !enabled)
    }

    get decoderType() {
        const { enableDecoder } = this.plugin.storageSettings.values;
        const { decoderType } = this.storageSettings.values;

        if (!enableDecoder) {
            return DecoderType.Off;
        }

        const hasRunningTimelapseRules = !!this.runningTimelapseRules.length;
        const hasRunningOccupancyRules = !!this.runningOccupancyRules.length;

        const hasVideoclipRules = this.runningDetectionRules.some(rule => rule?.generateClip);

        if (decoderType === DecoderType.Always) {
            if (hasRunningOccupancyRules || hasRunningTimelapseRules || hasVideoclipRules) {
                return DecoderType.Always
            } else {
                return DecoderType.OnMotion;
            }
        } else if (hasVideoclipRules) {
            return DecoderType.OnMotion;
        }

        return decoderType;
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            try {
                if (this.storageSettings.values.enabledToMqtt) {
                    await this.getMqttClient();
                }

                const {
                    allAllowedRules,
                    allAvailableRules,
                    allowedAudioRules,
                    allowedDetectionRules,
                    allowedOccupancyRules,
                    allowedTimelapseRules,
                    availableTimelapseRules,
                    shouldListenDetections: shouldListenDetectionsParent,
                    isActiveForMqttReporting,
                    anyAllowedNvrDetectionRule,
                    shouldListenDoorbell: shouldListenDoorbellFromRules,
                    shouldListenAudio,
                    shouldListenAudioSensor,
                } = await getActiveRules({
                    device: this.cameraDevice,
                    console: logger,
                    plugin: this.plugin,
                    deviceStorage: this.storageSettings
                });
                const shouldListenDoorbell = shouldListenDoorbellFromRules || this.cameraDevice.type === ScryptedDeviceType.Doorbell;
                const shouldListenDetections = shouldListenDetectionsParent || this.plugin.storageSettings.values.storeEvents;

                const currentlyRunningRules = [
                    ...this.runningDetectionRules,
                    ...this.runningAudioRules,
                    ...this.runningOccupancyRules,
                    ...this.runningTimelapseRules,
                ];

                const [rulesToEnable, rulesToDisable] = splitRules({
                    allRules: allAvailableRules,
                    currentlyRunningRules: currentlyRunningRules,
                    rulesToActivate: allAllowedRules,
                    device: this.cameraDevice
                });

                const now = Date.now();
                logger.debug(`Detected rules: ${JSON.stringify({
                    rulesToEnable,
                    rulesToDisable,
                    allAvailableRules,
                    currentlyRunningRules,
                    allAllowedRules,
                })}`);

                for (const rule of rulesToEnable) {
                    const { ruleType, name } = rule;
                    logger.log(`${ruleType} rule started: ${name}`);

                    if (!rule.currentlyActive) {
                        if (ruleType === RuleType.Timelapse) {
                            await this.plugin.clearTimelapseFrames({
                                rule,
                                device: this.cameraDevice,
                                logger,
                            });
                        }

                        const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: name, ruleType });
                        await this.putMixinSetting(currentlyActiveKey, 'true');
                    }
                }

                for (const rule of rulesToDisable) {
                    const { ruleType, name } = rule;
                    logger.log(`${ruleType} rule stopped: ${name}`);

                    if (rule.currentlyActive) {
                        if (ruleType === RuleType.Timelapse) {
                            const { timelapse: { lastGeneratedKey } } = getRuleKeys({
                                ruleType,
                                ruleName: rule.name,
                            });
                            const now = Date.now();
                            const lastGeneratedBkp = this.timelapseLastGenerated[rule.name];
                            let lastGenerated = (rule as TimelapseRule).lastGenerated;

                            if (!lastGenerated || lastGeneratedBkp && (lastGeneratedBkp > lastGenerated)) {
                                lastGenerated = lastGeneratedBkp;
                            }
                            const isTimePassed = !lastGenerated || (now - lastGenerated) >= (1000 * 60 * 60 * 1);
                            if (isTimePassed) {
                                await this.storageSettings.putSetting(lastGeneratedKey, now);
                                this.timelapseLastGenerated[rule.name] = now;

                                this.plugin.queueTimelapseGeneration({ rule, device: this.cameraDevice, logger });
                            }
                        }

                        const { common: { currentlyActiveKey } } = getRuleKeys({ ruleName: name, ruleType });
                        await this.putMixinSetting(currentlyActiveKey, 'false');
                    }
                }

                this.runningDetectionRules = cloneDeep(allowedDetectionRules || []);
                this.runningOccupancyRules = cloneDeep(allowedOccupancyRules || []);
                this.runningTimelapseRules = cloneDeep(allowedTimelapseRules || []);
                this.runningAudioRules = cloneDeep(allowedAudioRules || []);
                this.availableTimelapseRules = cloneDeep(availableTimelapseRules || []);
                this.allAvailableRules = cloneDeep(allAvailableRules || []);

                this.isActiveForMqttReporting = isActiveForMqttReporting;

                const isDetectionListenerRunning = !!this.detectionListener || !!this.motionListener;

                const { checkOccupancy, notificationsEnabled } = this.storageSettings.values;
                const decoderType = this.decoderType;

                if (decoderType !== DecoderType.Off) {
                    const { videoclipsRetention } = this.plugin.storageSettings.values;
                    const framesThreshold = now - (1000 * 60 * 5);
                    const videoclipsThreshold = now - (1000 * 60 * 60 * 24 * videoclipsRetention);
                    if (!this.lastFramesCleanup || this.lastFramesCleanup < framesThreshold) {
                        this.lastFramesCleanup = now;
                        this.plugin.clearVideoclipsData({
                            device: this.cameraDevice,
                            logger,
                            framesThreshold,
                            videoclipsThreshold,
                        }).catch(logger.log);
                    }
                }

                if (isActiveForMqttReporting) {
                    const mqttClient = await this.getMqttClient();
                    if (mqttClient) {
                        // Every 60 minutes repeat the autodiscovery
                        if (!this.lastAutoDiscovery || (now - this.lastAutoDiscovery) > 1000 * 60 * 60) {
                            this.lastAutoDiscovery = now;

                            logger.log('Starting MQTT autodiscovery');
                            setupCameraAutodiscovery({
                                mqttClient,
                                device: this.cameraDevice,
                                console: logger,
                                rules: allAvailableRules,
                                occupancyEnabled: checkOccupancy,
                            }).then(async (activeTopics) => {
                                await this.mqttClient.cleanupAutodiscoveryTopics(activeTopics);
                            }).catch(logger.error);

                            logger.debug(`Subscribing to mqtt topics`);
                            subscribeToCameraMqttTopics({
                                mqttClient,
                                rules: allAvailableRules,
                                device: this.cameraDevice,
                                console: logger,
                                activationRuleCb: async ({ active, ruleName, ruleType }) => {
                                    const { common: { enabledKey } } = getRuleKeys({ ruleName, ruleType });
                                    logger.log(`Setting ${ruleType} rule ${ruleName} to ${active}`);
                                    await this.storageSettings.putSetting(`${enabledKey}`, active);
                                },
                                switchNotificationsEnabledCb: async (active) => {
                                    logger.log(`Setting notifications active to ${active}`);
                                    await this.storageSettings.putSetting(`notificationsEnabled`, active);
                                },
                                switchOccupancyCheckCb: async (active) => {
                                    logger.log(`Setting occupancy check to ${active}`);
                                    await this.storageSettings.putSetting(`checkOccupancy`, active);
                                },
                                switchRecordingCb: this.cameraDevice.interfaces.includes(ScryptedInterface.VideoRecorder) ?
                                    async (active) => {
                                        logger.log(`Setting NVR privacy mode to ${!active}`);
                                        await this.toggleRecording(this.cameraDevice, active);
                                    } :
                                    undefined,
                                rebootCb: this.cameraDevice.interfaces.includes(ScryptedInterface.Reboot) ?
                                    async () => {
                                        logger.log(`Rebooting camera`);
                                        await this.cameraDevice.reboot();
                                    } :
                                    undefined,
                                ptzCommandCb: this.cameraDevice.interfaces.includes(ScryptedInterface.PanTiltZoom) ?
                                    (async (ptzCommand: PanTiltZoomCommand) => {
                                        logger.log(`Executing ptz command: ${JSON.stringify(ptzCommand)}`);

                                        if (ptzCommand.preset) {
                                            const presetId = Object.entries(this.cameraDevice.ptzCapabilities?.presets ?? {}).find(([id, name]) => name === ptzCommand.preset)?.[0];
                                            if (presetId) {
                                                await this.cameraDevice.ptzCommand({ preset: presetId });
                                            }
                                        } else {
                                            await this.cameraDevice.ptzCommand(ptzCommand);
                                        }
                                    }) :
                                    undefined
                            }).catch(logger.error);

                            this.refreshSettings().catch(logger.error);
                        }

                        const settings = await this.mixinDevice.getSettings();
                        const isRecording = !settings.find(setting => setting.key === 'recording:privacyMode')?.value;

                        if (this.plugin.storageSettings.values.mqttEnabled) {
                            publishCameraValues({
                                console: logger,
                                device: this.cameraDevice,
                                mqttClient,
                                notificationsEnabled,
                                isRecording,
                                rulesToEnable,
                                rulesToDisable,
                                checkOccupancy
                            }).catch(logger.error);
                        }
                    }
                }

                if (isDetectionListenerRunning && !shouldListenDetections) {
                    logger.log('Stopping and cleaning Object listeners.');
                    this.resetListeners();
                } else if (!isDetectionListenerRunning && shouldListenDetections) {
                    logger.log(`Starting detection listeners: ${JSON.stringify({
                        Detections: shouldListenDetections,
                        MQTT: isActiveForMqttReporting,
                        Doorbell: shouldListenDoorbell,
                        NotificationRules: allAllowedRules.length ? allAllowedRules.map(rule => rule.name).join(', ') : 'None',
                    })}`);
                    await this.startObjectDetectionListeners();
                }

                if (shouldListenDoorbell && !this.isActiveForDoorbelDetections) {
                    logger.log(`Starting Doorbell listener`);
                    await this.startDoorbellListener();
                } else if (!shouldListenDoorbell && this.isActiveForDoorbelDetections) {
                    logger.log(`Stopping Doorbell listener`);
                    await this.stopDoorbellListener();
                }
                this.isActiveForDoorbelDetections = shouldListenDoorbell;

                if (shouldListenAudio && !this.isActiveForAudioVolumesDetections) {
                    logger.log(`Starting Audio volumes listener`);
                    await this.startAudioVolumesListener();
                } else if (!shouldListenAudio && this.isActiveForAudioVolumesDetections) {
                    logger.log(`Stopping Audio volumes listener`);
                    await this.stopAudioVolumesListener();
                }
                this.isActiveForAudioVolumesDetections = shouldListenAudio;

                if (shouldListenAudioSensor && !this.isActiveForAudioSensorDetections) {
                    logger.log(`Starting Audio sensor listener`);
                    await this.startAudioSensorListener();
                } else if (!shouldListenAudioSensor && this.isActiveForAudioSensorDetections) {
                    logger.log(`Stopping Audio sensor listener`);
                    await this.stopAudioSensorListener();
                }
                this.isActiveForAudioSensorDetections = shouldListenAudioSensor;

                if (anyAllowedNvrDetectionRule && !this.isActiveForNvrNotifications) {
                    logger.log(`Starting NVR events listener`);
                } else if (!anyAllowedNvrDetectionRule && this.isActiveForNvrNotifications) {
                    logger.log(`Stopping NVR events listener`);
                }
                this.isActiveForNvrNotifications = anyAllowedNvrDetectionRule;

                if (decoderType === DecoderType.Always && this.framesGeneratorSignal.finished) {
                    await this.startDecoder('Permanent');
                } else if (decoderType === DecoderType.Off && !this.framesGeneratorSignal.finished) {
                    this.stopDecoder('EndClipRules');
                }
                // Restart decoder every 60 seconds
                if (
                    decoderType === DecoderType.Always &&
                    this.frameGenerationStartTime &&
                    (now - this.frameGenerationStartTime) >= 1000 * 60
                ) {
                    logger.log(`Restarting decoder`);
                    this.stopDecoder('Restart');
                }

                if (!this.processDetectionsInterval) {
                    logger.log('Starting processing of accumulated detections');
                    this.startAccumulatedDetectionsInterval();
                }

                await this.checkOutdatedRules();
            } catch (e) {
                logger.log('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    await funct();
                }
            } catch (e) {
                logger.log('Error in mainLoopListener', e);
            }
        }, 1000 * 2);
    }

    async initDecoderStream() {
        if (this.decoderStream) {
            return;
        }

        const logger = this.getLogger();

        const streams = await this.cameraDevice.getVideoStreamOptions();
        let closestStream: ResponseMediaStreamOptions;
        for (const stream of streams) {
            logger.info(`Stream ${stream.name} ${JSON.stringify(stream.video)} ${stream.destinations}`);
            const streamWidth = stream.video?.width;

            if (streamWidth) {
                const diff = SNAPSHOT_WIDTH - streamWidth;
                if (!closestStream || diff < Math.abs((SNAPSHOT_WIDTH - closestStream.video.width))) {
                    closestStream = stream;
                }
            }
        }

        if (closestStream?.destinations?.[0]) {
            this.decoderStream = closestStream.destinations[0];
            this.decoderResize = ((closestStream.video.width ?? 0) - SNAPSHOT_WIDTH) > 200;
            const streamName = closestStream?.name;
            const deviceSettings = await this.cameraDevice.getSettings();
            const rebroadcastConfig = deviceSettings.find(setting => setting.subgroup === `Stream: ${streamName}` && setting.title === 'RTSP Rebroadcast Url');
            this.rtspUrl = rebroadcastConfig?.value as string;
            logger.log(`Stream found ${this.decoderStream} (${this.rtspUrl}), requires resize ${this.decoderResize}`);
            logger.info(`${JSON.stringify(closestStream)}`);
        } else {
            logger.log(`Stream not found, falling back to remote-recorder`);
            this.decoderStream = 'remote-recorder';
            this.decoderResize = false;
        }
    }

    async initDb() {
        const { dbPath } = this.plugin.getEventPaths({ cameraName: this.cameraDevice.name });
        const logger = this.getLogger();
        const db = new JsonDB(new Config(dbPath, true, true, '/'));
        try {
            await db.getData('/events');
        } catch (e) {
            logger.log(`Initializing table events`);
        }
    }

    async startDecoder(reason: 'Permanent' | 'StartMotion') {
        await this.initDecoderStream();

        const logger = this.getLogger();

        if (!this.framesGeneratorSignal || this.framesGeneratorSignal.finished) {
            logger.log(`Starting decoder (${reason})`);
            this.frameGenerationStartTime = Date.now();
            this.framesGeneratorSignal = new Deferred();

            const exec = async (frame: VideoFrame) => {
                const now = Date.now();

                this.lastFrame = await frame.image.toBuffer({
                    format: 'jpg',
                });
                // const jpeg = await frame.image.toBuffer({
                //     format: 'jpg',
                // });
                // this.lastFrame = await sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
                // this.lastFrame = await frame.image.toImage({
                //     format: 'jpg',
                // })
                this.lastFrameAcquired = now;

                const decoderType = this.decoderType;
                if (decoderType !== DecoderType.Off && this.isDelayPassed({
                    type: DelayType.DecoderFrameOnStorage,
                    eventSource: ScryptedEventSource.RawDetection,
                    timestamp: frame.timestamp
                })?.timePassed) {
                    this.plugin.storeDetectionFrame({
                        device: this.cameraDevice,
                        imageBuffer: this.lastFrame,
                        timestamp: frame.timestamp
                    }).catch(logger.log);
                }
            }

            try {
                for await (const frame of
                    await sdk.connectRPCObject(
                        await this.createFrameGenerator())) {
                    if (this.framesGeneratorSignal.finished) {
                        break;
                    }
                    await exec(frame);
                }
            } catch (e) {
                try {
                    for await (const frame of
                        await sdk.connectRPCObject(
                            await this.createFrameGenerator(true))) {
                        if (this.framesGeneratorSignal.finished) {
                            break;
                        }
                        await exec(frame);
                    }
                } catch (e) {
                    logger.log('Decoder starting failed', e);
                }
            }
        } else {
            logger.info('Streams generator not yet released');
        }
    }

    stopDecoder(reason: 'Restart' | 'EndMotion' | 'EndClipRules' | 'Release') {
        const logger = this.getLogger();
        if (!this.framesGeneratorSignal?.finished) {
            logger.log(`Stopping decoder (${reason})`);
            this.frameGenerationStartTime = undefined;
            this.framesGeneratorSignal.resolve();
        }
    }

    startAccumulatedDetectionsInterval() {
        const logger = this.getLogger();
        this.processDetectionsInterval = setInterval(async () => {
            try {
                if (!this.killed && !this.processingAccumulatedDetections) {
                    try {
                        this.processingAccumulatedDetections = true;
                        await this.processAccumulatedDetections();
                    } catch (e) {
                        logger.log(`Error in startAccumulatedDetectionsInterval`, e);
                    } finally {
                        this.processingAccumulatedDetections = false;
                    }
                }
            } catch (e) {
                logger.log('Error in processDetectionsInterval', e);
            }
        }, 500);
    }

    resetAudioRule(ruleName: string) {
        this.audioRuleSamples[ruleName] = [];
    }

    stopAccumulatedDetectionsInterval() {
        this.processDetectionsInterval && clearInterval(this.processDetectionsInterval);
        this.processDetectionsInterval = undefined;
    }

    async stopDoorbellListener() {
        this.binaryListener?.removeListener && this.binaryListener.removeListener();
        this.binaryListener = undefined;
    }

    async stopAudioVolumesListener() {
        this.audioVolumesListener?.removeListener && this.audioVolumesListener.removeListener();
        this.audioVolumesListener = undefined;
    }

    async stopAudioSensorListener() {
        this.audioSensorListener?.removeListener && this.audioSensorListener.removeListener();
        this.audioSensorListener = undefined;
    }

    resetListeners() {
        if (this.detectionListener || this.motionListener || this.binaryListener || this.audioVolumesListener) {
            this.getLogger().log('Resetting listeners.');
        }

        this.detectionListener?.removeListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
        this.motionListener?.removeListener && this.motionListener.removeListener();
        this.motionListener = undefined;
        this.stopDoorbellListener();
        this.stopAudioVolumesListener();
        this.resetMqttMotionTimeout();

        Object.keys(this.detectionRuleListeners).forEach(ruleName => {
            const { disableNvrRecordingTimeout, turnOffTimeout } = this.detectionRuleListeners[ruleName];
            disableNvrRecordingTimeout && clearTimeout(disableNvrRecordingTimeout);
            turnOffTimeout && clearTimeout(turnOffTimeout);
        })
    }

    async initValues() {
        const logger = this.getLogger();
        try {
            if (this.plugin.hasCloudPlugin) {
                const { lastSnapshotCloudUrl, lastSnapshotLocalUrl } = await getWebHookUrls({
                    cameraIdOrAction: this.id,
                    console: logger,
                    device: this.cameraDevice,
                    cloudEndpoint: this.plugin.cloudEndpoint,
                    secret: this.plugin.storageSettings.values.privateKey
                });

                await this.storageSettings.putSetting('lastSnapshotWebhookCloudUrl', lastSnapshotCloudUrl);
                await this.storageSettings.putSetting('lastSnapshotWebhookLocalUrl', lastSnapshotLocalUrl);
            }
        } catch { };

        await this.refreshSettings();
        await this.refreshSettings();
    }

    snoozeNotification(props: {
        snoozeId: string;
        snoozeTime: number;
    }) {
        const { snoozeId, snoozeTime } = props;
        const logger = this.getLogger();

        const res = `Snoozing ${snoozeId} for ${snoozeTime} minutes`;
        logger.log(res);

        const snoozedUntil = moment().add(snoozeTime, 'minutes').toDate().getTime();
        this.snoozeUntilDic[snoozeId] = snoozedUntil;

        return res;
    }

    async toggleRule(ruleName: string, ruleType: RuleType, enabled: boolean) {
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();

        if (!mqttClient) {
            return;
        }

        const rule = this.allAvailableRules.find(rule => rule.ruleType === ruleType && rule.name === ruleName);

        logger.log(`Setting ${ruleType} rule ${ruleName} enabled to ${enabled}`);

        if (rule) {
            await publishRuleEnabled({
                console: logger,
                rule,
                device: this.cameraDevice,
                enabled,
                mqttClient
            });
        }
    };

    async refreshSettings() {
        const logger = this.getLogger();
        const dynamicSettings: StorageSetting[] = [];
        const zones = (await this.getObserveZones()).map(item => item.name);
        const people = (await this.plugin.getKnownPeople());
        const { frigateLabels, frigateZones } = (await this.getFrigateData());

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            zones,
            frigateZones,
            people,
            device: this,
            logger,
            frigateLabels,
            ruleSource: RuleSource.Device,
            refreshSettings: this.refreshSettings.bind(this),
        });
        dynamicSettings.push(...detectionRulesSettings);

        const occupancyRulesSettings = await getOccupancyRulesSettings({
            storage: this.storageSettings,
            zones,
            ruleSource: RuleSource.Device,
            logger,
            refreshSettings: this.refreshSettings.bind(this),
            onManualCheck: async (ruleName: string) => await this.manualCheckOccupancyRule(ruleName),
            device: this,
        });
        dynamicSettings.push(...occupancyRulesSettings);

        const timelapseRulesSettings = await getTimelapseRulesSettings({
            storage: this.storageSettings,
            ruleSource: RuleSource.Device,
            logger,
            device: this,
            refreshSettings: this.refreshSettings.bind(this),
            onCleanDataTimelapse: async (ruleName) => {
                const rule = this.availableTimelapseRules?.find(rule => rule.name === ruleName);

                if (rule) {
                    this.plugin.clearTimelapseFrames({
                        rule,
                        device: this.cameraDevice,
                        logger,
                    }).catch(logger.log);
                }
            },
            onGenerateTimelapse: async (ruleName) => {
                const logger = this.getLogger();
                const rule = this.availableTimelapseRules?.find(rule => rule.name === ruleName);

                if (rule) {
                    this.plugin.queueTimelapseGeneration({ rule, device: this.cameraDevice, logger });
                }
            },
        });
        dynamicSettings.push(...timelapseRulesSettings);

        if (this.cameraDevice.interfaces.includes(ScryptedInterface.AudioVolumeControl)) {
            const audioRulesSettings = await getAudioRulesSettings({
                storage: this.storageSettings,
                ruleSource: RuleSource.Device,
                logger,
                device: this,
                refreshSettings: this.refreshSettings.bind(this),
            });
            dynamicSettings.push(...audioRulesSettings);
        }

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });

        const {
            lastSnapshotWebhook,
            postDetectionImageWebhook,
            enabledToMqtt,
            schedulerEnabled,
            useDecoder,
        } = this.storageSettings.values;

        if (this.storageSettings.settings.lastSnapshotWebhookCloudUrl) {
            this.storageSettings.settings.lastSnapshotWebhookCloudUrl.hide = !lastSnapshotWebhook;
        }
        if (this.storageSettings.settings.lastSnapshotWebhookLocalUrl) {
            this.storageSettings.settings.lastSnapshotWebhookLocalUrl.hide = !lastSnapshotWebhook;
        }

        if (this.storageSettings.settings.postDetectionImageUrls) {
            this.storageSettings.settings.postDetectionImageUrls.hide = !postDetectionImageWebhook;
        }
        if (this.storageSettings.settings.postDetectionImageClasses) {
            this.storageSettings.settings.postDetectionImageClasses.hide = !postDetectionImageWebhook;
        }
        if (this.storageSettings.settings.postDetectionImageMinDelay) {
            this.storageSettings.settings.postDetectionImageMinDelay.hide = !postDetectionImageWebhook;
        }

        if (this.storageSettings.settings.minMqttPublishDelay) {
            this.storageSettings.settings.minMqttPublishDelay.hide = !enabledToMqtt;
        }
        if (this.storageSettings.settings.checkOccupancy) {
            this.storageSettings.settings.checkOccupancy.hide = !enabledToMqtt;
        }

        if (this.storageSettings.settings.startTime) {
            this.storageSettings.settings.startTime.hide = !schedulerEnabled;
        }
        if (this.storageSettings.settings.endTime) {
            this.storageSettings.settings.endTime.hide = !schedulerEnabled;
        }

        if (this.storageSettings.settings.decoderType) {
            this.storageSettings.settings.decoderType.defaultValue = useDecoder ? DecoderType.OnMotion : DecoderType.Off;
        }
        this.storageSettings.settings.useDecoder.hide = true;

        if (this.storageSettings.settings.detectionSourceForMqtt) {
            this.storageSettings.settings.detectionSourceForMqtt.choices = [
                'Default',
                ...this.plugin.enabledDetectionSources,
            ]
        }
    }

    async getObserveZones() {
        try {
            const now = new Date().getTime();
            const isUpdated = this.lastObserveZonesFetched && (now - this.lastObserveZonesFetched) <= (1000 * 60);
            if (this.observeZoneData && isUpdated) {
                return this.observeZoneData;
            }

            const res: ObserveZoneData[] = [];
            const settings = await this.mixinDevice.getSettings();
            const zonesSetting = settings.find((setting: { key: string; }) => new RegExp('objectdetectionplugin:.*:zones').test(setting.key))?.value ?? [];

            const zoneNames = zonesSetting?.filter(zone => {
                return settings.find((setting: { key: string; }) => new RegExp(`objectdetectionplugin:.*:zoneinfo-filterMode-${zone}`).test(setting.key))?.value === 'observe';
            });

            zoneNames.forEach(zoneName => {
                const zonePath = JSON.parse(settings.find((setting) => setting.subgroup === `Zone: ${zoneName}` && setting.type === 'clippath')?.value ?? '[]');

                res.push({
                    name: zoneName,
                    path: zonePath
                })
            });

            this.observeZoneData = res;
            this.lastObserveZonesFetched = now;
            return this.observeZoneData;
        } catch (e) {
            this.getLogger().log('Error in getObserveZones', e);
            return [];
        }
    }

    async getFrigateData() {
        try {
            const logger = this.getLogger();
            const now = new Date().getTime();
            const frigateObjectDetector = systemManager.getDeviceById('@apocaliss92/scrypted-frigate-bridge', objectDetectorNativeId)?.id;

            if (!this.cameraDevice.mixins.includes(frigateObjectDetector)) {
                return {};
            }

            let labels: string[];
            let zones: string[] = [];
            let cameraName: string;
            const isUpdated = this.lastFrigateDataFetched && (now - this.lastFrigateDataFetched) <= (1000 * 60);

            if (this.frigateLabels && isUpdated) {
                labels = this.frigateLabels;
            } else {
                const settings = await this.mixinDevice.getSettings();
                const labelsResponse = (settings.find((setting: { key: string; }) => setting.key === 'frigateObjectDetector:labels')?.value ?? []) as string[];
                labels = labelsResponse.filter(label => label !== 'person');
                this.frigateLabels = labels;
            }

            if (this.frigateZones && this.frigateCameraName && isUpdated) {
                zones = this.frigateZones;
                cameraName = this.frigateCameraName;
            } else {
                const settings = await this.mixinDevice.getSettings();
                cameraName = settings.find((setting: { key: string; }) => setting.key === 'frigateObjectDetector:cameraName')?.value as string;
                if (!cameraName) {
                    logger.log(`Camera name not set on the frigate object detector settings of this camera`);
                } else {
                    const response = await axios.get<any>(`${this.plugin.frigateApi}/config`);
                    const zonesData = response.data?.cameras?.[cameraName]?.zones ?? {};
                    zones = Object.keys(zonesData);
                    this.frigateZones = zones;
                }
            }

            this.lastFrigateDataFetched = now;

            return { frigateLabels: labels, frigateZones: zones, cameraName };
        } catch (e) {
            this.getLogger().log('Error in getFrigateData', e.message);
            return {};
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
            return this.storageSettings.getSettings();
        } catch (e) {
            this.getLogger().log('Error in getMixinSettings', e);
            return [];
        }
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const [group, ...rest] = key.split(':');
        if (group === this.settingsGroupKey) {
            this.storageSettings.putSetting(rest.join(':'), value);
        } else {
            super.putSetting(key, value);
        }
    }

    async putMixinSetting(key: string, value: string) {
        this.storageSettings.putSetting(key, value);
    }

    async release() {
        const logger = this.getLogger();
        logger.info('Releasing mixin');
        this.killed = true;
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;

        this.mqttClient && this.mqttClient.disconnect();
        this.resetListeners();
        this.stopDecoder('Release');
    }

    public getLogger(forceNew?: boolean) {
        if (!this.logger || forceNew) {
            const newLogger = this.plugin.getLoggerInternal({
                console: this.console,
                storage: this.storageSettings,
                friendlyName: this.clientId
            });

            if (forceNew) {
                return newLogger;
            } else {
                this.logger = newLogger;
            }
        }

        return this.logger;
    }

    async triggerRule(props: {
        matchRule: MatchRule,
        eventSource: ScryptedEventSource,
        device: DeviceInterface,
        b64Image?: string,
        triggerTime: number,
        skipMqttImage?: boolean,
        skipTrigger?: boolean,
    }) {
        const logger = this.getLogger();

        try {
            const { matchRule, eventSource, b64Image, device, triggerTime, skipMqttImage, skipTrigger } = props;
            const { rule, match } = matchRule;

            const { timePassed } = !skipMqttImage && this.isDelayPassed({
                type: DelayType.RuleImageUpdate,
                matchRule,
                eventSource
            });

            if (this.isActiveForMqttReporting && timePassed) {
                const mqttClient = await this.getMqttClient();
                if (mqttClient) {
                    try {
                        publishRuleData({
                            mqttClient,
                            device,
                            triggerValue: !skipTrigger ? true : undefined,
                            console: logger,
                            b64Image,
                            rule,
                            triggerTime,
                            skipMqttImage,
                        }).catch(logger.error);
                    } catch (e) {
                        logger.log(`Error in publishRuleData`, e);
                    }
                }
            }

            this.storeImagesOnFs({
                b64Image,
                detections: match ? [match] : undefined,
                device: this.cameraDevice,
                triggerTime,
                prefix: `rule-${rule.name}`,
                eventSource,
            }).catch(logger.log);

            if (rule.ruleType === RuleType.Detection && !skipTrigger) {
                const { disableNvrRecordingSeconds, name } = rule as DetectionRule;
                if (disableNvrRecordingSeconds !== undefined) {
                    const seconds = Number(disableNvrRecordingSeconds);

                    logger.log(`Enabling NVR recordings for ${seconds} seconds from rule ${rule.name}`);
                    await this.toggleRecording(device, true);

                    if (!this.detectionRuleListeners[name]) {
                        this.detectionRuleListeners[name] = {};
                    }

                    const { disableNvrRecordingTimeout } = this.detectionRuleListeners[name];

                    if (disableNvrRecordingTimeout) {
                        clearTimeout(disableNvrRecordingTimeout);
                        this.detectionRuleListeners[name].disableNvrRecordingTimeout = undefined;
                    }

                    this.detectionRuleListeners[name].disableNvrRecordingTimeout = setTimeout(async () => {
                        logger.log(`Disabling NVR recordings from rule ${rule.name}`);
                        await this.toggleRecording(device, false);
                    }, seconds * 1000);
                }

                this.resetRuleEntities(rule).catch(logger.log);
            }

        } catch (e) {
            logger.log('error in triggerRule', e);
        }
    }

    public async getImage(props?: {
        detectionId?: string,
        eventId?: string,
        image?: MediaObject,
        reason: GetImageReason
    }) {
        const { reason, detectionId, eventId, image: imageParent } = props ?? {};
        const logger = this.getLogger();
        const now = Date.now();
        const { minSnapshotDelay } = this.storageSettings.values;
        logger.info(`Getting image for reason ${reason}, ${detectionId} ${eventId}`);

        let image: MediaObject = imageParent;
        let b64Image: string;
        let imageUrl: string;
        let imageSource: ImageSource;

        const msPassedFromSnapshot = this.lastPictureTaken !== undefined ? now - this.lastPictureTaken : 0;
        const msPassedFromDecoder = this.lastFrameAcquired !== undefined ? now - this.lastFrameAcquired : 0;

        const forceLatest = [
            GetImageReason.MotionUpdate,
            GetImageReason.FromFrigate,
        ].includes(reason);
        const preferLatest = [
            GetImageReason.RulesRefresh,
            GetImageReason.AudioTrigger,
        ].includes(reason);
        const forceSnapshot = [
            GetImageReason.Sensor,
            GetImageReason.Notification,
        ].includes(reason);
        const tryDetector = !!detectionId && !!eventId;
        const snapshotTimeout =
            reason === GetImageReason.RulesRefresh ? 10000 : this.currentSnapshotTimeout;
        const decoderRunning = !this.framesGeneratorSignal.finished;
        const forceDecoder = reason === GetImageReason.RulesRefresh;

        let logPayload: any = {
            decoderRunning,
            msPassedFromDecoder,
            msPassedFromSnapshot,
            reason,
            preferLatest,
            forceLatest,
            forceSnapshot,
            tryDetector,
            snapshotTimeout,
            forceDecoder,
        };

        const findFromDetector = () => async () => {
            try {
                const detectImage = await this.cameraDevice.getDetectionInput(detectionId, eventId);
                const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(detectImage, ScryptedMimeTypes.Image);
                image = await convertedImage.toImage({
                    resize: {
                        width: SNAPSHOT_WIDTH,
                    },
                });
                imageSource = ImageSource.Detector;
            } catch (e) {
                logger.log(`Error finding the ${reason} image from the detector (${e.message})`);
            }
        }

        const findFromSnapshot = (force: boolean, timeout: number) => async () => {
            const timePassed = !this.lastPictureTaken || msPassedFromSnapshot >= 1000 * minSnapshotDelay;

            if (timePassed || force) {
                try {
                    image = await this.cameraDevice.takePicture({
                        reason: 'event',
                        timeout,
                        picture: {
                            width: SNAPSHOT_WIDTH,
                        },
                    });
                    this.lastPictureTaken = now;
                    imageSource = ImageSource.Snapshot;
                    this.currentSnapshotTimeout = 4000;
                } catch (e) {
                    logger.log(`Error taking a snapshot for reason ${reason} (timeout ${snapshotTimeout} ms): (${e.message})`);
                    this.lastPictureTaken = undefined;
                    if (this.currentSnapshotTimeout < (1000 * minSnapshotDelay)) {
                        logger.log(`Increasing timeout to ${this.currentSnapshotTimeout + 1000}`);
                        this.currentSnapshotTimeout += 1000;
                    }
                }
            } else {
                logger.info(`Skipping snapshot image`, JSON.stringify({
                    timePassed, force
                }));
            }
        }

        const findFromDecoder = () => async () => {
            const isRecent = this.lastFrameAcquired && (msPassedFromDecoder) <= 500;

            if (this.lastFrame && (forceDecoder || (decoderRunning && isRecent))) {
                const mo = await sdk.mediaManager.createMediaObject(this.lastFrame, 'image/jpeg');
                if (this.decoderResize) {
                    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(mo, ScryptedMimeTypes.Image);
                    image = await convertedImage.toImage({
                        resize: {
                            width: SNAPSHOT_WIDTH,
                        },
                    });
                } else {
                    image = mo;
                }

                imageSource = ImageSource.Decoder;
            } else {
                logger.info(`Skipping decoder image`, JSON.stringify({
                    isRecent, decoderRunning, hasFrame: !!this.lastFrame, msPassedFromDecoder
                }));
            }
        };

        const findFromLatest = (ms: number) => async () => {
            const isRecent = msPassedFromSnapshot && msPassedFromSnapshot <= ms;

            if (isRecent) {
                image = this.lastImage;
                b64Image = this.lastB64Image;
                imageSource = ImageSource.Latest;
            } else {
                logger.info(`Skipping latest image`, JSON.stringify({
                    isRecent,
                    ms
                }));
            }
        };

        try {
            if (!image) {
                let runners = [];
                const checkLatest = findFromLatest(forceLatest ? 5000 : 2000);
                const checkVeryRecent = findFromLatest(200);
                const checkSnapshot = findFromSnapshot(forceSnapshot, snapshotTimeout);
                const checkDetector = findFromDetector();
                const checkDecoder = findFromDecoder();

                if (this.cameraDevice.sleeping) {
                    logger.info(`Not waking up the camera for a snapshot`);
                    runners = [
                        checkDetector,
                        checkVeryRecent,
                        checkLatest
                    ];
                } else if (reason === GetImageReason.FromFrigate) {
                    runners = [
                        checkDetector,
                        checkDecoder,
                        checkVeryRecent,
                        checkLatest,
                        checkSnapshot
                    ];
                } else if (reason === GetImageReason.AccumulatedDetections) {
                    runners = [
                        checkDecoder,
                        checkDetector,
                        checkSnapshot
                    ];
                } else if (forceLatest) {
                    runners = [
                        checkDecoder,
                        checkVeryRecent,
                        checkLatest,
                    ];
                } else if (preferLatest) {
                    runners = [
                        checkDecoder,
                        checkVeryRecent,
                        checkLatest,
                        checkSnapshot,
                    ];
                } else if (tryDetector) {
                    runners = [
                        checkDetector,
                        checkDecoder,
                        checkVeryRecent,
                        checkSnapshot,
                    ];
                } else {
                    runners = [
                        checkDecoder,
                        checkVeryRecent,
                        checkSnapshot,
                    ];
                }

                for (const runner of runners) {
                    await runner();
                    if (image) {
                        break;
                    }
                }
            } else {
                imageSource = ImageSource.Input;
            }

            if (image) {
                b64Image = await moToB64(image);
            } else {
                imageSource = ImageSource.NotFound;
            }
        } catch (e) {
            logger.log(`Error during getImage`, e);
        } finally {
            logPayload = {
                ...logPayload,
                imageSource,
                imageFound: !!image
            };
            logger.info(`Image found from ${imageSource} for reason ${reason} lastSnapshotMs ${msPassedFromSnapshot} lastDecoderMs ${msPassedFromDecoder}`);
            logger.info(logPayload);
            if (!imageParent && image && b64Image) {
                this.lastImage = image;
                this.lastB64Image = b64Image;
            }

            return { image, b64Image, imageUrl, imageSource };
        }
    }

    async checkOutdatedRules() {
        if (this.checkingOutatedRules) {
            return;
        }

        this.checkingOutatedRules = true;
        const now = new Date().getTime();
        const logger = this.getLogger();

        try {
            const anyOutdatedOccupancyRule = this.runningOccupancyRules.some(rule => {
                const { forceUpdate, name } = rule;
                const currentState = this.occupancyState[name];
                const shouldForceFrame = !currentState ||
                    (now - (currentState?.lastCheck ?? 0)) >= (1000 * forceUpdate) ||
                    (currentState.occupancyToConfirm != undefined && !!currentState.confirmationStart);

                const isMotionOk = this.cameraDevice.motionDetected ||
                    !this.lastMotionEnd ||
                    (now - this.lastMotionEnd) > 1000 * 10;

                if (!this.occupancyState[name]) {
                    const initState: CurrentOccupancyState = getInitOccupancyState(rule);
                    logger.log(`Initializing occupancy data for rule ${name} to ${JSON.stringify(initState)}`);
                    this.occupancyState[name] = initState;
                }

                logger.info(`Should force occupancy data update: ${JSON.stringify({
                    shouldForceFrame,
                    isMotionOk,
                    lastCheck: currentState?.lastCheck,
                    forceUpdate,
                    now,
                    name
                })}`);

                return shouldForceFrame && isMotionOk;
            }) || this.storageSettings.values.checkOccupancy;

            const timelapsesToRefresh = (this.runningTimelapseRules || []).filter(rule => {
                const { regularSnapshotInterval, name } = rule;
                const lastCheck = this.timelapseLastCheck[name];
                const shouldForceFrame = !lastCheck || (now - (lastCheck ?? 0)) >= (1000 * regularSnapshotInterval);

                logger.info(`Should force timelapse frame: ${JSON.stringify({
                    shouldForceFrame,
                    lastCheck,
                    regularSnapshotInterval,
                    now,
                    name
                })}`);

                return shouldForceFrame;
            });

            const anyTimelapseToRefresh = !!timelapsesToRefresh.length;

            if (anyOutdatedOccupancyRule || anyTimelapseToRefresh) {
                const { image, b64Image, imageSource } = await this.getImage({ reason: GetImageReason.RulesRefresh });
                if (image && b64Image) {
                    if (anyOutdatedOccupancyRule) {
                        this.checkOccupancyData({ image, b64Image, source: 'MainFlow' }).catch(logger.log);
                    }

                    if (anyTimelapseToRefresh) {
                        for (const rule of uniqBy(timelapsesToRefresh, rule => rule.name)) {
                            logger.log(`Adding regular frame from ${imageSource} to the timelapse rule ${rule.name}`);
                            this.plugin.storeTimelapseFrame({
                                imageMo: image,
                                timestamp: now,
                                device: this.cameraDevice,
                                rule: rule as TimelapseRule
                            }).catch(logger.log);

                            this.timelapseLastCheck[rule.name] = now;
                        }
                    }
                }
            }
        } catch (e) {
            logger.log(`Error during checkOutdatedRules`, e);
        } finally {
            this.checkingOutatedRules = false;
        }
    }

    async manualCheckOccupancyRule(ruleName: string) {
        const logger = this.getLogger();
        const rule = this.runningOccupancyRules.find(rule => rule.name === ruleName);

        logger.log(`Starting AI check for occupancy rule ${ruleName}`);

        const { image } = await this.getImage({
            reason: GetImageReason.Sensor,
        });

        const zonesData = await this.getObserveZones();
        const zone = zonesData.find(zoneData => zoneData.name === rule.observeZone);

        const { newB64Image, newImage } = await addZoneClipPathToImage({
            image,
            clipPath: zone.path
        });
        const occupiesFromAi = await checkObjectsOccupancy({
            b64Image: newB64Image,
            logger,
            plugin: this.plugin,
            detectionClass: rule.detectionClass
        });

        const detectedObjectsFromAi = Number(occupiesFromAi.response);

        const currentState = this.occupancyState[ruleName];
        const message = `AI detected ${detectedObjectsFromAi}, current state ${JSON.stringify(currentState)}`;
        logger.log(message);

        const { devNotifier } = this.plugin.storageSettings.values;
        (devNotifier as Notifier).sendNotification(`Occupancy AI check ${ruleName}`, {
            body: message,
        }, newImage);
    }

    async checkOccupancyData(props: {
        image: MediaObject,
        b64Image: string,
        source: 'Detections' | 'MainFlow'
    }) {
        const { image: imageParent, source } = props;
        if (this.processingOccupanceData) {
            return;
        }

        if (!imageParent) {
            return;
        }

        const now = Date.now();

        const logger = this.getLogger();

        try {
            const shouldRun = !!this.runningOccupancyRules.length || this.storageSettings.values.checkOccupancy;

            if (!shouldRun) {
                return;
            }

            if (
                !this.isDelayPassed({
                    type: DelayType.OccupancyRegularCheck
                }).timePassed
            ) {
                return;
            }

            this.processingOccupanceData = true;

            logger.info(`Checking occupancy for reason ${source}`);

            const occupancyRulesDataTmpMap: Record<string, OccupancyRuleData> = {};
            const zonesData = await this.getObserveZones();

            const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

            if (!objectDetector) {
                logger.log(`No detection plugin selected. skipping occupancy`);
                return;
            }

            const detectedResultParent = await objectDetector.detectObjects(imageParent);

            if (!objectDetector.interfaces.includes(ScryptedInterface.ObjectDetectionGenerator)) {
                detectedResultParent.detections = filterOverlappedDetections(detectedResultParent.detections);
            }

            for (const occupancyRule of this.runningOccupancyRules) {
                let image = imageParent;

                const { name, zoneType, observeZone, scoreThreshold, detectionClass, maxObjects, captureZone } = occupancyRule;

                let detectedResult = detectedResultParent;
                const zone = zonesData.find(zoneData => zoneData.name === observeZone);

                if (!zone) {
                    logger.log(`Zone ${zone} for rule ${name} not found, skipping checks`);
                    continue;
                }

                if (captureZone?.length >= 3) {
                    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(imageParent, ScryptedMimeTypes.Image);
                    let left = convertedImage.width;
                    let top = convertedImage.height;
                    let right = 0;
                    let bottom = 0;
                    for (const point of zone.path) {
                        left = Math.min(left, point[0]);
                        top = Math.min(top, point[1]);
                        right = Math.max(right, point[0]);
                        bottom = Math.max(bottom, point[1]);
                    }

                    left = left * convertedImage.width;
                    top = top * convertedImage.height;
                    right = right * convertedImage.width;
                    bottom = bottom * convertedImage.height;

                    let width = right - left;
                    let height = bottom - top;
                    // square it for standard detection
                    width = height = Math.max(width, height);
                    // recenter it
                    left = left + (right - left - width) / 2;
                    top = top + (bottom - top - height) / 2;
                    // ensure bounds are within image.
                    left = Math.max(0, left);
                    top = Math.max(0, top);
                    width = Math.min(width, convertedImage.width - left);
                    height = Math.min(height, convertedImage.height - top);

                    if (!Number.isNaN(left) && !Number.isNaN(top) && !Number.isNaN(width) && !Number.isNaN(height)) {
                        image = await convertedImage.toImage({
                            crop: {
                                left,
                                top,
                                width,
                                height,
                            },
                        });
                        detectedResult = await objectDetector.detectObjects(image);
                    }

                    if (!objectDetector.interfaces.includes(ScryptedInterface.ObjectDetectionGenerator)) {
                        detectedResult.detections = filterOverlappedDetections(detectedResult.detections);
                    }

                    // adjust the origin of the bounding boxes for the crop.
                    for (const d of detectedResult.detections) {
                        d.boundingBox[0] += left;
                        d.boundingBox[1] += top;
                    }
                    detectedResult.inputDimensions = [convertedImage.width, convertedImage.height];
                }

                let objectsDetected = 0;
                let maxScore = 0;

                for (const detection of detectedResult.detections) {
                    const className = detectionClassesDefaultMap[detection.className];
                    if (detection.score >= scoreThreshold && detectionClass === className) {
                        if (!maxScore || detection.score > maxScore) {
                            maxScore = detection.score;
                        }
                        const boundingBoxInCoords = normalizeBox(detection.boundingBox, detectedResult.inputDimensions);
                        let zoneMatches = false;

                        if (zoneType === ZoneMatchType.Intersect) {
                            zoneMatches = polygonIntersectsBoundingBox(zone.path, boundingBoxInCoords);
                        } else {
                            zoneMatches = polygonContainsBoundingBox(zone.path, boundingBoxInCoords);
                        }

                        if (zoneMatches) {
                            objectsDetected += 1;
                        }
                    }
                }

                const occupies = ((maxObjects || 1) - objectsDetected) <= 0;

                const updatedState: CurrentOccupancyState = {
                    ...this.occupancyState[name] ?? {} as CurrentOccupancyState,
                    score: maxScore,
                    referenceZone: zone
                };

                this.occupancyState[name] = updatedState;

                const existingRule = occupancyRulesDataTmpMap[name];
                if (!existingRule) {
                    occupancyRulesDataTmpMap[name] = {
                        rule: occupancyRule,
                        occupies,
                        triggerTime: now,
                        objectsDetected: objectsDetected,
                        image,
                        objectsDetectedResult: [detectedResult]
                    }
                } else if (!existingRule.occupies && occupies) {
                    existingRule.occupies = true;
                }
            }

            const occupancyRulesData: OccupancyRuleData[] = [];
            const rulesToNotNotify: string[] = [];
            for (const occupancyRuleTmpData of Object.values(occupancyRulesDataTmpMap)) {
                const { rule, image } = occupancyRuleTmpData;
                const { name, changeStateConfirm } = rule;
                const currentState = this.occupancyState[name];
                const lastChangeElpasedMs = now - (currentState?.lastChange ?? 0);
                const tooOld = !currentState || lastChangeElpasedMs >= (1000 * 60 * 10); // Force an update every 10 minutes
                const toConfirm = currentState.occupancyToConfirm != undefined && !!currentState.confirmationStart;
                const isChanged = occupancyRuleTmpData.occupies !== currentState.occupies;

                logger.info(JSON.stringify({
                    rule: name,
                    occupancyToConfirm: currentState.occupancyToConfirm,
                    confirmationStart: currentState.confirmationStart,
                    occupies: occupancyRuleTmpData.occupies,
                    currentOccupies: currentState.occupies,
                    tooOld,
                    toConfirm,
                    isChanged,
                })
                );

                const {
                    occupancy: {
                        occupiesKey,
                        detectedObjectsKey
                    }
                } = getRuleKeys({
                    ruleType: RuleType.Occupancy,
                    ruleName: name,
                });

                if (currentState.objectsDetected !== occupancyRuleTmpData.objectsDetected) {
                    await this.storageSettings.putSetting(detectedObjectsKey, occupancyRuleTmpData.objectsDetected);
                }

                const occupancyDataToUpdate: CurrentOccupancyState = {
                    ...(currentState ?? getInitOccupancyState(rule)),
                    lastCheck: now,
                };

                if (toConfirm) {
                    const elpasedTimeMs = now - (currentState?.confirmationStart ?? 0);
                    const isConfirmationTimePassed = elpasedTimeMs >= (1000 * changeStateConfirm);
                    const isStateConfirmed = occupancyRuleTmpData.occupies === currentState.occupancyToConfirm;

                    if (!isConfirmationTimePassed) {
                        if (isStateConfirmed) {
                            // Do nothing and wait for next iteration
                            this.occupancyState[name] = {
                                ...occupancyDataToUpdate,
                                confirmedFrames: (currentState.confirmedFrames ?? 0) + 1,
                            };
                            logger.log(`Confirmation time is not passed yet for rule ${name}: toConfirm ${currentState.occupancyToConfirm} started ${elpasedTimeMs / 1000} seconds ago  (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames})`);
                        } else {
                            // Reset confirmation data because the value changed before confirmation time passed
                            logger.log(`Confirmation failed for rule ${name}: toConfirm ${currentState.occupancyToConfirm} after ${elpasedTimeMs / 1000} seconds (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames})`);

                            this.occupancyState[name] = {
                                ...getInitOccupancyState(rule),
                                lastCheck: now,
                            };
                        }
                    } else {
                        if (isStateConfirmed) {
                            // Time is passed and value didn't change, update the state. But let's ask AI first
                            let confirmedByAi = true;

                            if (rule.confirmWithAi) {
                                try {
                                    const zone = zonesData.find(zoneData => zoneData.name === rule.observeZone);

                                    const { newB64Image } = await addZoneClipPathToImage({
                                        image,
                                        clipPath: zone.path
                                    });
                                    const occupiesFromAi = await checkObjectsOccupancy({
                                        b64Image: newB64Image,
                                        logger,
                                        plugin: this.plugin,
                                        detectionClass: rule.detectionClass
                                    });

                                    const detectedObjectsFromAi = Number(occupiesFromAi.response);
                                    if (!Number.isNaN(detectedObjectsFromAi)) {
                                        confirmedByAi = detectedObjectsFromAi === currentState.objectsDetected
                                    } else {
                                        confirmedByAi = true;
                                    }
                                } catch (e) {
                                    logger.error(`Error trying to confirm occupancy rule ${rule.name}`, e);
                                    confirmedByAi = true;
                                }
                            }

                            if (confirmedByAi) {
                                this.occupancyState[name] = {
                                    ...getInitOccupancyState(rule),
                                    lastChange: now,
                                    occupies: occupancyRuleTmpData.occupies,
                                    objectsDetected: occupancyRuleTmpData.objectsDetected
                                };

                                logger.log(`Confirming occupancy rule ${name}: ${occupancyRuleTmpData.occupies} ${occupancyRuleTmpData.objectsDetected} (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames})`);
                                const { b64Image: _, ...rest } = currentState;
                                const { b64Image: __, image: ____, ...rest2 } = occupancyRuleTmpData;
                                const { b64Image: ___, ...rest3 } = occupancyDataToUpdate;
                                logger.log(JSON.stringify({
                                    occupancyRuleTmpData: rest2,
                                    currentState: rest,
                                    occupancyData: rest3,
                                }));

                                occupancyRulesData.push({
                                    ...occupancyRuleTmpData,
                                    triggerTime: currentState.confirmationStart,
                                    changed: true,
                                    b64Image: currentState.b64Image,
                                });

                                await this.storageSettings.putSetting(occupiesKey, occupancyRuleTmpData.occupies);
                            } else {
                                this.occupancyState[name] = {
                                    ...occupancyDataToUpdate,
                                    confirmationStart: now,
                                    occupancyToConfirm: occupancyRuleTmpData.occupies
                                };

                                logger.log(`Discarding confirmation of occupancy rule ${name}: ${occupancyRuleTmpData.occupies} ${occupancyRuleTmpData.objectsDetected} (V ${currentState.confirmedFrames} / X ${currentState.rejectedFrames}). AI didn't confirm`);
                            }

                        } else {
                            // Time is passed and value changed, restart confirmation flow
                            this.occupancyState[name] = {
                                ...occupancyDataToUpdate,
                                confirmationStart: now,
                                occupancyToConfirm: occupancyRuleTmpData.occupies
                            };

                            logger.log(`Restarting confirmation flow (because time is passed and value changed) for occupancy rule ${name}: toConfirm ${occupancyRuleTmpData.occupies}`);
                        }
                    }
                } else if (isChanged) {
                    const b64Image = await moToB64(image);
                    logger.log(`Marking the rule to confirm ${occupancyRuleTmpData.occupies} for next iteration ${name}: ${occupancyRuleTmpData.objectsDetected} objects, score ${currentState.score}, image ${getB64ImageLog(b64Image)}`);
                    logger.log(JSON.stringify({
                        isChanged,
                        currentOccupies: currentState.occupies,
                    }))
                    this.occupancyState[name] = {
                        ...occupancyDataToUpdate,
                        confirmationStart: now,
                        confirmedFrames: 0,
                        rejectedFrames: 0,
                        score: 0,
                        occupancyToConfirm: occupancyRuleTmpData.occupies,
                        b64Image
                    };
                } else if (tooOld) {
                    logger.info(`Force pushing rule ${name}, last change ${lastChangeElpasedMs / 1000} seconds ago`);

                    occupancyRulesData.push({
                        ...occupancyRuleTmpData,
                        triggerTime: currentState.confirmationStart,
                        changed: false
                    });

                    rulesToNotNotify.push(occupancyRuleTmpData.rule.name);
                    this.occupancyState[name] = {
                        ...occupancyDataToUpdate,
                    };
                } {
                    logger.info(`Refreshing lastCheck only for rule ${name}`);
                }
            }
            const mqttClient = await this.getMqttClient();

            if (
                this.storageSettings.values.enabledToMqtt &&
                this.isActiveForMqttReporting &&
                detectedResultParent &&
                mqttClient
            ) {
                const logData = occupancyRulesData.map(elem => {
                    const { rule, b64Image, image, ...rest } = elem;
                    return rest
                });
                logger.info(`Publishing occupancy data from source ${source}. ${JSON.stringify(logData)}`);
                publishOccupancy({
                    console: logger,
                    device: this.cameraDevice,
                    mqttClient,
                    objectsDetected: detectedResultParent,
                    occupancyRulesData,

                }).catch(logger.error);
            }

            for (const occupancyRuleData of occupancyRulesData) {
                const { rule, b64Image, triggerTime } = occupancyRuleData;

                this.storeImagesOnFs({
                    b64Image,
                    device: this.cameraDevice,
                    triggerTime,
                    prefix: `rule-${rule.name}`,
                    eventSource: ScryptedEventSource.RawDetection,
                }).catch(logger.log);

                const { timePassed } = this.isDelayPassed({
                    type: DelayType.OccupancyNotification,
                    matchRule: { rule },
                    eventSource: ScryptedEventSource.RawDetection
                });

                if (!rulesToNotNotify.includes(rule.name) && timePassed) {
                    const image = b64Image ? await b64ToMo(b64Image) : imageParent;
                    const triggerTime = (occupancyRuleData?.triggerTime ?? now) - 10 * 1000;

                    await this.plugin.notifyOccupancyEvent({
                        cameraDevice: this.cameraDevice,
                        rule,
                        triggerTime,
                        image,
                        occupancyData: occupancyRuleData
                    });
                }
            }
            this.processingOccupanceData = false;
        }
        catch (e) {
            logger.log('Error in checkOccupancyData', e);
        }
    }

    public async processAudioDetection(props: {
        dBs: number,
        dev: number,
    }) {
        const logger = this.getLogger();
        const { dBs, dev } = props;
        logger.debug(`Audio detection: ${dBs} dB, dev ${dev}`);
        const now = Date.now();

        let image: MediaObject;
        let b64Image: string;
        for (const rule of (this.runningAudioRules ?? [])) {
            const {
                name,
                audioDuration,
                decibelThreshold,
                customText,
                hitPercentage
            } = rule;
            let samples = this.audioRuleSamples[name] ?? [];

            logger.debug(`Audio rule: ${JSON.stringify({
                name,
                samples,
                hitPercentage,
                decibelThreshold,
                audioDuration,
            })}`);

            let windowReached = false;
            this.audioRuleSamples[name] = [
                ...samples,
                { dBs, dev, timestamp: now }
            ].filter(sample => {
                const isOverWindow = (now - sample.timestamp) > (audioDuration * 1000);
                if (isOverWindow && !windowReached) {
                    windowReached = true
                }

                return !isOverWindow;
            });

            samples = this.audioRuleSamples[name];

            if (windowReached) {
                const hitsInWindow = samples.filter(sample => sample.dBs >= decibelThreshold);
                const hitsInWindowPercentage = (hitsInWindow.length / samples.length) * 100;

                if (hitsInWindowPercentage >= hitPercentage) {
                    logger.info(`Hits percentage reached: ${JSON.stringify({
                        hitsInWindowPercentage,
                        hitsInWindow,
                        samples: samples.length,
                    })}`);

                    const { timePassed: notificationTimePassed } = this.isDelayPassed({
                        type: DelayType.RuleNotification,
                        matchRule: { rule } as MatchRule,
                        eventSource: ScryptedEventSource.RawDetection
                    });

                    if (notificationTimePassed) {
                        let imageSource: ImageSource;

                        if (!image) {
                            const { image: imageNew, b64Image: b64ImageNew, imageSource: imageSourceNew } = await this.getImage({ reason: GetImageReason.AudioTrigger });
                            image = imageNew;
                            b64Image = b64ImageNew;
                            imageSource = imageSourceNew;
                        }

                        logger.log(`Triggering audio notification, image coming from ${imageSource} with an hit % of ${hitsInWindowPercentage} (${hitsInWindow.length} hits / ${samples.length} samples)`);

                        let message = customText;

                        message = message.toString()
                        message = message.toString()
                            .replace('${decibels}', String(decibelThreshold) ?? '')
                            .replace('${duration}', String(audioDuration) ?? '')

                        await this.plugin.notifyAudioEvent({
                            cameraDevice: this.cameraDevice,
                            image,
                            message,
                            rule,
                            triggerTime: now,
                        });

                        this.triggerRule({
                            matchRule: { rule },
                            b64Image,
                            device: this.cameraDevice,
                            triggerTime: now,
                            eventSource: ScryptedEventSource.RawDetection
                        }).catch(logger.log);

                        this.resetAudioRule(name);
                    } else {
                        logger.info(`Notification time not passed yet`);
                    }
                } else {
                    logger.info(`Hits percentage not reached: ${JSON.stringify({
                        hitsInWindowPercentage,
                        hitsInWindow,
                        samples: samples.length,
                    })}`);
                }
            } else {
                logger.info(`Not enough samples, just adding ${JSON.stringify({
                    samples: samples.length,
                })}`);
            }
        }
    }

    async storeImagesOnFs(props: {
        prefix?: string,
        suffix?: string,
        detections?: ObjectDetectionResult[],
        device: ScryptedDeviceBase,
        triggerTime: number,
        b64Image: string,
        eventSource: ScryptedEventSource,
    }) {
        const { detections, prefix, suffix, device, triggerTime, b64Image, eventSource } = props;

        if (detections) {
            for (const detection of detections) {
                const { className, label } = detection;
                const detectionClass = detectionClassesDefaultMap[className];
                if (detectionClass) {

                    let name = `${prefix}-${className}`;

                    if (label) {
                        name += `-${label}`;
                    }
                    if (suffix) {
                        name += `-${suffix}`;
                    }

                    this.plugin.storeImage({
                        device,
                        name,
                        timestamp: triggerTime,
                        b64Image,
                        detection,
                        eventSource
                    });
                } else {
                    console.log(`${className} not found`);
                }
            }
        } else if (prefix) {
            this.plugin.storeImage({
                device,
                name: prefix,
                timestamp: triggerTime,
                b64Image,
                eventSource
            });
        }
    }

    async processAccumulatedDetections() {
        if (!this.accumulatedDetections.length && !this.accumulatedRules.length) {
            return;
        }

        const logger = this.getLogger();

        const dataToAnalyze = this.accumulatedDetections.map(det => ({
            triggerTime: det.detect.timestamp,
            detectionId: det.detect.detectionId,
            eventId: det.eventId,
            detections: det.detect.detections,
            eventSource: det.eventSource
        }));
        const rulesToUpdate = uniqBy(cloneDeep(this.accumulatedRules), getDetectionKey);

        // Clearing the buckets right away to not lose too many detections
        this.accumulatedDetections = [];
        this.accumulatedRules = [];

        const triggerTime = dataToAnalyze[0]?.triggerTime;
        const detections = uniqBy(dataToAnalyze.flatMap(item => item.detections), item => `${item.className}-${item.label}`);

        const isOnlyMotion = !rulesToUpdate.length && detections.length === 1 && detectionClassesDefaultMap[detections[0]?.className] === DetectionClass.Motion;

        logger.debug(`Accumulated data to analyze: ${JSON.stringify({ triggerTime, detections, rules: rulesToUpdate.map(getDetectionKey) })}`);

        let image: MediaObject;
        let b64Image: string;
        let imageSource: ImageSource;
        for (const data of dataToAnalyze) {
            const { detectionId, eventId, eventSource } = data;
            if (detectionId && eventId && eventSource !== ScryptedEventSource.Frigate) {
                const imageData = await this.getImage({
                    detectionId,
                    eventId,
                    reason: GetImageReason.AccumulatedDetections,
                });

                if (imageData.imageSource === ImageSource.Detector) {
                    image = imageData.image;
                    b64Image = imageData.b64Image;
                    imageSource = imageData.imageSource;

                    break;
                }
            }
        }

        if (!image || !b64Image) {
            const imageData = await this.getImage({
                reason: isOnlyMotion && !rulesToUpdate.length ?
                    GetImageReason.MotionUpdate :
                    GetImageReason.ObjectUpdate
            });

            image = imageData.image;
            b64Image = imageData.b64Image;
            imageSource = imageData.imageSource;
        }

        if (image && b64Image) {
            // if (bufferImage) {
            //     try {
            //         const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

            //         if (!objectDetector) {
            //             return;
            //         }
            //         logger.log('Adding bounding boxes');

            //         const detection = await objectDetector.detectObjects(image);
            //         const { newB64Image, newImage } = await addBoundingBoxesToImage({
            //             console: logger,
            //             detection,
            //             bufferImage,
            //         });

            //         image = newImage;
            //         b64Image = newB64Image;
            //     } catch (e) {
            //         logger.log(`Error adding bounding boxes`, e);
            //     }
            // }

            try {
                const classnamesString = getDetectionsLog(detections);

                if (this.isActiveForMqttReporting) {
                    const mqttClient = await this.getMqttClient();

                    if (mqttClient) {
                        logger.info(`Updating classname images ${classnamesString} with image source ${imageSource}`);

                        const allowedClassnames = detections.filter(classname => this.isDelayPassed({
                            classname: classname.className,
                            label: classname.label,
                            type: DelayType.BasicDetectionImage,
                            eventSource: ScryptedEventSource.RawDetection
                        })?.timePassed);

                        allowedClassnames.length && await publishClassnameImages({
                            mqttClient,
                            console: logger,
                            detections: allowedClassnames,
                            device: this.cameraDevice,
                            b64Image,
                            triggerTime,
                        }).catch(logger.error);
                    }
                }

                this.storeImagesOnFs({
                    b64Image,
                    detections,
                    device: this.cameraDevice,
                    triggerTime,
                    prefix: 'object-detection',
                    eventSource: ScryptedEventSource.RawDetection,
                }).catch(logger.log);

                if (rulesToUpdate.length) {
                    logger.info(`Updating accumulated rules ${getRulesLog(rulesToUpdate)} with image source ${imageSource}`);
                    for (const matchRule of rulesToUpdate) {
                        const { rule, match } = matchRule;

                        logger.info(`Publishing accumulated detection rule ${getDetectionKey(matchRule)} data, b64Image ${getB64ImageLog(b64Image)} from ${imageSource}. Has image ${!!image}`);

                        this.triggerRule({
                            matchRule,
                            skipTrigger: true,
                            b64Image,
                            device: this.cameraDevice,
                            triggerTime,
                            eventSource: ScryptedEventSource.RawDetection
                        }).catch(logger.log);

                        const { timePassed, lastSetInSeconds, minDelayInSeconds } = this.isDelayPassed({
                            type: DelayType.RuleNotification,
                            matchRule,
                            eventSource: ScryptedEventSource.RawDetection
                        });

                        if (timePassed) {
                            logger.log(`Starting notifiers for detection rule (accumulated detections) ${getDetectionKey(matchRule)}, b64Image ${getB64ImageLog(b64Image)} from ${imageSource}, last check ${lastSetInSeconds}s ago with delay ${minDelayInSeconds}s (accumnulated detections)`);

                            await this.plugin.notifyDetectionEvent({
                                triggerDeviceId: this.id,
                                match,
                                rule: rule as DetectionRule,
                                image,
                                eventType: detectionClassesDefaultMap[match.className],
                                triggerTime,
                            });
                        }
                    }
                }

                this.checkOccupancyData({
                    image,
                    b64Image,
                    source: 'Detections'
                }).catch(logger.log);

                if (!isOnlyMotion && this.runningTimelapseRules?.length) {
                    for (const rule of this.runningTimelapseRules) {
                        logger.log(`Adding detection frame from ${imageSource} (${classnamesString}) to the timelapse rule ${rule.name}`);

                        this.plugin.storeTimelapseFrame({
                            imageMo: image,
                            timestamp: triggerTime,
                            device: this.cameraDevice,
                            rule
                        }).catch(logger.log);
                    }
                }
            } catch (e) {
                logger.log(`Error on publishing data: ${JSON.stringify(dataToAnalyze)}`, e)
            }
        }
    }

    get detectionSourceForMqtt() {
        const { detectionSourceForMqtt } = this.storageSettings.values;
        const { detectionSourceForMqtt: detectionSourceForMqttPlugin } = this.plugin.storageSettings.values;

        let source: ScryptedEventSource;
        if (detectionSourceForMqtt !== 'Default') {
            source = detectionSourceForMqtt;
        } else {
            source = detectionSourceForMqttPlugin;
        }

        return source ?? ScryptedEventSource.RawDetection;
    }

    isDelayPassed(props: IsDelayPassedProps) {
        const { type } = props;

        const detectionSourceForMqtt = this.detectionSourceForMqtt;

        let delayKey = `${type}`;
        let referenceTime = Date.now();
        let minDelayInSeconds: number;

        if (type === DelayType.BasicDetectionImage) {
            if (detectionSourceForMqtt === ScryptedEventSource.NVR) {
                minDelayInSeconds = undefined;
            } else {
                const { eventSource } = props;
                const { classname, label } = props;
                let key = label ? `${classname}-${label}` : classname;
                key += `-${eventSource}`
                delayKey += `-${key}`;
                const { minMqttPublishDelay } = this.storageSettings.values;
                minDelayInSeconds = minMqttPublishDelay;
            }
        } else if (type === DelayType.BasicDetectionTrigger) {
            const { classname, label } = props;
            const key = label ? `${classname}-${label}` : classname;
            delayKey += `-${key}`;
            minDelayInSeconds = 5;
        } else if (type === DelayType.RuleImageUpdate) {
            const { matchRule } = props;
            const lastDetectionkey = getDetectionKey(matchRule);

            delayKey += `-${lastDetectionkey}`;
            minDelayInSeconds = matchRule.rule.minMqttPublishDelay;
        } else if (type === DelayType.RuleNotification) {
            const { matchRule } = props;
            const { minDelayTime } = this.storageSettings.values;
            const lastDetectionkey = getDetectionKey(matchRule);

            delayKey += `-${lastDetectionkey}`;
            minDelayInSeconds = matchRule.rule.minDelay ?? minDelayTime;
        } else if (type === DelayType.OccupancyNotification) {
            const { matchRule } = props;

            delayKey += `-${matchRule.rule.name}`;
            minDelayInSeconds = 5;
        } else if (type === DelayType.PostWebhookImage) {
            const { classname } = props;
            const { postDetectionImageMinDelay } = this.storageSettings.values;

            delayKey += `-${classname}`;
            minDelayInSeconds = postDetectionImageMinDelay;
        } else if (type === DelayType.FsImageUpdate) {
            const { filename } = props;

            delayKey += `-${filename}`;
            minDelayInSeconds = 5;
        } else if (type === DelayType.DecoderFrameOnStorage) {
            minDelayInSeconds = DECODER_FRAME_MIN_TIME / 1000;
        } else if (type === DelayType.OccupancyRegularCheck) {
            minDelayInSeconds = !!this.runningOccupancyRules.length || this.storageSettings.values.checkOccupancy ? 0.3 : 0;
        } else if (type === DelayType.EventStore) {
            const { identifiers } = props;

            delayKey += `-${identifiers.join('_')}`;

            if (identifiers.length === 1 && isMotionClassname(identifiers[0])) {
                minDelayInSeconds = 30;
            } else {
                minDelayInSeconds = 15;
            }
        }

        const lastSetTime = this.lastDelaySet[delayKey];
        const timePassed = !lastSetTime || !minDelayInSeconds ? true : (referenceTime - lastSetTime) >= (minDelayInSeconds * 1000);
        const lastSetInSeconds = lastSetTime ? (referenceTime - lastSetTime) / 1000 : undefined;

        this.getLogger().debug(`Is delay passed for ${delayKey}: ${timePassed}, last set ${lastSetInSeconds}. ${JSON.stringify(props)}`);
        if (timePassed) {
            this.lastDelaySet[delayKey] = referenceTime;
        }

        return {
            timePassed,
            lastSetInSeconds,
            minDelayInSeconds,
        }
    }

    async getEmbeddingSimilarityScore(props: {
        deviceId: string,
        image?: MediaObject,
        imageEmbedding?: string,
        text: string,
        detId: string,
    }) {
        const { image, imageEmbedding, text, deviceId, detId } = props;
        const clipDevice = sdk.systemManager.getDeviceById<TextEmbedding & ImageEmbedding>(deviceId);

        let imageEmbeddingBuffer: Buffer;
        let textEmbeddingBuffer: Buffer;
        if (imageEmbedding) {
            imageEmbeddingBuffer = Buffer.from(imageEmbedding, "base64");
        } else if (image) {
            if (detId && this.plugin.imageEmbeddingCache.has(detId)) {
                imageEmbeddingBuffer = this.plugin.imageEmbeddingCache.get(detId);
            } else {
                imageEmbeddingBuffer = await clipDevice.getImageEmbedding(image);
                this.plugin.imageEmbeddingCache.set(detId, imageEmbeddingBuffer);
            }
        }

        if (imageEmbeddingBuffer) {
            const imageEmbedding = new Float32Array(
                imageEmbeddingBuffer.buffer,
                imageEmbeddingBuffer.byteOffset,
                imageEmbeddingBuffer.length / Float32Array.BYTES_PER_ELEMENT
            );

            if (this.plugin.textEmbeddingCache.has(text)) {
                textEmbeddingBuffer = this.plugin.textEmbeddingCache.get(text);
            } else {
                textEmbeddingBuffer = await clipDevice.getTextEmbedding(text);
                this.plugin.textEmbeddingCache.set(text, textEmbeddingBuffer);
            }

            const textEmbedding = new Float32Array(
                textEmbeddingBuffer.buffer,
                textEmbeddingBuffer.byteOffset,
                textEmbeddingBuffer.length / Float32Array.BYTES_PER_ELEMENT
            );

            let dotProduct = 0;
            for (let i = 0; i < imageEmbedding.length; i++) {
                dotProduct += imageEmbedding[i] * textEmbedding[i];
            }

            return dotProduct;
        } else {
            return 0;
        }
    }

    public async processDetections(props: {
        detect: FrigateObjectDetection | ObjectsDetected,
        eventDetails?: EventDetails,
        image?: MediaObject,
        eventSource?: ScryptedEventSource
    }) {
        const { detect, eventDetails, image: parentImage, eventSource } = props;
        const isFromNvr = eventSource === ScryptedEventSource.NVR;
        const isFromFrigate = eventSource === ScryptedEventSource.Frigate;
        const isRawDetection = eventSource === ScryptedEventSource.RawDetection;
        const logger = this.getLogger();
        const { timestamp: triggerTime, detections } = detect;
        const detectionSourceForMqtt = this.detectionSourceForMqtt;

        if (!detections?.length) {
            return;
        }

        const {
            minDelayTime,
            ignoreCameraDetections,
        } = this.storageSettings.values;

        const {
            candidates,
            facesFound,
            isAudioEvent,
            hasNonStandardClasses
        } = filterAndSortValidDetections({
            detections: detections ?? [],
            logger,
            consumedDetectionIdsSet: new Set(),
        });
        const originalCandidates = cloneDeep(candidates);

        const canPickImageRightAway = !isRawDetection || (isAudioEvent && isFromFrigate);
        const canUpdateMqttImage = canPickImageRightAway && detectionSourceForMqtt === eventSource;
        const canUpdateMqttClasses =
            eventSource === detectionSourceForMqtt ||
            hasNonStandardClasses ||
            isAudioEvent;

        eventDetails && this.processDetectionsInterval && this.accumulatedDetections.push({
            detect: {
                ...detect,
                detections: cloneDeep(candidates)
            },
            eventId: eventDetails.eventId,
            eventSource,
        });

        let image: MediaObject;
        let b64Image: string;
        let imageSource: ImageSource;

        try {
            if (canPickImageRightAway) {
                const classnamesLog = getDetectionsLog(detections)
                const { b64Image: b64ImageNew, image: imageNew, imageSource: imageSourceNew } = await this.getImage({
                    image: parentImage,
                    reason: isFromNvr ? GetImageReason.FromNvr : isFromFrigate ?
                        GetImageReason.FromFrigate : undefined,
                    detectionId: isFromFrigate ? (detect as FrigateObjectDetection).frigateEvent?.after?.id : undefined
                });
                image = imageNew;
                b64Image = b64ImageNew;
                imageSource = imageSourceNew;

                const withEmbeddings = detect.detections.filter(det => !!det.embedding);
                logger.log(`${eventSource} detections received, classnames ${classnamesLog}, image from ${imageSource}, with embedding: ${withEmbeddings.length ? getDetectionsLog(withEmbeddings) : 'None'}`);
            }

            if (this.isActiveForMqttReporting) {
                const mqttClient = await this.getMqttClient();

                if (mqttClient) {
                    if (canUpdateMqttClasses) {
                        if (candidates.some(elem => isObjectClassname(elem.className))) {
                            candidates.push(
                                { className: DetectionClass.AnyObject, score: 1 }
                            );
                        }

                        const spamBlockedDetections = candidates.filter(det =>
                            this.isDelayPassed({
                                type: DelayType.BasicDetectionTrigger,
                                classname: det.className,
                                label: det.label,
                                eventSource,
                            })?.timePassed
                        );

                        if (spamBlockedDetections.length) {
                            const isOnlyMotion = spamBlockedDetections?.length === 1 && spamBlockedDetections[0].className === DetectionClass.Motion;
                            logger.info(`Triggering basic detections ${getDetectionsLog(spamBlockedDetections)}`);

                            for (const detection of spamBlockedDetections) {
                                const { className, label } = detection;

                                publishBasicDetectionData({
                                    mqttClient,
                                    console: logger,
                                    detection,
                                    device: this.cameraDevice,
                                    triggerTime,
                                }).catch(logger.error);

                                if (canUpdateMqttImage && b64Image) {
                                    const { timePassed } = this.isDelayPassed({
                                        classname: className,
                                        label,
                                        eventSource,
                                        type: DelayType.BasicDetectionImage,
                                    });

                                    if (timePassed) {
                                        logger.info(`Updating image for classname ${className} source: ${eventSource ? 'NVR' : 'Decoder'}`);

                                        publishClassnameImages({
                                            mqttClient,
                                            console: logger,
                                            detections: [detection],
                                            device: this.cameraDevice,
                                            b64Image,
                                            triggerTime,
                                        }).catch(logger.error);
                                    }
                                }
                            }

                            this.resetDetectionEntities({
                                resetSource: 'Timeout'
                            }).catch(logger.log);
                        }
                    }

                    if (
                        eventSource === ScryptedEventSource.NVR &&
                        b64Image &&
                        facesFound.length &&
                        this.cameraDevice.room
                    ) {
                        publishPeopleData({
                            mqttClient,
                            console: logger,
                            faces: facesFound,
                            b64Image,
                            room: this.cameraDevice.room,
                            imageSource,
                        }).catch(logger.error);
                    }
                }
            }

            this.storeImagesOnFs({
                b64Image,
                detections: candidates,
                device: this.cameraDevice,
                triggerTime,
                prefix: 'object-detection',
                suffix: !isRawDetection ? eventSource : undefined,
                eventSource
            }).catch(logger.log);

            if (
                isRawDetection &&
                detect?.detectionId &&
                eventDetails?.eventId &&
                this.plugin.storageSettings.values.storeEvents
            ) {
                const { b64Image: b64ImageToStore, image: imageToStore } = await this.getImage({
                    eventId: eventDetails.eventId,
                    detectionId: detect.detectionId,
                    reason: GetImageReason.StoreRawEvent
                });

                if (b64ImageToStore && imageToStore) {
                    const logger = this.getLogger();
                    logger.info(`Starting ${eventSource} storeEventImage: ${JSON.stringify({
                        detections,
                        candidates,
                    })}`);

                    const eventId = getDetectionEventKey({ detectionId: detect.detectionId, eventId: eventDetails.eventId });

                    this.plugin.storeEventImage({
                        b64Image: b64ImageToStore,
                        detections: originalCandidates,
                        device: this.cameraDevice,
                        eventSource,
                        logger,
                        timestamp: triggerTime,
                        image: imageToStore,
                        eventId,
                    }).catch(logger.error);
                }
            }
        } catch (e) {
            logger.log('Error parsing detections', e);
        }

        let dataToReport = {};
        try {
            const matchRules: MatchRule[] = [];

            const rules = cloneDeep(this.runningDetectionRules.filter(rule => rule.detectionSource === eventSource)) ?? [];
            logger.debug(`Detections incoming ${JSON.stringify({
                candidates,
                detect,
                minDelayTime,
                ignoreCameraDetections,
                rules,
            })}`);

            const { clipDevice } = this.plugin.storageSettings.values;

            for (const rule of rules) {
                const {
                    detectionClasses,
                    scoreThreshold,
                    whitelistedZones,
                    blacklistedZones,
                    people,
                    plates,
                    plateMaxDistance,
                    labelScoreThreshold,
                    detectionSource,
                    frigateLabels,
                    clipDescription,
                    clipConfidence,
                } = rule;
                const isFromFrigate = detectionSource === ScryptedEventSource.Frigate;

                if (!detectionClasses.length || !rule.currentlyActive) {
                    continue;
                }

                const matches = candidates.filter(d => {
                    if (ignoreCameraDetections && !d.boundingBox) {
                        return false;
                    }

                    const { className: classnameRaw, score, zones, label, labelScore } = d;

                    const className = detectionClassesDefaultMap[classnameRaw];

                    if (!className) {
                        logger.log(`Classname ${classnameRaw} not mapped. Candidates ${JSON.stringify(candidates)}`);

                        return false;
                    }

                    if (!detectionClasses.includes(className)) {
                        logger.debug(`Classname ${className} not contained in ${detectionClasses}`);
                        return false;
                    }

                    if (people?.length && isFaceClassname(className) && (!label || !people.includes(label))) {
                        logger.debug(`Face ${label} not contained in ${people}`);
                        return false;
                    }

                    if (plates?.length && isPlateClassname(className)) {
                        const anyValidPlate = plates.some(plate => levenshteinDistance(plate, label) > plateMaxDistance);

                        if (!anyValidPlate) {
                            logger.debug(`Plate ${label} not contained in ${plates}`);
                            return false;
                        }
                    }

                    if (isPlateClassname(className) || isFaceClassname(className)) {
                        const labelScoreOk = !labelScore || labelScore > labelScoreThreshold;

                        if (!labelScoreOk) {
                            logger.debug(`Label score ${labelScore} not ok ${labelScoreThreshold}`);
                            return false;
                        }
                    }

                    if (isFromFrigate && label) {
                        if (!frigateLabels?.length || !frigateLabels.includes(label)) {
                            logger.debug(`Frigate label ${label} not whitelisted ${frigateLabels}`);
                            return false;
                        }
                    }

                    const scoreOk = !score || score > scoreThreshold;

                    if (!scoreOk) {
                        logger.debug(`Score ${score} not ok ${scoreThreshold}`);
                        return false;
                    }

                    dataToReport = {
                        zones,

                        score,
                        scoreThreshold,
                        scoreOk,

                        className,
                        detectionClasses
                    };

                    let zonesOk = true;
                    if (rule.source === RuleSource.Device) {
                        const isIncluded = whitelistedZones?.length ? zones?.some(zone => whitelistedZones.includes(zone)) : true;
                        const isExcluded = blacklistedZones?.length ? zones?.some(zone => blacklistedZones.includes(zone)) : false;

                        zonesOk = isIncluded && !isExcluded;

                        dataToReport = {
                            ...dataToReport,
                            zonesOk,
                            isIncluded,
                            isExcluded,
                        }
                    }

                    if (!zonesOk) {
                        logger.debug(`Zones ${zones} not ok`);
                        return false;
                    }

                    return true;
                });

                if (!!matches.length) {
                    for (const match of matches) {
                        let similarityOk = true;

                        if (clipDescription && clipDevice) {
                            // For now just go ahead if it's a raw detection and it has already embedding from NVR, 
                            // or if it's an NVR notification. Could add a configuration to always calculate embedding on clipped images
                            const canCheckSimilarity = (isRawDetection && match.embedding) || isFromNvr;
                            if (canCheckSimilarity) {
                                try {
                                    const similarityScore = await this.getEmbeddingSimilarityScore({
                                        deviceId: clipDevice?.id,
                                        text: clipDescription,
                                        image,
                                        imageEmbedding: match.embedding,
                                        detId: match.id
                                    });

                                    const threshold = similarityConcidenceThresholdMap[clipConfidence] ?? 0.25;
                                    if (similarityScore < threshold) {
                                        similarityOk = false;
                                    }

                                    logger.info(`Embedding similarity score for rule ${rule.name} (${clipDescription}): ${similarityScore} -> ${threshold}`);
                                } catch (e) {
                                    logger.error('Error calculating similarity', e);
                                }
                            } else {
                                similarityOk = false;
                            }
                        }

                        if (similarityOk) {
                            const matchRule = { match, rule, dataToReport };
                            matchRules.push(matchRule);
                            rule.detectionSource === ScryptedEventSource.RawDetection &&
                                this.accumulatedRules.push(matchRule);
                        }
                    }
                }
            }

            if (matchRules.length) {
                logger.info(`Matching rules found: ${getRulesLog(matchRules)}`);

                for (const matchRule of matchRules) {
                    try {
                        const { match, rule } = matchRule;
                        const isRawDetectionRule = (rule as DetectionRule).detectionSource === ScryptedEventSource.RawDetection;
                        const isNonRawDetection = !isRawDetection && !isRawDetectionRule;
                        const canUpdateMqttImage = isNonRawDetection && this.isDelayPassed({ type: DelayType.RuleImageUpdate, matchRule, eventSource })?.timePassed;

                        if (this.isActiveForMqttReporting) {
                            logger.info(`Publishing detection rule ${matchRule.rule.name} data, b64Image ${getB64ImageLog(b64Image)} skipMqttImage ${!canUpdateMqttImage}`);

                            this.triggerRule({
                                matchRule,
                                b64Image,
                                device: this.cameraDevice,
                                triggerTime,
                                skipMqttImage: !canUpdateMqttImage,
                                eventSource,
                            }).catch(logger.log);
                        }

                        if (isNonRawDetection && this.isDelayPassed({ type: DelayType.RuleNotification, matchRule, eventSource })?.timePassed) {
                            logger.log(`Starting notifiers for detection rule (${eventSource}) ${getDetectionKey(matchRule)}, b64Image ${getB64ImageLog(b64Image)} from ${imageSource} (Decoder)`);

                            this.plugin.notifyDetectionEvent({
                                triggerDeviceId: this.id,
                                match,
                                rule: rule as DetectionRule,
                                image,
                                eventType: detectionClassesDefaultMap[match.className],
                                triggerTime,
                            }).catch(logger.log);
                        }
                    } catch (e) {
                        logger.log(`Error processing matchRule ${JSON.stringify(matchRule)}`, e);
                    }
                }
            }
        } catch (e) {
            logger.log('Error finding a match', e);
        }
    }

    resetMqttMotionTimeout() {
        this.mqttDetectionMotionTimeout && clearTimeout(this.mqttDetectionMotionTimeout);
        this.mqttDetectionMotionTimeout = undefined;
    }

    resetRuleTriggerTimeout(ruleName: string) {
        this.detectionRuleListeners[ruleName]?.turnOffTimeout && clearTimeout(this.detectionRuleListeners[ruleName]?.turnOffTimeout);
        this.detectionRuleListeners[ruleName] = {
            ...this.detectionRuleListeners[ruleName],
            turnOffTimeout: undefined
        };
    }

    async startDoorbellListener() {
        try {
            const logger = this.getLogger();

            this.binaryListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.BinarySensor,
            }, async (_, __, data) => {
                const now = Date.now();

                if (data) {
                    const { image, imageSource, b64Image } = await this.getImage({ reason: GetImageReason.Sensor });
                    logger.log(`Doorbell event detected, image found ${imageSource}`);
                    const detections: ObjectDetectionResult[] = [{
                        className: DetectionClass.Doorbell,
                        score: 1,
                    }];

                    this.processDetections({
                        detect: { timestamp: now, detections },
                        eventSource: ScryptedEventSource.RawDetection,
                        image,
                    }).catch(logger.log);

                    this.plugin.storeEventImage({
                        b64Image,
                        detections: [{ className: DetectionClass.Doorbell, score: 1 }],
                        device: this.cameraDevice,
                        eventSource: ScryptedEventSource.RawDetection,
                        logger,
                        timestamp: now,
                        image,
                    }).catch(logger.error);
                } else {
                    this.resetDetectionEntities({
                        resetSource: 'MotionSensor',
                        classnames: [DetectionClass.Doorbell]
                    }).catch(logger.log);
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startBinaryListener', e);
        }
    }

    async startAudioVolumesListener() {
        try {
            const logger = this.getLogger();

            this.audioVolumesListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.AudioVolumeControl,
            }, async (_, __, data) => {
                logger.info(`Volume levels update: ${JSON.stringify(data)}`);

                if (data.dBFS) {
                    await this.processAudioDetection({
                        dBs: data.dBFS,
                        dev: data.dbStdDev
                    });
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startBinaryListener', e);
        }
    }

    async startAudioSensorListener() {
        try {
            const logger = this.getLogger();

            this.audioSensorListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.AudioSensor,
            }, async (_, __, data) => {
                const now = Date.now();

                if (data) {
                    const { image, imageSource, b64Image } = await this.getImage({ reason: GetImageReason.AudioTrigger });
                    logger.log(`Audio event detected, image found ${imageSource}`);
                    const detections: ObjectDetectionResult[] = [{
                        className: DetectionClass.Audio,
                        score: 1,
                    }];

                    this.processDetections({
                        detect: { timestamp: now, detections },
                        eventSource: ScryptedEventSource.RawDetection,
                        image,
                    }).catch(logger.log);

                    this.plugin.storeEventImage({
                        b64Image,
                        detections: [{ className: DetectionClass.Audio, score: 1 }],
                        device: this.cameraDevice,
                        eventSource: ScryptedEventSource.RawDetection,
                        logger,
                        timestamp: now,
                        image,
                    }).catch(logger.error);
                } else {
                    this.resetDetectionEntities({
                        resetSource: 'MotionSensor',
                        classnames: [DetectionClass.Doorbell]
                    }).catch(logger.log);
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startBinaryListener', e);
        }
    }

    async startObjectDetectionListeners() {
        try {
            const logger = this.getLogger();

            this.detectionListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.ObjectDetector,
            }, async (_, eventDetails, data) => {
                const detect: ObjectsDetected | FrigateObjectDetection = data;

                let eventSource = ScryptedEventSource.RawDetection;
                const frigateEvent = (detect as FrigateObjectDetection)?.frigateEvent;

                if (frigateEvent) {
                    eventSource = ScryptedEventSource.Frigate;
                }

                this.processDetections({ detect, eventDetails, eventSource }).catch(logger.log);
            });

            this.motionListener = systemManager.listenDevice(this.id, {
                event: ScryptedInterface.MotionSensor,
            }, async (_, __, data) => {
                const now = Date.now();
                const decoderType = this.decoderType;
                const shouldUseDecoder = decoderType === DecoderType.OnMotion;

                if (data) {
                    this.plugin.cameraMotionActive.add(this.id);
                    this.consumedDetectionIdsSet = new Set();
                    const timestamp = now;
                    const detections: ObjectDetectionResult[] = [{
                        className: 'motion',
                        score: 1,
                    }];
                    this.processDetections({ detect: { timestamp, detections }, eventSource: ScryptedEventSource.RawDetection }).catch(logger.log);

                    if (shouldUseDecoder) {
                        this.startDecoder('StartMotion').catch(logger.error);
                    }
                } else {
                    this.plugin.cameraMotionActive.delete(this.id);
                    this.consumedDetectionIdsSet = new Set();
                    this.lastMotionEnd = now;
                    this.resetDetectionEntities({
                        resetSource: 'MotionSensor'
                    }).catch(logger.log);

                    if (shouldUseDecoder) {
                        this.stopDecoder('EndMotion');
                    }
                }
            });
        } catch (e) {
            this.getLogger().log('Error in startObjectDetectionListeners', e);
        }
    }

    async resetDetectionEntities(props: {
        resetSource: 'MotionSensor' | 'Timeout',
        classnames?: DetectionClass[]
    }) {
        const { resetSource, classnames } = props;
        const isFromSensor = resetSource === 'MotionSensor';
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();

        if (!mqttClient) {
            return;
        }

        const funct = async () => {
            const isOnlyMotion = classnames?.length === 1 && classnames[0] === DetectionClass.Motion;
            logger.info(`Resetting basic detections ${classnames ?? 'All'}, signal coming from ${resetSource}`);

            await publishResetDetectionsEntities({
                mqttClient,
                device: this.cameraDevice,
                console: logger,
                classnames
            });
        };

        if (isFromSensor) {
            if (this.mqttDetectionMotionTimeout) {
                await funct();
                this.resetMqttMotionTimeout();
            }
        } else {
            this.resetMqttMotionTimeout();

            const { motionDuration } = this.storageSettings.values;
            this.mqttDetectionMotionTimeout = setTimeout(async () => {
                await funct();
            }, motionDuration * 1000);
        }
    }

    async resetRuleEntities(rule: BaseRule) {
        const logger = this.getLogger();
        const mqttClient = await this.getMqttClient();
        if (!mqttClient) {
            return;
        }

        const { motionDuration, } = this.storageSettings.values;

        const turnOffTimeout = setTimeout(async () => {
            logger.log(`Rule ${rule.name} trigger entities reset`);

            await publishResetRuleEntities({
                mqttClient,
                device: this.cameraDevice,
                console: logger,
                rule,
            });
        }, motionDuration * 1000);

        const ruleName = rule.name;
        this.resetRuleTriggerTimeout(ruleName);

        this.detectionRuleListeners[ruleName] = {
            ...this.detectionRuleListeners[ruleName],
            turnOffTimeout
        };
    }

    async getFrameGenerator() {
        const pipelines = getAllDevices().filter(d => d.interfaces.includes(ScryptedInterface.VideoFrameGenerator));
        const webassembly = sdk.systemManager.getDeviceById(NVR_PLUGIN_ID, 'decoder') || undefined;
        const ffmpeg = sdk.systemManager.getDeviceById(VIDEO_ANALYSIS_PLUGIN_ID, 'ffmpeg') || undefined;
        const use = (pipelines.find(p => p.name === 'Default') || webassembly || ffmpeg)

        return {
            pipelines,
            use,
        };
    }

    async createFrameGenerator(skipDecoder?: boolean): Promise<AsyncGenerator<VideoFrame, any, unknown>> {
        const logger = this.getLogger();
        const stream = await this.cameraDevice.getVideoStream({
            prebuffer: 0,
            destination: this.decoderStream,
            audio: null,
        });

        const frameGeneratorData = await this.getFrameGenerator();

        logger.info(`Camera decoder check: ${JSON.stringify({
            streamFound: !!stream,
            destination: this.decoderStream,
            frameGeneratorData,
            skipDecoder,
        })}`);

        if (!skipDecoder) {
            return stream as unknown as AsyncGenerator<VideoFrame, any, unknown>
        }

        const videoFrameGenerator = systemManager.getDeviceById<VideoFrameGenerator>(frameGeneratorData.use?.id);

        if (!videoFrameGenerator)
            throw new Error('invalid VideoFrameGenerator');

        try {
            return await videoFrameGenerator.generateVideoFrames(stream, {
                queue: 0,
            });
        }
        finally { }
    }
}
