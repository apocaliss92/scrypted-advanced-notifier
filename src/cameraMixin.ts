import sdk, { EventDetails, EventListenerRegister, Image, MediaObject, MediaStreamDestination, Notifier, ObjectDetection, ObjectDetectionResult, ObjectsDetected, PanTiltZoomCommand, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, Settings, VideoClip, VideoClipOptions, VideoClipThumbnailOptions, VideoClips, VideoFrame, VideoFrameGenerator } from "@scrypted/sdk";
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
import { objectDetectorNativeId } from '../../scrypted-frigate-bridge/src/utils';
import { Deferred } from "../../scrypted/server/src/deferred";
import { checkObjectsOccupancy } from "./aiUtils";
import { DetectionClass, defaultDetectionClasses, detectionClassesDefaultMap, isMotionClassname, isObjectClassname } from "./detectionClasses";
import { addBoundingBoxesToImage, addZoneClipPathToImage, cropImageToDetection } from "./drawingUtils";
import AdvancedNotifierPlugin from "./main";
import { idPrefix, publishBasicDetectionData, publishCameraValues, publishClassnameImages, publishOccupancy, publishPeopleData, publishResetDetectionsEntities, publishResetRuleEntities, publishRuleData, publishRuleEnabled, setupCameraAutodiscovery, subscribeToCameraMqttTopics } from "./mqtt-utils";
import { normalizeBox, polygonContainsBoundingBox, polygonIntersectsBoundingBox } from "./polygon";
import { ADVANCED_NOTIFIER_INTERFACE, AudioRule, BaseRule, DECODER_FRAME_MIN_TIME, DETECTION_CLIP_PREFIX, DecoderType, DelayType, DetectionRule, DeviceInterface, GetImageReason, ImagePostProcessing, ImageSource, IsDelayPassedProps, MatchRule, MixinBaseSettingKey, NVR_PLUGIN_ID, NotifyDetectionProps, NotifyRuleSource, ObserveZoneData, OccupancyRule, RuleSource, RuleType, SNAPSHOT_WIDTH, ScryptedEventSource, TIMELAPSE_CLIP_PREFIX, TimelapseRule, VIDEO_ANALYSIS_PLUGIN_ID, ZoneMatchType, b64ToMo, checkDetectionRuleMatches, convertSettingsToStorageSettings, filterAndSortValidDetections, getActiveRules, getAllDevices, getAudioRulesSettings, getB64ImageLog, getDetectionEventKey, getDetectionKey, getDetectionRulesSettings, getDetectionsLog, getDetectionsPerZone, getMixinBaseSettings, getOccupancyRulesSettings, getRuleKeys, getRulesLog, getTimelapseRulesSettings, getWebHookUrls, moToB64, splitRules } from "./utils";

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
    lastAudioDataFetched: number;
    observeZoneData: ObserveZoneData[];
    audioLabels: string[];
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
        public plugin: AdvancedNotifierPlugin
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
        const basicAudioDetector = systemManager.getDeviceById('@apocaliss92/scrypted-basic-object-detector', 'basicAudioDetector')?.id;
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
        if (basicAudioDetector && this.mixins.indexOf(basicAudioDetector) > thisMixinOrder) {
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
                            const zones = (await this.getObserveZones()).map(item => item.name);;

                            logger.log('Starting MQTT autodiscovery');
                            setupCameraAutodiscovery({
                                mqttClient,
                                device: this.cameraDevice,
                                console: logger,
                                rules: allAvailableRules,
                                occupancyEnabled: checkOccupancy,
                                zones
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

                            this.ensureMixinsOrder();

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
        const people = await this.plugin.getKnownPeople();
        const { frigateLabels, frigateZones } = await this.getFrigateData();
        const { labels: audioLabels } = await this.getAudioData();

        const detectionRulesSettings = await getDetectionRulesSettings({
            storage: this.storageSettings,
            zones,
            frigateZones,
            people,
            device: this,
            logger,
            frigateLabels,
            audioLabels,
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

    async getAudioData() {
        let labels: string[] = this.audioLabels;

        try {
            const now = new Date().getTime();
            const isUpdated = this.lastAudioDataFetched && (now - this.lastAudioDataFetched) <= (1000 * 60);

            if (!labels || !isUpdated) {
                this.lastAudioDataFetched = now;
                const settings = await this.mixinDevice.getSettings();
                const labelsSetting = settings.find((setting: { key: string; }) => setting.key === 'basicAudioDetector:detectionClasses')?.value ?? [];

                if (labelsSetting) {
                    labels = labelsSetting.value as string[];
                    this.audioLabels = labels;
                }
            }


        } catch (e) {
            this.getLogger().log('Error in getObserveZones', e);
        } finally {
            return { labels };
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

            if (this.isActiveForMqttReporting) {
                const mqttClient = await this.getMqttClient();
                if (mqttClient) {
                    try {
                        publishRuleData({
                            mqttClient,
                            device,
                            triggerValue: !skipTrigger ? true : undefined,
                            console: logger,
                            b64Image: timePassed ? b64Image : undefined,
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
            GetImageReason.ObjectUpdate,
        ].includes(reason);
        const tryDetector = !!detectionId && !!eventId;
        const onlyDetector = reason === GetImageReason.QuickNotification;
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

                if (onlyDetector) {
                    image = detectImage;
                } else {
                    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(detectImage, ScryptedMimeTypes.Image);
                    image = await convertedImage.toImage({
                        resize: {
                            width: SNAPSHOT_WIDTH,
                        },
                    });
                }
                imageSource = ImageSource.Detector;
            } catch (e) {
                logger.log(`Error finding the ${reason} image from the detector for detectionId ${detectionId} and eventId ${eventId} (${e.message})`);
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
                logger.debug(`Skipping snapshot image`, JSON.stringify({
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
                logger.debug(`Skipping decoder image`, JSON.stringify({
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
                logger.debug(`Skipping latest image`, JSON.stringify({
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
                } else if (onlyDetector) {
                    if (tryDetector) {
                        runners = [
                            checkDetector,
                        ];
                    }
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
            logger.debug(logPayload);
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

            const detectedResultParent = await sdk.connectRPCObject(
                await objectDetector.detectObjects(imageParent)
            );

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
                        const croppedImage = await convertedImage.toImage({
                            crop: {
                                left,
                                top,
                                width,
                                height,
                            },
                        });
                        detectedResult = await sdk.connectRPCObject(
                            await objectDetector.detectObjects(croppedImage)
                        );
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
                    matchRule: { rule, inputDimensions: [0, 0] },
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
                        matchRule: { rule, inputDimensions: [0, 0] } as MatchRule,
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
                            matchRule: { rule, inputDimensions: [0, 0] },
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
                    reason: GetImageReason.QuickNotification,
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
            try {
                // if (this.isActiveForMqttReporting) {
                //     const mqttClient = await this.getMqttClient();

                //     if (mqttClient) {
                //         const allowedDetections = detections.filter(detection => this.isDelayPassed({
                //             classname: detection.className,
                //             label: detection.label,
                //             type: DelayType.BasicDetectionImage,
                //             eventSource: ScryptedEventSource.RawDetection
                //         })?.timePassed);
                //         if (allowedDetections.length) {
                //             const classnamesString = getDetectionsLog(detections);

                //             logger.info(`Updating classname images ${classnamesString} with image source ${imageSource}`);

                //             const detectionsPerZone = getDetectionsPerZone(allowedDetections);
                //             await publishClassnameImages({
                //                 mqttClient,
                //                 console: logger,
                //                 detections: allowedDetections,
                //                 device: this.cameraDevice,
                //                 b64Image,
                //                 triggerTime,
                //                 detectionsPerZone
                //             }).catch(logger.error);
                //         }

                //     }
                // }

                // this.storeImagesOnFs({
                //     b64Image,
                //     detections,
                //     device: this.cameraDevice,
                //     triggerTime,
                //     prefix: 'object-detection',
                //     eventSource: ScryptedEventSource.RawDetection,
                // }).catch(logger.log);

                if (rulesToUpdate.length) {
                    logger.info(`Updating accumulated rules ${getRulesLog(rulesToUpdate)} with image source ${imageSource}`);
                    for (const matchRule of rulesToUpdate) {
                        const { match } = matchRule;

                        logger.info(`Publishing accumulated detection rule ${getDetectionKey(matchRule)} data, b64Image ${getB64ImageLog(b64Image)} from ${imageSource}. Has image ${!!image}`);

                        this.triggerRule({
                            matchRule,
                            skipTrigger: true,
                            b64Image,
                            device: this.cameraDevice,
                            triggerTime,
                            eventSource: ScryptedEventSource.RawDetection
                        }).catch(logger.log);

                        this.notifyDetectionRule({
                            triggerDeviceId: this.id,
                            eventSource: NotifyRuleSource.AccumulatedDetection,
                            matchRule,
                            imageData: {
                                image,
                                imageSource,
                            },
                            eventType: detectionClassesDefaultMap[match.className],
                            triggerTime,
                        }).catch(logger.log);
                    }
                }

                this.checkOccupancyData({
                    image,
                    b64Image,
                    source: 'Detections'
                }).catch(logger.log);

                if (!isOnlyMotion && this.runningTimelapseRules?.length) {
                    for (const rule of this.runningTimelapseRules) {
                        const classnamesString = getDetectionsLog(detections);
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
        } else {
            logger.debug(`Image not found for rules ${rulesToUpdate.map(rule => rule.rule.name).join(',')}`);
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

    public async executeImagePostProcessing(props: {
        image: MediaObject,
        matchRule: Partial<MatchRule>,
        shouldReDetect: boolean,
    }) {
        const { matchRule, image, shouldReDetect } = props;
        const { rule: ruleParent, match, inputDimensions: inputDimensionsParent } = matchRule;
        const rule = ruleParent as DetectionRule;
        const logger = this.getLogger(); const objectDetector: ObjectDetection & ScryptedDeviceBase = this.plugin.storageSettings.values.objectDetectionDevice;

        let processedImage: MediaObject;
        let processedB64Image: string;
        let error: string;

        if (image) {
            logger.info(`Post-processing set to ${rule.imageProcessing}, objectDetector is set to ${objectDetector ? objectDetector.name : 'NOT_DEFINED'}`);
            let inputDimensions = inputDimensionsParent;

            if (match && objectDetector && image) {
                let boundingBox = match.boundingBox;

                if (shouldReDetect) {
                    const detection = await sdk.connectRPCObject(
                        await objectDetector.detectObjects(image)
                    );
                    inputDimensions = detection.inputDimensions;
                    if (detection.detections.length) {
                        const matchingDetections = detection.detections.filter(det =>
                            det.className === match.className &&
                            (match.label ? det.label === match.label : true)
                        );

                        if (matchingDetections.length > 0) {
                            if (match.boundingBox) {
                                if (match.label) {
                                    boundingBox = matchingDetections[0].boundingBox;
                                } else {
                                    const [targetX, targetY] = match.boundingBox;
                                    let closestDetection = matchingDetections[0];
                                    let minDistance = Infinity;

                                    for (const det of matchingDetections) {
                                        const [detX, detY] = det.boundingBox;
                                        const distance = Math.sqrt(Math.pow(detX - targetX, 2) + Math.pow(detY - targetY, 2));

                                        if (distance < minDistance) {
                                            minDistance = distance;
                                            closestDetection = det;
                                        }
                                    }

                                    boundingBox = closestDetection.boundingBox;
                                }
                            } else {
                                boundingBox = matchingDetections[0].boundingBox;
                            }
                        }
                    } else {
                        logger.info(`Post-processing re-detection didn't find anything. ${JSON.stringify({
                            detection,
                            match,
                        })}`);
                        error = 'No detections re-detected';
                    }
                }

                if (boundingBox) {
                    try {
                        if (rule.imageProcessing === ImagePostProcessing.MarkBoundaries) {
                            const { newImage, newB64Image } = await addBoundingBoxesToImage({
                                image,
                                detections: [{
                                    ...match,
                                    boundingBox,
                                }],
                                inputDimensions,
                                plugin: this.plugin
                            });
                            processedB64Image = newB64Image;
                            processedImage = newImage;
                        } else if (rule.imageProcessing === ImagePostProcessing.Crop) {
                            try {
                                const { newB64Image, newImage } = await cropImageToDetection({
                                    image,
                                    boundingBox,
                                    inputDimensions,
                                    plugin: this.plugin
                                });

                                processedImage = newImage;
                                processedB64Image = newB64Image;
                            } catch (e) {
                                error = e.message;
                                logger.error('Failed to crop image', JSON.stringify({
                                    boundingBox,
                                    inputDimensions,
                                    error,
                                    matchRule,
                                }));

                            }
                        }
                    } catch (e) {
                        error = e.message;
                        logger.error(`Error during post-processing`, JSON.stringify({
                            boundingBox,
                            inputDimensions,
                            error
                        }), e);
                    }
                }
            }
        } else {
            logger.log(`Post-processing skipping, no image provided, ${JSON.stringify({
                matchRule,
            })}`);

            error = 'No image provided';
        }

        if (error) {
            logger.log(`Error during post-processing ${rule.imageProcessing}: ${error}`);
        }

        return {
            processedImage,
            processedB64Image,
            error
        };
    }

    public async notifyDetectionRule(props: NotifyDetectionProps) {
        const { matchRule, imageData, eventSource } = props;
        const logger = this.getLogger();
        const { rule } = matchRule;
        const { detectionSource, imageProcessing } = rule as DetectionRule;

        const { timePassed, lastSetInSeconds, minDelayInSeconds } = this.isDelayPassed({
            type: DelayType.RuleNotification,
            matchRule: matchRule as MatchRule,
        });

        if (timePassed) {
            const shouldReDetect = !imageData || imageData.imageSource !== ImageSource.Decoder;

            let decoderImage: MediaObject;
            let image: MediaObject;
            let imageSource: ImageSource;

            if (!imageData) {
                let { image: newImage, imageSource: newImageSource } = await this.getImage({
                    reason: GetImageReason.Notification
                });

                image = newImage;
                imageSource = newImageSource;
            } else {
                image = imageData.image;
                imageSource = imageData.imageSource;
                decoderImage = imageData.decoderImage;
            }

            let processingFailed = false;
            let imageToProcess: MediaObject;

            if (detectionSource === ScryptedEventSource.NVR) {
                if (imageProcessing === ImagePostProcessing.MarkBoundaries) {
                    imageToProcess = decoderImage;
                } else if (imageProcessing === ImagePostProcessing.FullFrame) {
                    image = decoderImage;
                }
            } else if (detectionSource === ScryptedEventSource.RawDetection) {
                if ([ImagePostProcessing.Crop, ImagePostProcessing.MarkBoundaries].includes(imageProcessing)) {
                    imageToProcess = image;
                }
            }

            if (imageToProcess) {
                const { error, processedImage } = await this.executeImagePostProcessing({
                    image,
                    matchRule,
                    shouldReDetect,
                });

                image = processedImage;
                processingFailed = !!error;
            }

            if (processingFailed) {
                logger.log(`Post-processing failed. Skipping notification and resetting delay to allow new detections to come through`);
                const delayKey = this.isDelayPassed({
                    type: DelayType.RuleNotification,
                    matchRule: matchRule as MatchRule,
                })?.delayKey;

                this.lastDelaySet[delayKey] = undefined;

                return;
            } else {
                logger.log(`Post-processing ${rule.imageProcessing} successful`);
                logger.log(`Starting notifiers for detection rule (${eventSource}) ${getDetectionKey(matchRule as MatchRule)}, image from ${imageSource}, last check ${lastSetInSeconds ? lastSetInSeconds + 's ago' : '-'} with delay ${minDelayInSeconds}s`);

                await this.plugin.notifyDetectionEvent({
                    ...props,
                    imageData: {
                        image,
                        imageSource
                    }
                });
            }
        }
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
        } else if (type === DelayType.RuleMinCheck) {
            const { rule } = props;

            delayKey += `-${rule.name}`;
            minDelayInSeconds = 3;
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

            // delayKey += `-${identifiers.join('_')}`;
            if (identifiers.length === 1 && isMotionClassname(identifiers[0])) {
                delayKey = `${DelayType.EventStore}_motion`;
                minDelayInSeconds = 30;
            } else {
                delayKey = `${DelayType.EventStore}`;
                minDelayInSeconds = 6;
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
            delayKey,
        }
    }

    public async processDetections(props: {
        detect: ObjectsDetected,
        eventDetails?: EventDetails,
        image?: MediaObject,
        eventSource?: ScryptedEventSource
    }) {
        const { detect, eventDetails, image: parentImage, eventSource } = props;
        const isDetectionFromNvr = eventSource === ScryptedEventSource.NVR;
        const isDetectionFromFrigate = eventSource === ScryptedEventSource.Frigate;
        const isDetectionRawDetection = eventSource === ScryptedEventSource.RawDetection;
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
        } = filterAndSortValidDetections({
            detect,
            logger,
            consumedDetectionIdsSet: new Set(),
        });
        const originalCandidates = cloneDeep(candidates);

        if (eventDetails && this.processDetectionsInterval) {
            this.accumulatedDetections.push({
                detect: {
                    ...detect,
                    detections: cloneDeep(candidates)
                },
                eventId: eventDetails.eventId,
                eventSource,
            });
        }

        let croppedNvrImage: MediaObject;
        let croppedNvrB64Image: string;
        let decoderImage: MediaObject;
        let decoderB64Image: string;

        if (parentImage && isDetectionFromNvr) {
            croppedNvrImage = parentImage;
            croppedNvrB64Image = await moToB64(parentImage);
        }

        if (eventDetails?.eventId && detect?.detectionId) {
            const classnamesLog = getDetectionsLog(detections);
            const withEmbeddings = detect.detections.filter(det => !!det.embedding);

            const { b64Image: decoderB64ImagFound, image: decoderImageFound } = await this.getImage({
                eventId: eventDetails?.eventId,
                detectionId: detect?.detectionId,
                reason: GetImageReason.QuickNotification
            });

            decoderB64Image = decoderB64ImagFound;
            decoderImage = decoderImageFound;

            logger.info(`${eventSource} detections received, classnames ${classnamesLog}, with embedding: ${withEmbeddings.length ? getDetectionsLog(withEmbeddings) : 'None'}`);
        }

        try {
            const canUpdateMqtt = eventSource === detectionSourceForMqtt;
            // Here should be changed the MQTT image to post-process, when available
            let mqttFsImage: MediaObject;
            let mqttFsB64Image: string;
            let mqttFsImageSource = ImageSource.NotFound;

            if (this.isActiveForMqttReporting && canUpdateMqtt) {
                if (eventSource === ScryptedEventSource.NVR) {
                    mqttFsImage = croppedNvrImage;
                    mqttFsB64Image = croppedNvrB64Image;
                    mqttFsImageSource = ImageSource.Input;
                } else if (decoderImage) {
                    mqttFsImage = decoderImage;
                    mqttFsB64Image = decoderB64Image;
                    mqttFsImageSource = ImageSource.Decoder;
                }

                const mqttClient = await this.getMqttClient();

                if (mqttClient) {
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
                        if (mqttFsImageSource === ImageSource.NotFound) {
                            const { b64Image: b64ImageNew, image: imageNew, imageSource: imageSourceNew } = await this.getImage({
                                reason: isDetectionFromFrigate ? GetImageReason.FromFrigate : GetImageReason.MotionUpdate,
                            });

                            mqttFsImage = imageNew;
                            mqttFsB64Image = b64ImageNew;
                            mqttFsImageSource = imageSourceNew;
                        }

                        logger.info(`Triggering basic detections ${getDetectionsLog(spamBlockedDetections)}`);
                        const detectionsPerZone = getDetectionsPerZone(spamBlockedDetections);

                        for (const detection of spamBlockedDetections) {
                            const { className, label } = detection;

                            publishBasicDetectionData({
                                mqttClient,
                                console: logger,
                                detection,
                                detectionsPerZone,
                                device: this.cameraDevice,
                                triggerTime,
                            }).catch(logger.error);

                            if (mqttFsB64Image) {
                                const { timePassed } = this.isDelayPassed({
                                    classname: className,
                                    label,
                                    eventSource,
                                    type: DelayType.BasicDetectionImage,
                                });

                                if (timePassed) {
                                    logger.info(`Updating image for classname ${className} source: ${eventSource ? 'NVR' : 'Decoder'}`);
                                    const detectionsPerZone = getDetectionsPerZone([detection]);

                                    publishClassnameImages({
                                        mqttClient,
                                        console: logger,
                                        detections: [detection],
                                        device: this.cameraDevice,
                                        b64Image: mqttFsB64Image,
                                        triggerTime,
                                        detectionsPerZone,
                                    }).catch(logger.error);
                                }
                            }
                        }

                        this.resetDetectionEntities({
                            resetSource: 'Timeout'
                        }).catch(logger.log);
                    }

                    if (
                        isDetectionFromNvr &&
                        croppedNvrB64Image &&
                        facesFound.length &&
                        this.cameraDevice.room
                    ) {
                        publishPeopleData({
                            mqttClient,
                            console: logger,
                            faces: facesFound,
                            b64Image: croppedNvrB64Image,
                            room: this.cameraDevice.room,
                            imageSource: ImageSource.Input,
                        }).catch(logger.error);
                    }
                }
            }

            if (mqttFsB64Image) {
                this.storeImagesOnFs({
                    b64Image: mqttFsB64Image,
                    detections: candidates,
                    device: this.cameraDevice,
                    triggerTime,
                    prefix: 'object-detection',
                    suffix: !isDetectionRawDetection ? eventSource : undefined,
                    eventSource
                }).catch(logger.log);
            }

            if (decoderB64Image && decoderImage && this.plugin.storageSettings.values.storeEvents) {
                logger.info(`Storing ${eventSource} event image: ${JSON.stringify({
                    detections,
                    candidates,
                })}`);

                const eventId = getDetectionEventKey({ detectionId: detect?.detectionId, eventId: eventDetails?.eventId });

                this.plugin.storeEventImage({
                    b64Image: decoderB64Image,
                    detections: originalCandidates,
                    device: this.cameraDevice,
                    eventSource,
                    logger,
                    timestamp: triggerTime,
                    image: decoderImage,
                    eventId,
                }).catch(logger.error);
            }
        } catch (e) {
            logger.log('Error parsing detections', e);
        }

        try {
            const rules = cloneDeep(
                this.runningDetectionRules.filter(rule =>
                    rule.detectionSource === eventSource && rule.currentlyActive && rule.detectionClasses?.length
                )
            ) ?? [];

            logger.debug(`Detections incoming ${JSON.stringify({
                candidates,
                detect,
                minDelayTime,
                ignoreCameraDetections,
                rules,
            })}`);

            for (const rule of rules) {
                const ruleImage = isDetectionFromNvr ? croppedNvrImage : decoderImage;
                const ruleB64Image = isDetectionFromNvr ? croppedNvrB64Image : decoderB64Image;

                // if (!this.isDelayPassed({
                //     type: DelayType.RuleMinCheck,
                //     rule,
                // })?.timePassed) {
                //     continue
                // }

                const { dataToReport, matchRules } = await checkDetectionRuleMatches({
                    rule,
                    candidates,
                    ignoreCameraDetections,
                    isAudioEvent,
                    logger,
                    detect,
                    eventSource,
                    image: ruleImage,
                    plugin: this.plugin,
                });

                if (matchRules.length) {
                    ruleImage && logger.info(`checkDetectionRuleMatches result ${JSON.stringify(dataToReport)}`);
                    for (const matchRule of matchRules) {
                        if (ruleImage) {
                            this.notifyDetectionRule({
                                triggerDeviceId: this.id,
                                eventSource: NotifyRuleSource.Decoder,
                                matchRule,
                                imageData: {
                                    image: ruleImage,
                                    decoderImage,
                                    imageSource: ImageSource.Decoder,
                                },
                                eventType: detectionClassesDefaultMap[matchRule.match.className],
                                triggerTime,
                            }).catch(logger.log);
                        } else {
                            this.accumulatedRules.push(matchRule);
                        }

                        if (this.isActiveForMqttReporting) {
                            logger.info(`Publishing detection rule ${matchRule.rule.name} data, b64Image ${getB64ImageLog(ruleB64Image)}`);

                            this.triggerRule({
                                matchRule,
                                b64Image: ruleB64Image,
                                device: this.cameraDevice,
                                triggerTime,
                                eventSource,
                            }).catch(logger.log);
                        }
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
                const detect: ObjectsDetected = data;

                let eventSource = ScryptedEventSource.RawDetection;
                const frigateEvent = (detect as any)?.frigateEvent;

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
            logger.info(`Resetting basic detections ${classnames ?? 'All'}, signal coming from ${resetSource}`);
            const zones = (await this.getObserveZones()).map(item => item.name);;

            await publishResetDetectionsEntities({
                mqttClient,
                device: this.cameraDevice,
                console: logger,
                classnames,
                zones
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
            logger.info(`Rule ${rule.name} trigger entities reset`);

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
