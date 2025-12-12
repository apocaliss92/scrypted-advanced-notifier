import sdk, { BinarySensor, Camera, DeviceBase, EntrySensor, HttpRequest, ImageEmbedding, LockState, MediaObject, Notifier, NotifierOptions, ObjectDetectionResult, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, Point, Reboot, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SecuritySystem, SecuritySystemMode, Settings, TextEmbedding, VideoCamera } from "@scrypted/sdk";
import { SettingsMixinDeviceBase } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDevice, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import crypto from 'crypto';
import { cloneDeep, set, sortBy, uniq, uniqBy } from "lodash";
import moment, { Moment } from "moment";
import { logLevelSetting } from "../../scrypted-apocaliss-base/src/basePlugin";
import { FRIGATE_OBJECT_DETECTOR_INTERFACE, pluginId } from '../../scrypted-frigate-bridge/src/utils';
import { loginScryptedClient } from "../../scrypted/packages/client/src";
import { name, scrypted } from '../package.json';
import { basicDetectionClasses, classnamePrio, defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isFaceClassname, isLabelDetection, isPlateClassname } from "./detectionClasses";
import AdvancedNotifierPlugin, { PluginSettingKey } from "./main";
import { detectionClassForObjectsReporting } from "./mqtt-utils";
const { endpointManager } = sdk;
import fs from 'fs';
import path from 'path';

export type DeviceInterface = ScryptedDevice & Camera & ScryptedDeviceBase & Notifier & Settings & ObjectDetector & VideoCamera & EntrySensor & Lock & BinarySensor & Reboot & PanTiltZoom & OnOff;
export const ADVANCED_NOTIFIER_INTERFACE = name;
export const ADVANCED_NOTIFIER_CAMERA_INTERFACE = `${ADVANCED_NOTIFIER_INTERFACE}:Camera`;
export const ADVANCED_NOTIFIER_NOTIFIER_INTERFACE = `${ADVANCED_NOTIFIER_INTERFACE}:Notifier`;
export const ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE = `${ADVANCED_NOTIFIER_INTERFACE}:SecuritySystem`;
export const PUSHOVER_PLUGIN_ID = '@scrypted/pushover';
export const NTFY_PLUGIN_ID = '@apocaliss92/ntfy';
export const TELEGRAM_PLUGIN_ID = '@apocaliss92/scrypted-telegram';
export const ZENTIK_PLUGIN_ID = '@apocaliss92/scrypted-zentik';
export const NVR_PLUGIN_ID = '@scrypted/nvr';
export const VIDEO_ANALYSIS_PLUGIN_ID = '@scrypted/objectdetector';
export const HOMEASSISTANT_PLUGIN_ID = '@scrypted/homeassistant';
export const EVENTS_RECORDER_PLUGIN_ID = '@apocaliss92/scrypted-events-recorder';
export const FRIGATE_BRIDGE_PLUGIN_ID = '@apocaliss92/scrypted-frigate-bridge';
export const NVR_NOTIFIER_INTERFACE = `${NVR_PLUGIN_ID}:Notifier`;
export const SNAPSHOT_WIDTH = 1280;
export const ADVANCED_NOTIFIER_PLUGIN_NAME = scrypted.name;
export const SCRYPTED_NVR_OBJECT_DETECTION_NAME = 'Scrypted NVR Object Detection';
export const NOTIFIER_NATIVE_ID = 'advancedNotifierDefaultNotifier';
export const CAMERA_NATIVE_ID = 'advancedNotifierCamera';
export const ALARM_SYSTEM_NATIVE_ID = 'advancedNotifierAlarmSystem';
export const DATA_FETCHER_NATIVE_ID = 'advancedNotifierDataFetcher';
export const MAX_PENDING_RESULT_PER_CAMERA = 5;
export const MAX_RPC_OBJECTS_PER_PLUGIN = 200;
export const MAX_RPC_OBJECTS_PER_CAMERA = 35;
export const SOFT_RPC_OBJECTS_PER_PLUGIN = 100;
export const SOFT_RPC_OBJECTS_PER_CAMERA = 20;
export const MAX_RPC_OBJECTS_PER_SENSOR = 10;
export const SOFT_RPC_OBJECTS_PER_SENSOR = 5;
export const MAX_RPC_OBJECTS_PER_NOTIFIER = 7;
export const SOFT_RPC_OBJECTS_PER_NOTIFIER = 3;
export const SOFT_MIN_RPC_OBJECTS = 200;
export const HARD_MIN_RPC_OBJECTS = 300;
export const FRIGATE_BRIDGE_PLUGIN_NAME = 'Frigate bridge';
export const EVENTS_RECORDER_PLUGIN_NAME = 'Events recorder';

const readdirCache: Record<string, { timestamp: number, files: string[] }> = {};
const fsCacheDurationSeconds = 10;

export const cachedReaddir = async (path: string): Promise<string[]> => {
    const now = Date.now();
    if (readdirCache[path] && (now - readdirCache[path].timestamp < (fsCacheDurationSeconds * 1000))) {
        return readdirCache[path].files;
    }

    const files = await fs.promises.readdir(path);
    readdirCache[path] = {
        timestamp: now,
        files
    };
    return files;
}

export const formatSize = (size: number, unit?: 'MB' | 'GB') => {
    let unitToUse = unit;
    const sizeInMb = size / (1024 * 1024);
    if (!unitToUse) {
        if (sizeInMb < 1000) {
            unitToUse = 'MB';
        } else {
            unitToUse = 'GB';
        }
    }

    let value = sizeInMb;

    if (unitToUse === 'GB') {
        value = sizeInMb / 1024
    }
    const formatted = `${value.toFixed(2)} ${unitToUse}`;

    return {
        formatted,
        unit: unitToUse,
        value: Number(value.toFixed(2)),
    }
}

export enum DevNotifications {
    ConfigCheckError = 'ConfigCheckError',
    SoftRestart = 'SoftRestart',
}

export enum RuleActionType {
    Wait = 'Wait',
    Ptz = 'Ptz',
    Lock = 'Lock',
    Switch = 'Switch',
    Entry = 'Entry',
    Script = 'Script',
}

export type RuleAction = {
    actionName: string;
    deviceId: string;
} &
    ({
        type: RuleActionType.Wait;
        seconds: number;
    } |
    {
        type: RuleActionType.Ptz;
        presetName: string;
    } |
    {
        type: RuleActionType.Switch;
        turnOn: boolean;
    } |
    {
        type: RuleActionType.Entry;
        openEntry: boolean;
    } |
    {
        type: RuleActionType.Script;
    } |
    {
        type: RuleActionType.Lock;
        lock: boolean;
    });

export interface RuleActionsSequence {
    name: string;
    enabled: boolean;
    minimumExecutionDelay: number;
    actions: RuleAction[];
}

export const getAssetSource = (props: { videoUrl?: string, sourceId?: string }) => {
    const { sourceId, videoUrl } = props;

    const findFlags = () => {
        if (sourceId) {
            const eventsRecorderId = sdk.systemManager.getDeviceByName(EVENTS_RECORDER_PLUGIN_NAME)?.id;
            const frigateBridgeId = sdk.systemManager.getDeviceByName(FRIGATE_BRIDGE_PLUGIN_NAME)?.id;
            const advancedNotifierId = sdk.systemManager.getDeviceByName(ADVANCED_NOTIFIER_PLUGIN_NAME)?.id;

            const isEventsRecorder = eventsRecorderId && eventsRecorderId === sourceId;
            const isFrigateBridge = frigateBridgeId && frigateBridgeId === sourceId;
            const isAdvancedNotifier = advancedNotifierId && advancedNotifierId === sourceId;
            const isNvr = !isEventsRecorder && !isFrigateBridge && !isAdvancedNotifier;

            return {
                isEventsRecorder,
                isFrigateBridge,
                isAdvancedNotifier,
                isNvr,
            };
        } else if (videoUrl) {

            const isEventsRecorder = videoUrl.includes(EVENTS_RECORDER_PLUGIN_ID);
            const isFrigateBridge = videoUrl.includes(FRIGATE_BRIDGE_PLUGIN_ID);
            const isAdvancedNotifier = videoUrl.includes(ADVANCED_NOTIFIER_INTERFACE);
            const isNvr = videoUrl.includes(NVR_PLUGIN_ID);

            return {
                isEventsRecorder,
                isFrigateBridge,
                isAdvancedNotifier,
                isNvr,
            };
        }
    }

    const flags = findFlags();
    return {
        ...flags,
    }
}

export enum NotifyRuleSource {
    AccumulatedDetection = 'AccumulatedDetection',
    Decoder = 'Decoder',
    Test = 'Test',
    Sensor = 'Sensor',
}

export interface SnoozeItem {
    text: string,
    minutes: number,
}

export interface ImageData {
    fullFrameImage?: MediaObject,
    croppedImage?: MediaObject,
    image?: MediaObject,
    imageSource: ImageSource,
}

export interface NotifyDetectionProps {
    eventType: DetectionEvent,
    triggerDeviceId: string,
    snoozeId?: string,
    forceExecution?: boolean,
    triggerTime: number,
    forceAi?: boolean,
    matchRule: Partial<MatchRule>;
    eventSource: NotifyRuleSource;
    imageData?: ImageData
}

export enum ScryptedEventSource {
    Default = 'Default',
    RawDetection = 'RawDetection',
    NVR = 'NVR',
    Frigate = 'Frigate'
}

export enum AssetOriginSource {
    CloudSecure = 'CloudSecure',
    LocalSecure = 'LocalSecure',
    LocalInsecure = 'LocalInsecure',
    Custom = 'Custom',
}

export interface ObserveZoneData {
    name: string;
    path: Point[]
};

export interface MatchRule {
    match?: ObjectDetectionResult,
    rule: BaseRule,
    inputDimensions: [number, number],
    dataToReport?: any
}

export enum DecoderType {
    Auto = 'Auto',
    Off = 'Off',
    OnMotion = 'OnMotion',
    Always = 'Always',
}

export enum SimilarityConfidence {
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
}

export const similarityConcidenceThresholdMap: Record<SimilarityConfidence, number> = {
    [SimilarityConfidence.Low]: 0.22,
    [SimilarityConfidence.Medium]: 0.26,
    [SimilarityConfidence.High]: 0.30,
}

export enum DelayType {
    DecoderFrameOnStorage = 'DecoderFrameOnStorage',
    BasicDetectionImage = 'BasicDetectionImage',
    BasicDetectionTrigger = 'BasicDetectionTrigger',
    PeopleTrackerImageUpdate = 'PeopleTrackerImageUpdate',
    RuleImageUpdate = 'RuleImageUpdate',
    RuleNotification = 'RuleNotification',
    RuleMinCheck = 'RuleMinCh',
    OccupancyNotification = 'OccupancyNotification',
    FsImageUpdate = 'FsImageUpdate',
    EventStore = 'EventStore',
    PostWebhookImage = 'PostWebhookImage',
    OccupancyRegularCheck = 'OccupancyRegularCheck',
    SequenceExecution = 'SequenceExecution',
    EventRecording = 'EventRecording',
}

export enum GetImageReason {
    Sensor = 'Sensor',
    RulesRefresh = 'RulesRefresh',
    AudioTrigger = 'AudioTrigger',
    MotionUpdate = 'MotionUpdate',
    ObjectUpdate = 'ObjectUpdate',
    FromNvr = 'FromNvr',
    QuickNotification = 'QuickNotification',
    FromFrigate = 'FromFrigate',
    Notification = 'Notification',
    AccumulatedDetections = 'AccumulatedDetections',
    Test = 'Test',
}

export enum ImageSource {
    NotFound = 'NotFound',
    Input = 'Input',
    Snapshot = 'Snapshot',
    Latest = 'Latest',
    Detector = 'Detector',
    Decoder = 'Decoder',
    Frigate = 'Frigate',
}

export enum VideoclipSpeed {
    SuperSlow = 'SuperSlow',
    Slow = 'Slow',
    Realtime = 'Realtime',
    Fast = 'Fast',
    SuperFast = 'SuperFast',
}

export enum VideoclipType {
    MP4 = 'MP4',
    GIF = 'GIF',
}
const defaultVideoclipType = VideoclipType.GIF;
export const defaultClipPreSeconds = 5;
export const defaultOccupancyClipPreSeconds = 12;
export const defaultClipPostSeconds = 5;

export const videoclipSpeedMultiplier: Record<VideoclipSpeed, number> = {
    [VideoclipSpeed.SuperSlow]: 0.25,
    [VideoclipSpeed.Slow]: 0.5,
    [VideoclipSpeed.Realtime]: 1,
    [VideoclipSpeed.Fast]: 2,
    [VideoclipSpeed.SuperFast]: 4
}

export type IsDelayPassedProps =
    { type: DelayType.OccupancyRegularCheck } |
    { type: DelayType.SequenceExecution, delay: number, postFix: string } |
    { type: DelayType.DecoderFrameOnStorage, eventSource: ScryptedEventSource, timestamp: number } |
    { type: DelayType.EventStore, identifiers: string[] } |
    { type: DelayType.PeopleTrackerImageUpdate, label: string } |
    { type: DelayType.BasicDetectionImage, classname: string, label?: string, eventSource: ScryptedEventSource } |
    { type: DelayType.BasicDetectionTrigger, classname: string, label?: string, eventSource: ScryptedEventSource } |
    { type: DelayType.FsImageUpdate, filename: string } |
    { type: DelayType.OccupancyNotification, matchRule: MatchRule, eventSource: ScryptedEventSource } |
    { type: DelayType.PostWebhookImage, classname: string, eventSource: ScryptedEventSource } |
    { type: DelayType.RuleImageUpdate, matchRule: MatchRule, eventSource: ScryptedEventSource } |
    { type: DelayType.RuleNotification, matchRule: MatchRule } |
    { type: DelayType.RuleMinCheck, rule: BaseRule } |
    { type: DelayType.EventRecording, minDelay: number };

export const getElegibleDevices = (isFrigate?: boolean) => {
    const allDevices = Object.keys(sdk.systemManager.getSystemState()).map(deviceId => sdk.systemManager.getDeviceById<DeviceInterface>(deviceId));

    return allDevices.filter(device => {
        const { isSupported, isNotifier } = isDeviceSupported(device);
        const mainSupported = isSupported && !isNotifier && device.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE);
        if (isFrigate) {
            return mainSupported && device.interfaces.includes(FRIGATE_OBJECT_DETECTOR_INTERFACE);
        } else {
            return mainSupported;
        }
    })
}

export const getDefaultEntityId = (name: string) => {
    const convertedName = name?.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_') ?? 'not_set';

    return `binary_sensor.${convertedName}_notification_triggered`;
}

export const safeParseJson = <T = any>(maybeStringValue: string | object, fallback?: any) => {
    try {
        return (typeof maybeStringValue === 'string' ? JSON.parse(maybeStringValue) : maybeStringValue) ?? fallback as T;
    } catch {
        return maybeStringValue;
    }
}


export const getWebhooks = async () => {
    const lastSnapshot = 'snapshot';
    const haAction = 'haAction';
    const snoozeNotification = 'snoozeNotification';
    const postNotification = 'postNotification';
    const setAlarm = 'setAlarm';
    const imageRule = 'imageRule';
    const videoRule = 'videoRule';
    const recordedClipVideo = 'recordedClipVideo';
    const recordedClipThumbnail = 'recordedClipThumbnail';
    const gifRule = 'gifRule';
    const eventThumbnail = 'eventThumbnail';
    const eventImage = 'eventImage';
    const eventsApp = 'eventsApp';
    const eventVideoclip = 'eventVideoclip';

    return {
        recordedClipVideo,
        recordedClipThumbnail,
        lastSnapshot,
        haAction,
        snoozeNotification,
        postNotification,
        setAlarm,
        imageRule,
        videoRule,
        gifRule,
        eventThumbnail,
        eventImage,
        eventsApp,
        eventVideoclip,
    };
}

export const isDetectionRule = (rule: BaseRule) => [
    RuleType.Audio,
    RuleType.Detection,
].includes(rule.ruleType);

export const getAssetsParams = async (props: {
    plugin: AdvancedNotifierPlugin,
}) => {
    try {
        const { plugin } = props;
        const logger = plugin.getLogger();
        const { assetsOriginSource } = plugin.storageSettings.values;
        const localEndpoint = await sdk.endpointManager.getLocalEndpoint(undefined, { public: true });
        const cloudEndpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });

        const localEndpointRaw = await sdk.endpointManager.getLocalEndpoint(undefined, { public: true });
        const cloudEndpointRaw = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
        let endpointRaw;

        if (assetsOriginSource === AssetOriginSource.LocalSecure) {
            endpointRaw = localEndpointRaw;
        } else if (assetsOriginSource === AssetOriginSource.CloudSecure && plugin.hasCloudPlugin) {
            endpointRaw = cloudEndpointRaw;
        } else if (assetsOriginSource === AssetOriginSource.LocalInsecure) {
            endpointRaw = await sdk.endpointManager.getLocalEndpoint(undefined, { public: true, insecure: true });
        } else if (assetsOriginSource === AssetOriginSource.Custom) {
            const customOrigin = plugin.storageSettings.values.customOriginUrl;
            if (customOrigin) {
                endpointRaw = customOrigin;
            } else {
                logger.error('Custom origin URL is not set, falling back to local secure endpoint.');
                endpointRaw = localEndpointRaw;
            }
        }

        const endpointUrl = new URL(endpointRaw);
        const assetsOrigin = endpointUrl.origin;
        const userToken = endpointUrl.searchParams.get('user_token');

        const localEndpointUrl = new URL(localEndpointRaw);
        const localAssetsOrigin = localEndpointUrl.origin;

        const cloudEndpointUrl = new URL(cloudEndpointRaw);
        const cloudAssetsOrigin = cloudEndpointUrl.origin;

        const { privateKey } = plugin.storageSettings.values;
        const searchParams = new URLSearchParams();
        searchParams.set('secret', privateKey);
        if (userToken) {
            searchParams.set('user_token', userToken);
        }
        const paramString = `${searchParams.toString()}`;

        const privatePathname = await endpointManager.getPath(undefined, { public: false });
        const publicPathnamePrefix = await endpointManager.getPath(undefined, { public: true });

        return {
            paramString,
            assetsOrigin,
            cloudAssetsOrigin,
            localAssetsOrigin,
            localEndpoint,
            cloudEndpoint,
            privatePathname,
            publicPathnamePrefix
        };
    } catch {
        return {}
    }
}

export const getWebHookUrls = async (props: {
    cameraIdOrAction?: string,
    console?: Console,
    device?: ScryptedDeviceBase,
    snoozeId?: string,
    snoozeItems?: SnoozeItem[],
    fileId?: string,
    plugin: AdvancedNotifierPlugin,
    ruleName?: string,
}) => {
    const {
        cameraIdOrAction,
        console,
        device,
        snoozeId,
        fileId,
        snoozeItems,
        plugin,
        ruleName
    } = props;

    let lastSnapshotCloudUrl: string;
    let lastSnapshotLocalUrl: string;
    let haActionUrl: string;
    let postNotificationUrl: string;
    let endpoint: string;
    let imageRuleUrl: string;
    let gifRuleUrl: string;
    let videoRuleUrl: string;
    let eventThumbnailUrl: string;
    let eventImageUrl: string;
    let eventVideoclipUrl: string;
    let privatePathnamePrefix: string;
    let recordedClipVideoPath: string;
    let recordedClipThumbnailPath: string;

    const snoozeActions: ExtendedNotificationAction[] = [];

    const {
        lastSnapshot,
        haAction,
        snoozeNotification,
        postNotification,
        eventThumbnail,
        imageRule,
        videoRule,
        gifRule,
        eventImage,
        eventVideoclip,
        eventsApp,
        recordedClipThumbnail,
        recordedClipVideo,
    } = await getWebhooks();

    try {
        const encodedId = encodeURIComponent(cameraIdOrAction ?? device?.id);

        const {
            assetsOrigin,
            cloudEndpoint,
            paramString: paramStringParent,
            localEndpoint,
            privatePathname,
            publicPathnamePrefix,
        } = await getAssetsParams({ plugin });

        const paramString = plugin.storageSettings.values.includeUserToken ?
            paramStringParent :
            '';

        lastSnapshotCloudUrl = `${cloudEndpoint}${lastSnapshot}/${encodedId}/{IMAGE_NAME}?${paramString}`;
        lastSnapshotLocalUrl = `${localEndpoint}${lastSnapshot}/${encodedId}/{IMAGE_NAME}?${paramString}`;
        haActionUrl = `${assetsOrigin}${publicPathnamePrefix}${haAction}/${encodedId}?${paramString}`;
        postNotificationUrl = `${assetsOrigin}${publicPathnamePrefix}${postNotification}/${encodedId}?${paramString}`;

        recordedClipThumbnailPath = `${assetsOrigin}${publicPathnamePrefix}${recordedClipThumbnail}/${encodedId}/recordings/${fileId}.jpg?${paramString}`;
        recordedClipVideoPath = `${assetsOrigin}${publicPathnamePrefix}${recordedClipVideo}/${encodedId}/recordings/${fileId}.mp4?${paramString}`;

        imageRuleUrl = `${assetsOrigin}${publicPathnamePrefix}${imageRule}/${encodedId}/${ruleName}/${fileId}.jpg?${paramString}`;
        videoRuleUrl = `${assetsOrigin}${publicPathnamePrefix}${videoRule}/${encodedId}/${ruleName}/${fileId}.mp4?${paramString}`;
        gifRuleUrl = `${assetsOrigin}${publicPathnamePrefix}${gifRule}/${encodedId}/${ruleName}/${fileId}.gif?${paramString}`;

        privatePathnamePrefix = `${privatePathname}${eventsApp}`;
        eventThumbnailUrl = `${privatePathnamePrefix}/${eventThumbnail}/${device?.id}/${fileId}`;
        eventImageUrl = `${privatePathnamePrefix}/${eventImage}/${device?.id}/${fileId}`;
        eventVideoclipUrl = `${privatePathnamePrefix}/${eventVideoclip}/${device?.id}/${fileId}`;

        if (snoozeId && snoozeItems) {
            for (const snooze of snoozeItems) {
                const { minutes, text } = snooze;

                snoozeActions.push({
                    url: `${assetsOrigin}${publicPathnamePrefix}${snoozeNotification}/${encodedId}/${snoozeId}/${minutes}?${paramString}`,
                    title: text,
                    action: `snooze${minutes}`,
                    data: minutes,
                });
            }
        }
    } catch (e) {
        console?.log('Error fetching webhookUrls', e.message);
    }

    return {
        lastSnapshotCloudUrl,
        lastSnapshotLocalUrl,
        haActionUrl,
        snoozeActions,
        postNotificationUrl,
        endpoint,
        imageRuleUrl,
        gifRuleUrl,
        videoRuleUrl,
        eventThumbnailUrl,
        eventImageUrl,
        eventVideoclipUrl,
        privatePathnamePrefix,
        recordedClipThumbnailPath,
        recordedClipVideoPath,
    };
}

export interface ParseNotificationMessageResult {
    triggerDevice: DeviceInterface,
    detection: ObjectDetectionResult,
    allDetections: ObjectDetectionResult[],
    eventType: DetectionEvent,
    classname: DetectionClass,
    label: string,
    triggerTime: number,
}

export const isDetectionClass = (value: string): value is DetectionClass => {
    return Object.values(DetectionClass).includes(value as DetectionClass);
}

export const parseNvrNotificationMessage = async (cameraDevice: DeviceInterface, deviceSensors: string[], options?: NotifierOptions, console?: Console): Promise<ParseNotificationMessageResult> => {
    try {
        let triggerDevice: DeviceInterface = cameraDevice;
        let detection: ObjectDetectionResult
        let label: string;
        const subtitle = options?.subtitle;

        let eventType: DetectionEvent;
        let allDetections: ObjectDetectionResult[] = options?.recordedEvent?.data?.detections ?? [];
        const triggerTime = options.timestamp ?? Date.now();

        if (subtitle === 'Offline') {
            eventType = NvrEvent.Offline;
        } else if (subtitle === 'Online') {
            eventType = NvrEvent.Online;
        } else if (subtitle === 'Recording Interrupted') {
            eventType = NvrEvent.RecordingInterrupted;
            const regex = new RegExp('The (.*) has been offline for an extended period.');
            label = regex.exec(options.body)[1];
            detection = {
                label,
            } as ObjectDetectionResult;
        } else {
            if (subtitle.includes('Maybe: Vehicle')) {
                eventType = DetectionClass.Plate;
                detection = allDetections.find(det => det.className === 'plate');
                label = detection?.label;
            } else if (subtitle.includes('Person')) {
                eventType = DetectionClass.Person;
                detection = allDetections.find(det => det.className === 'person');
            } else if (subtitle.includes('Vehicle')) {
                eventType = DetectionClass.Vehicle;
                detection = allDetections.find(det => det.className === 'vehicle');
            } else if (subtitle.includes('Animal')) {
                eventType = DetectionClass.Animal;
                detection = allDetections.find(det => det.className === 'animal');
            } else if (subtitle.includes('Maybe: ')) {
                eventType = DetectionClass.Face;
                detection = allDetections.find(det => det.className === 'face');
                label = detection?.label;
            } else if (subtitle.includes('Motion')) {
                eventType = DetectionClass.Motion;
                detection = allDetections.find(det => det.className === 'motion');

                if (!allDetections.length) {
                    allDetections = [
                        {
                            className: "motion",
                            score: 1,
                            zones: []
                        },
                    ]
                }
            } else if (subtitle.includes('Door/Window Open')) {
                eventType = SupportedSensorType.Binary;
            } else if (subtitle.includes('Doorbell Ringing')) {
                eventType = DetectionClass.Doorbell;
            } else if (subtitle.includes('Door Unlocked')) {
                eventType = SupportedSensorType.Lock;
            } else if (subtitle.includes('Package Detected')) {
                eventType = DetectionClass.Package;
                detection = allDetections.find(det => det.className === 'package');
            }
        }

        // Remove this when nvr will provide trigger IDs
        if ([SupportedSensorType.Binary, SupportedSensorType.Lock].includes(eventType as any)) {
            const systemState = sdk.systemManager.getSystemState();

            const foundSensor = deviceSensors.find(deviceId => {
                const device = sdk.systemManager.getDeviceById<DeviceBase>(deviceId);
                if (device) {
                    if (device.type === ScryptedDeviceType.Lock) {
                        return systemState[deviceId].lockState?.value === LockState.Unlocked;
                    } else {
                        return systemState[deviceId].binaryState?.value === true;
                    }
                }
            })

            if (foundSensor) {
                triggerDevice = sdk.systemManager.getDeviceById<DeviceInterface>(foundSensor)
            } else {
                console.log(`Trigger sensor not found: ${JSON.stringify({ deviceSensors })}`);
            }
        }


        if (detection) {
            const allZones = uniq(allDetections.filter(innerDetection => innerDetection.className === detection.className)
                .flatMap(det => det.zones));
            detection.zones = allZones;
        }

        return {
            triggerDevice,
            detection,
            allDetections,
            eventType,
            classname: detection ? detectionClassesDefaultMap[detection.className] : undefined,
            label,
            triggerTime,
        }
    } catch (e) {
        console.log(`Error parsing notification: ${JSON.stringify({ device: cameraDevice.name, options, deviceSensors })}`, e);
        return {} as ParseNotificationMessageResult;
    }
}

export type DetectionsPerZone = Map<string, Set<DetectionClass>>;

export const getDetectionsPerZone = (detections: ObjectDetectionResult[]) => {
    const zoneDetections: DetectionsPerZone = new Map();

    for (const detection of detections ?? []) {
        const { className, score, zones = [] } = detection;
        const detectionClass = detectionClassesDefaultMap[className];

        if (detectionClass && detectionClassForObjectsReporting.includes(detectionClass) && score > 0.6) {
            for (const zone of zones) {
                if (!zoneDetections.has(zone)) {
                    zoneDetections.set(zone, new Set<DetectionClass>());
                }
                zoneDetections.get(zone).add(detectionClass);
            }
        }
    }

    return zoneDetections;
}

export const filterAndSortValidDetections = (props: {
    detect: ObjectsDetected,
    logger: Console,
    objectIdLastReport: Record<string, number>
}) => {
    const { detect, logger, objectIdLastReport } = props;
    const { detections = [] } = detect ?? {};
    const sortedByPriorityAndScore = sortBy(detections,
        (detection) => [detection?.className ? classnamePrio[detection.className] : 100,
        1 - (detection.score ?? 0)]
    );
    let isSensorEvent = false;
    let isAudioEvent = false;
    const faces = new Set<string>();
    const uniqueByClassName = uniqBy(sortedByPriorityAndScore, det => det.className);

    const candidates = uniqueByClassName.filter(det => {
        const { className, label, movement, id } = det;

        const groupClass = detectionClassesDefaultMap[className];

        if (!groupClass) {
            return false;
        }
        if (id) {
            const lastNotify = objectIdLastReport[id];

            if (lastNotify && Date.now() - lastNotify < (1000 * 20)) {
                return false;
            }
        }

        if (className.startsWith('debug-')) {
            return false;
        }

        const isLabel = isLabelDetection(className);
        if (isLabel) {
            if (!label) {
                logger.debug(`Label ${label} not valid`);
                return false;
            } else {
                return isFaceClassname(className) && faces.add(label);
            }
        } else if (movement && !movement.moving) {
            logger.debug(`Movement data ${JSON.stringify(movement)} not valid: ${JSON.stringify(det)}`);
            return false;
        }

        if (
            !isSensorEvent &&
            [DetectionClass.Doorbell, DetectionClass.Package, DetectionClass].includes(className as DetectionClass)
        ) {
            isSensorEvent = true
        }

        if (!isAudioEvent && groupClass === DetectionClass.Audio) {
            isAudioEvent = true;
        }

        return true;
    });

    return {
        candidates,
        isSensorEvent,
        facesFound: Array.from(faces),
        isAudioEvent,
    };
}

export type TextSettingKey =
    | 'detectionTimeText'
    | 'objectDetectionText'
    | 'tapToViewText'
    | 'doorWindowText'
    | 'doorbellText'
    | 'anyObjectText'
    | 'packageText'
    | 'plateText'
    | 'familiarText'
    | 'audioText'
    | 'audioWithLabelText'
    | 'motionText'
    | 'personText'
    | 'vehicleText'
    | 'vehicleWithLabelText'
    | 'animalText'
    | 'animalWithLabelText'
    | 'onlineText'
    | 'doorlockText'
    | 'floodingText'
    | 'entrySensorText'
    | 'offlineText'
    | 'snoozeText'
    | 'openNvrText'
    | 'minutesText'
    | 'hoursText'
    | 'discardText'
    | 'streamInterruptedText';

export const getTextSettings = (props: { forMixin: boolean, isNvrNotifier?: boolean }) => {
    const { forMixin } = props;
    const groupKey = forMixin ? 'subgroup' : 'group';

    const settings: StorageSettingsDict<TextSettingKey> = {
        detectionTimeText: {
            [groupKey]: 'Texts',
            title: 'Detection time',
            type: 'string',
            description: 'Expression used to render the time shown in notifications. Available arguments ${time}',
            defaultValue: !forMixin ? 'new Date(${time}).toLocaleString()' : undefined,
            placeholder: !forMixin ? 'new Date(${time}).toLocaleString()' : undefined
        },
        objectDetectionText: {
            [groupKey]: 'Texts',
            title: 'Object detection',
            type: 'string',
            description: 'Expression used to render the text when an object detection happens. Available arguments ${classnameText} ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? '${classnameText} detected in ${room}' : undefined,
            placeholder: !forMixin ? '${classnameText} detected in ${room}' : undefined
        },
        tapToViewText: {
            [groupKey]: 'Texts',
            title: 'Tap to view',
            type: 'string',
            description: 'Expression used to render the text "Tap to view"',
            defaultValue: !forMixin ? 'Tap to view' : undefined,
            placeholder: !forMixin ? 'Tap to view' : undefined
        },
        doorbellText: {
            [groupKey]: 'Texts',
            title: 'Doorbell ringing text',
            type: 'string',
            description: 'Expression used to render the text when a vehicle is detected. Available arguments ${room} ${time}',
            defaultValue: !forMixin ? 'Someone at the door' : undefined,
            placeholder: !forMixin ? 'Someone at the door' : undefined
        },
        doorWindowText: {
            [groupKey]: 'Texts',
            title: 'Door/Window open text',
            type: 'string',
            description: 'Expression used to render the text when a binary sensor opens. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Door/window opened in ${room}' : undefined,
            placeholder: !forMixin ? 'Door/window opened in ${room}' : undefined
        },
        doorlockText: {
            [groupKey]: 'Texts',
            title: 'Doorlock sensor open text',
            type: 'string',
            description: 'Expression used to render the text when a lock sensor opens. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Door unlocked in ${room}' : undefined,
            placeholder: !forMixin ? 'Door unlocked in ${room}' : undefined
        },
        floodingText: {
            [groupKey]: 'Texts',
            title: 'Flood sensor open text',
            type: 'string',
            description: 'Expression used to render the text when a flood sensor opens. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Flooding detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Flooding detected in ${room}' : undefined
        },
        entrySensorText: {
            [groupKey]: 'Texts',
            title: 'Entry sensor open text',
            type: 'string',
            description: 'Expression used to render the text when an entry sensor opens. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Entry opening detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Entry opening detected in ${room}' : undefined
        },
        onlineText: {
            [groupKey]: 'Texts',
            title: 'Online device text',
            type: 'string',
            description: 'Expression used to render the text when a device comes back online. Available arguments ${time}',
            defaultValue: !forMixin ? 'Back online at ${time}' : undefined,
            placeholder: !forMixin ? 'Back online at ${time}' : undefined,
        },
        offlineText: {
            [groupKey]: 'Texts',
            title: 'Online device text',
            type: 'string',
            description: 'Expression used to render the text when a device goes offline. Available arguments ${time}',
            defaultValue: !forMixin ? 'Went offline at ${time}' : undefined,
            placeholder: !forMixin ? 'Went offline at ${time}' : undefined,
        },
        streamInterruptedText: {
            [groupKey]: 'Texts',
            title: 'Stream interrupted text',
            type: 'string',
            description: 'Expression used to render the text when a streams gets interrupted. Available arguments ${time} ${streamName}',
            defaultValue: !forMixin ? 'Stream ${streamName} interrupted at ${time}' : undefined,
            placeholder: !forMixin ? 'Stream ${streamName} interrupted at ${time}' : undefined,
        },
        snoozeText: {
            [groupKey]: 'Texts',
            title: 'Snooze text',
            type: 'string',
            description: 'Expression used to render the snooze texts. Available arguments ${timeText}',
            defaultValue: !forMixin ? 'Snooze: ${timeText}' : undefined,
            placeholder: !forMixin ? 'Snooze: ${timeText}' : undefined,
        },
        openNvrText: {
            [groupKey]: 'Texts',
            title: 'Open NVR text',
            type: 'string',
            description: 'Expression used to render the open NVR texts',
            defaultValue: !forMixin ? 'Open in NVR app' : undefined,
            placeholder: !forMixin ? 'Open in NVR app' : undefined,
        },
        minutesText: {
            [groupKey]: 'Texts',
            title: 'Minutes text',
            type: 'string',
            description: 'Expression used to render the minutes text for snoozes',
            defaultValue: !forMixin ? 'minutes' : undefined,
        },
        hoursText: {
            [groupKey]: 'Texts',
            title: 'Hours text',
            type: 'string',
            description: 'Expression used to render the hours text for snoozes',
            defaultValue: !forMixin ? 'hours' : undefined,
        },
        discardText: {
            [groupKey]: 'Texts',
            title: 'Discard text',
            type: 'string',
            description: 'Expression used to render the discard text',
            defaultValue: !forMixin ? 'Dismiss' : undefined,
        },
        motionText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Motion text',
            type: 'string',
            defaultValue: !forMixin ? 'Motion' : undefined,
            placeholder: !forMixin ? 'Motion' : undefined,
            hide: forMixin
        },
        personText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Person text',
            type: 'string',
            defaultValue: !forMixin ? 'Person' : undefined,
            placeholder: !forMixin ? 'Person' : undefined,
            hide: forMixin
        },
        animalText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Animal text',
            type: 'string',
            defaultValue: !forMixin ? 'Animal' : undefined,
            placeholder: !forMixin ? 'Animal' : undefined,
            hide: forMixin
        },
        animalWithLabelText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Labeled animal text (Frigate)',
            type: 'string',
            defaultValue: !forMixin ? 'Animal (${label})' : undefined,
            placeholder: !forMixin ? 'Animal (${label})' : undefined,
            hide: forMixin
        },
        vehicleText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Vehicle text',
            type: 'string',
            defaultValue: !forMixin ? 'Vehicle' : undefined,
            placeholder: !forMixin ? 'Vehicle' : undefined,
            hide: forMixin
        },
        vehicleWithLabelText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Labeled vehicle text (Frigate)',
            type: 'string',
            defaultValue: !forMixin ? 'Vehicle (${label})' : undefined,
            placeholder: !forMixin ? 'Vehicle (${label})' : undefined,
            hide: forMixin
        },
        packageText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Package text',
            type: 'string',
            defaultValue: !forMixin ? 'Package' : undefined,
            placeholder: !forMixin ? 'Package' : undefined,
            hide: forMixin
        },
        anyObjectText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Ant object text',
            type: 'string',
            defaultValue: !forMixin ? 'Something' : undefined,
            placeholder: !forMixin ? 'Something' : undefined,
            hide: forMixin
        },
        audioText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Audio text',
            type: 'string',
            defaultValue: !forMixin ? 'Audio ${label}' : undefined,
            placeholder: !forMixin ? 'Audio ${label}' : undefined,
            hide: forMixin
        },
        audioWithLabelText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Labeled audio text (Frigate)',
            type: 'string',
            defaultValue: !forMixin ? 'Audio (${label})' : undefined,
            placeholder: !forMixin ? 'Audio (${label})' : undefined,
            hide: forMixin
        },
        familiarText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Familiar text',
            description: '${label} available',
            type: 'string',
            defaultValue: !forMixin ? 'Familiar ${label}' : undefined,
            placeholder: !forMixin ? 'Familiar ${label}' : undefined,
            hide: forMixin
        },
        plateText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Plate text',
            description: '${label} available',
            type: 'string',
            defaultValue: !forMixin ? 'Plate ${label}' : undefined,
            placeholder: !forMixin ? 'Plate ${label}' : undefined,
            hide: forMixin
        }
    };

    return settings;
}

export enum RuleType {
    Detection = 'Detection',
    Occupancy = 'Occupancy',
    Timelapse = 'Timelapse',
    Audio = 'Audio',
    Recording = 'Recording',
}

export const ruleTypeMetadataMap: Record<RuleType, { rulesKey: string, rulePrefix: string, subgroupPrefix: string }> = {
    [RuleType.Detection]: { rulePrefix: 'rule', rulesKey: 'detectionRules', subgroupPrefix: 'DET' },
    [RuleType.Occupancy]: { rulePrefix: 'occupancyRule', rulesKey: 'occupancyRules', subgroupPrefix: 'OCC' },
    [RuleType.Timelapse]: { rulePrefix: 'timelapseRule', rulesKey: 'timelapseRules', subgroupPrefix: 'TIME' },
    [RuleType.Audio]: { rulePrefix: 'audioRule', rulesKey: 'audioRules', subgroupPrefix: 'AUDIO' },
    [RuleType.Recording]: { rulePrefix: 'recordingRule', rulesKey: 'recordingRules', subgroupPrefix: 'REC' },
}

export const mixinRulesGroup = 'Advanced notifier rules';
export const pluginRulesGroup = 'Rules';
export const ruleSequencesGroup = 'Sequences';
export const ruleSequencesKey = 'ruleSequences';

export type MixinBaseSettingKey =
    | 'logLevel'
    | 'enabledToMqtt'
    | 'useNvrDetections'
    | 'detectionSource'
    | 'minDelayTime'
    | 'detectionRules'
    | 'occupancyRules'
    | 'timelapseRules'
    | 'audioRules'
    | 'recordingRules'

export enum NotificationPriority {
    SuperLow = "SuperLow",
    Low = "Low",
    Normal = "Normal",
    High = "High",
    SuperHigh = "SuperHigh",
};

export interface ExtendedNotificationAction {
    title: string;
    action: string;
    url: string;
    icon?: string;
    data?: any;
    destructive?: boolean;
}

export const getMixinBaseSettings = (props: {
    mixin: SettingsMixinDeviceBase<any>,
    plugin: AdvancedNotifierPlugin,
    refreshSettings: () => Promise<void>
}) => {
    try {
        const { mixin, refreshSettings } = props;
        const device = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(mixin.id);
        const { isCamera, isSensor, isNotifier } = isDeviceSupported(device);

        const settings: StorageSettingsDict<MixinBaseSettingKey> = {
            logLevel: {
                ...logLevelSetting,
            },
        } as StorageSettingsDict<MixinBaseSettingKey>;

        if (isCamera || isSensor) {
            settings.useNvrDetections = {
                title: 'Use NVR detections',
                description: 'If enabled, the NVR notifications will be used (cropped images and more precise). If not raw detections will be used (snapshot will be roughlty taken at the beginning of the event) Make sure to extend the notifiers with this extension',
                type: 'boolean',
                subgroup: 'Detection',
                immediate: true,
                hide: true,
            };
            settings[ruleTypeMetadataMap[RuleType.Detection].rulesKey] = {
                title: 'Detection rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                immediate: true,
                combobox: true,
                defaultValue: [],
                choices: [],
                onPut: async () => await refreshSettings(),
            };
        }

        if (isCamera) {
            settings[ruleTypeMetadataMap[RuleType.Occupancy].rulesKey] = {
                title: 'Occupancy rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
                immediate: true,
                defaultValue: [],
                choices: [],
                onPut: async () => await refreshSettings()
            };
            settings[ruleTypeMetadataMap[RuleType.Timelapse].rulesKey] = {
                title: 'Timelapse rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
                immediate: true,
                defaultValue: [],
                choices: [],
                onPut: async () => await refreshSettings()
            };
            settings[ruleTypeMetadataMap[RuleType.Recording].rulesKey] = {
                title: 'Recording rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
                immediate: true,
                defaultValue: [],
                choices: [],
                onPut: async () => await refreshSettings()
            };
            settings[ruleTypeMetadataMap[RuleType.Audio].rulesKey] = {
                title: 'Audio rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
                immediate: true,
                defaultValue: [],
                choices: [],
                onPut: async () => await refreshSettings()
            };
        }

        if (isCamera || isNotifier || isSensor) {
            settings.enabledToMqtt = {
                title: 'Report to MQTT',
                description: 'Autodiscovery this device on MQTT',
                type: 'boolean',
                defaultValue: !isSensor,
                immediate: true,
            }
        }

        if (isCamera || isSensor) {
            settings.minDelayTime = {
                title: 'Minimum notification delay',
                subgroup: isCamera ? 'Notifier' : undefined,
                description: 'Minimum amount of seconds to wait until a notification is sent. Set 0 to disable',
                type: 'number',
                defaultValue: isCamera ? 10 : 0,
            }
        }

        return settings;
    } catch (e) {
        console.log('Error in getMixinBaseSettings', e);
    }
}

export const getActiveRules = async (
    props: {
        device: StorageSettingsDevice & DeviceBase,
        deviceStorage: StorageSettings<any>,
        plugin: AdvancedNotifierPlugin,
        console: Console,
    },
) => {
    const { console, device, deviceStorage, plugin } = props;
    const pluginStorage = plugin.storageSettings;

    if (!pluginStorage || !deviceStorage) {
        return {};
    }

    const {
        allowedRules: allowedDetectionRules,
        availableRules: availableDetectionRules,
        anyAllowedNvrRule: anyAllowedNvrDetectionRule,
        shouldListenDoorbell,
        shouldListenAudioSensor,
        enabledAudioLabels,
    } = getDetectionRules({
        device,
        console,
        deviceStorage,
        pluginStorage,
    });

    const {
        allowedRules: allowedOccupancyRules,
        availableRules: availableOccupancyRules
    } = getDeviceOccupancyRules({
        deviceStorage,
        pluginStorage,
        device,
    });

    const {
        allowedRules: allowedTimelapseRules,
        availableRules: availableTimelapseRules
    } = getDeviceTimelapseRules({
        deviceStorage,
        pluginStorage,
        console,
        device,
    });

    const {
        allowedRules: allowedAudioRules,
        availableRules: availableAudioRules,
    } = getDeviceAudioRules({
        deviceStorage,
        pluginStorage,
        console,
        device,
    });

    const {
        allowedRules: allowedRecordingRules,
        availableRules: availableRecordingRules,
    } = getRecordingRules({
        deviceStorage,
        pluginStorage,
        console,
        device,
    });

    const isPluginEnabled = pluginStorage.getItem('pluginEnabled');
    const isMqttActive = pluginStorage.getItem('mqttEnabled');
    const isDeviceEnabledToMqtt = deviceStorage?.values.enabledToMqtt;

    const allAvailableRules = [
        ...availableDetectionRules,
        ...availableOccupancyRules,
        ...availableTimelapseRules,
        ...availableAudioRules,
        ...availableRecordingRules,
    ];

    const allAllowedRules = [
        ...allowedDetectionRules,
        ...allowedOccupancyRules,
        ...allowedTimelapseRules,
        ...allowedAudioRules,
        ...allowedRecordingRules,
    ];

    const hasClips = allAllowedRules.some(rule => rule.generateClip);

    const shouldListenAudio = !!allowedAudioRules.length;
    const isActiveForMqttReporting = isPluginEnabled && isMqttActive && isDeviceEnabledToMqtt;
    const shouldListenDetections = !!allowedDetectionRules.length || isActiveForMqttReporting;

    return {
        availableDetectionRules,
        availableOccupancyRules,
        availableTimelapseRules,
        availableAudioRules,
        availableRecordingRules,
        allowedDetectionRules,
        allowedOccupancyRules,
        allowedTimelapseRules,
        allowedAudioRules,
        allowedRecordingRules,
        allAvailableRules,
        allAllowedRules,
        shouldListenDetections,
        shouldListenAudio,
        isActiveForMqttReporting,
        anyAllowedNvrDetectionRule,
        shouldListenDoorbell,
        hasClips,
        shouldListenAudioSensor,
        enabledAudioLabels,
    }
}

export const getEventTextKey = (props: { eventType: DetectionEvent, hasLabel: boolean }) => {
    const { eventType, hasLabel } = props;

    let key: TextSettingKey;
    let subKey: TextSettingKey;

    switch (eventType) {
        case NvrEvent.RecordingInterrupted:
            key = 'streamInterruptedText';
            break;
        case NvrEvent.Online:
            key = 'onlineText';
            break;
        case NvrEvent.Offline:
            key = 'offlineText';
            break;
        case SupportedSensorType.Binary:
            key = 'doorWindowText';
            break;
        case SupportedSensorType.Lock:
            key = 'doorlockText';
            break;
        case SupportedSensorType.Entry:
            key = 'entrySensorText';
            break;
        case SupportedSensorType.Flood:
            key = 'floodingText';
            break;
        case DetectionClass.Animal:
            key = 'objectDetectionText';
            subKey = hasLabel ? 'animalWithLabelText' : 'animalText';
            break;
        case DetectionClass.Person:
            key = 'objectDetectionText';
            subKey = 'personText';
            break;
        case DetectionClass.Vehicle:
            key = 'objectDetectionText';
            subKey = hasLabel ? 'vehicleWithLabelText' : 'vehicleText';
            break;
        case DetectionClass.Motion:
            key = 'objectDetectionText';
            subKey = 'motionText';
            break;
        case DetectionClass.Face:
            key = 'objectDetectionText';
            subKey = 'familiarText';
            break;
        case DetectionClass.Audio:
            key = 'objectDetectionText';
            subKey = hasLabel ? 'audioWithLabelText' : 'audioText';
            break;
        case DetectionClass.Plate:
            key = 'objectDetectionText';
            subKey = 'plateText';
            break;
        case DetectionClass.Package:
            key = 'objectDetectionText';
            subKey = 'packageText';
            break;
        case DetectionClass.Doorbell:
            key = 'doorbellText';
            break;
        case DetectionClass.AnyObject:
            key = 'objectDetectionText';
            subKey = 'anyObjectText';
            break;
    }

    return { key, subKey };
}

export enum DetectionRuleActivation {
    Always = 'Always',
    OnActive = 'OnActive',
    Schedule = 'Schedule',
    AdvancedSecuritySystem = 'AdvancedSecuritySystem',
}

export enum ImagePostProcessing {
    Default = 'Default',
    FullFrame = 'FullFrame',
    Crop = 'Crop',
    MarkBoundaries = 'MarkBoundaries'
}

export enum NvrEvent {
    Online = 'Online',
    Offline = 'Offline',
    RecordingInterrupted = 'RecordingInterrupted'
}

export const getRuleKeys = (props: {
    ruleName: string;
    ruleType: RuleType
}) => {
    const { ruleName, ruleType } = props;
    const { rulePrefix: prefix } = ruleTypeMetadataMap[ruleType];

    // Common
    const activationKey = `${prefix}:${ruleName}:activation`;
    const enabledKey = `${prefix}:${ruleName}:enabled`;
    const currentlyActiveKey = `${prefix}:${ruleName}:currentlyActive`;
    const textKey = `${prefix}:${ruleName}:text`;
    const scoreThresholdKey = `${prefix}:${ruleName}:scoreThreshold`;
    const enabledSensorsKey = `${prefix}:${ruleName}:enabledSensors`;
    const disabledSensorsKey = `${prefix}:${ruleName}:disabledSensors`;
    const devicesKey = `${prefix}:${ruleName}:devices`;
    const notifiersKey = `${prefix}:${ruleName}:notifiers`;
    const dayKey = `${prefix}:${ruleName}:day`;
    const startTimeKey = `${prefix}:${ruleName}:startTime`;
    const endTimeKey = `${prefix}:${ruleName}:endTime`;
    const securitySystemModesKey = `${prefix}:${ruleName}:securitySystemModes`;
    const aiEnabledKey = `${prefix}:${ruleName}:aiEnabled`;
    const aiPromptKey = `${prefix}:${ruleName}:aiPrompt`;
    const showMoreConfigurationsKey = `${prefix}:${ruleName}:showMoreConfigurations`;
    const showActiveZonesKey = `${prefix}:${ruleName}:showActiveZones`;
    const minDelayKey = `${prefix}:${ruleName}:minDelay`;
    const minMqttPublishDelayKey = `${prefix}:${ruleName}:minMqttPublishDelay`;
    const startRuleTextKey = `${prefix}:${ruleName}:startRuleText`;
    const endRuleTextKey = `${prefix}:${ruleName}:endRuleText`;
    const generateClipKey = `${prefix}:${ruleName}:generateClip`;
    const generateClipSpeedKey = `${prefix}:${ruleName}:generateClipSpeed`;
    const generateClipPostSecondsKey = `${prefix}:${ruleName}:generateClipPostSeconds`;
    const generateClipPreSecondsKey = `${prefix}:${ruleName}:generateClipPreSeconds`;
    const generateClipTypeKey = `${prefix}:${ruleName}:generateClipType`;
    const generateClipMaxExtensionRangeKey = `${prefix}:${ruleName}:generateClipMaxExtensionRange`;
    const imageProcessingKey = `${prefix}:${ruleName}:imageProcessing`;
    const totalSnoozeKey = `${prefix}:${ruleName}:totalSnooze`;
    const onActivationSequencesKey = `${prefix}:${ruleName}:onActivationSequences`;
    const onDeactivationSequencesKey = `${prefix}:${ruleName}:onDeactivationSequences`;

    // Specific for detection rules
    const detectionClassesKey = `${prefix}:${ruleName}:detecionClasses`;
    const nvrEventsKey = `${prefix}:${ruleName}:nvrEvents`;
    const frigateLabelsKey = `${prefix}:${ruleName}:frigateLabels`;
    const audioLabelsKey = `${prefix}:${ruleName}:audioLabels`;
    const useNvrDetectionsKey = `${prefix}:${ruleName}:useNvrDetections`;
    const detectionSourceKey = `${prefix}:${ruleName}:detectionSource`;
    const whitelistedZonesKey = `${prefix}:${ruleName}:whitelistedZones`;
    const blacklistedZonesKey = `${prefix}:${ruleName}:blacklistedZones`;
    const recordingTriggerSecondsKey = `${prefix}:${ruleName}:recordingTriggerSeconds`;
    const peopleKey = `${prefix}:${ruleName}:people`;
    const platesKey = `${prefix}:${ruleName}:plates`;
    const plateMaxDistanceKey = `${prefix}:${ruleName}:plateMaxDistance`;
    const labelScoreKey = `${prefix}:${ruleName}:labelScore`;
    const clipDescriptionKey = `${prefix}:${ruleName}:clipDescription`;
    const clipConfidenceKey = `${prefix}:${ruleName}:clipConfidence`;
    const aiFilterKey = `${prefix}:${ruleName}:aiFilter`;
    const onTriggerSequencesKey = `${prefix}:${ruleName}:onTriggerSequences`;
    const onResetSequencesKey = `${prefix}:${ruleName}:onResetSequences`;

    // Specific for timelapse rules
    const regularSnapshotIntervalKey = `${prefix}:${ruleName}:regularSnapshotInterval`;
    const framesAcquisitionDelayKey = `${prefix}:${ruleName}:framesAcquisitionDelay`;
    const timelapseFramerateKey = `${prefix}:${ruleName}:timelapseFramerate`;
    const generateKey = `${prefix}:${ruleName}:generate`;
    const cleanDataKey = `${prefix}:${ruleName}:clenup`;
    const lastGeneratedKey = `${prefix}:${ruleName}:lastGenerated`;

    // Specific for occupancy rules
    const detectionClassKey = `${prefix}:${ruleName}:detecionClassKey`;
    const captureZoneKey = `${prefix}:${ruleName}:captureZone`;
    const zoneKey = `${prefix}:${ruleName}:zone`;
    const zoneMatchTypeKey = `${prefix}:${ruleName}:zoneMatchType`;
    const zoneOccupiedTextKey = `${prefix}:${ruleName}:zoneOccupiedText`;
    const zoneNotOccupiedTextKey = `${prefix}:${ruleName}:zoneNotOccupiedText`;
    const changeStateConfirmKey = `${prefix}:${ruleName}:changeStateConfirm`;
    const maxObjectsKey = `${prefix}:${ruleName}:maxObjects`;
    const forceUpdateKey = `${prefix}:${ruleName}:forceUpdate`;
    const occupiesKey = `${prefix}:${ruleName}:occupies`;
    const detectedObjectsKey = `${prefix}:${ruleName}:detectedObjects`;
    const confirmWithAiKey = `${prefix}:${ruleName}:confirmWithAi`;
    const manualCheckKey = `${prefix}:${ruleName}:manualCheck`;

    // Specific for audio rules
    const decibelThresholdKey = `${prefix}:${ruleName}:decibelThreshold`;
    const audioDurationKey = `${prefix}:${ruleName}:audioDuration`;
    const hitPercentageKey = `${prefix}:${ruleName}:hitPercentage`;

    // Specific for recording rules
    const recordingDetectionClassesKey = `${prefix}:${ruleName}:detectionClasses`;
    const recordingScoreThresholdKey = `${prefix}:${ruleName}:scoreThreshold`;
    const postEventSecondsKey = `${prefix}:${ruleName}:postEventSeconds`;
    const maxClipLengthKey = `${prefix}:${ruleName}:maxClipLength`;
    const prolongClipOnMotionKey = `${prefix}:${ruleName}:prolongClipOnMotion`;

    return {
        common: {
            activationKey,
            enabledKey,
            currentlyActiveKey,
            textKey,
            scoreThresholdKey,
            enabledSensorsKey,
            disabledSensorsKey,
            devicesKey,
            notifiersKey,
            dayKey,
            startTimeKey,
            endTimeKey,
            securitySystemModesKey,
            aiEnabledKey,
            aiPromptKey,
            showMoreConfigurationsKey,
            minDelayKey,
            minMqttPublishDelayKey,
            startRuleTextKey,
            endRuleTextKey,
            generateClipKey,
            generateClipSpeedKey,
            generateClipPostSecondsKey,
            generateClipPreSecondsKey,
            generateClipTypeKey,
            generateClipMaxExtensionRangeKey,
            imageProcessingKey,
            totalSnoozeKey,
            onActivationSequencesKey,
            onDeactivationSequencesKey,
            onTriggerSequencesKey,
            onResetSequencesKey,
            showActiveZonesKey,
        },
        detection: {
            useNvrDetectionsKey,
            detectionSourceKey,
            whitelistedZonesKey,
            blacklistedZonesKey,
            recordingTriggerSecondsKey,
            nvrEventsKey,
            frigateLabelsKey,
            audioLabelsKey,
            detectionClassesKey,
            peopleKey,
            platesKey,
            plateMaxDistanceKey,
            labelScoreKey,
            clipDescriptionKey,
            clipConfidenceKey,
            aiFilterKey,
        },
        timelapse: {
            regularSnapshotIntervalKey,
            framesAcquisitionDelayKey,
            timelapseFramerateKey,
            generateKey,
            cleanDataKey,
            lastGeneratedKey,
        },
        occupancy: {
            captureZoneKey,
            zoneKey,
            zoneMatchTypeKey,
            zoneOccupiedTextKey,
            zoneNotOccupiedTextKey,
            changeStateConfirmKey,
            maxObjectsKey,
            forceUpdateKey,
            detectionClassKey,
            occupiesKey,
            detectedObjectsKey,
            confirmWithAiKey,
            manualCheckKey
        },
        audio: {
            decibelThresholdKey,
            audioDurationKey,
            hitPercentageKey,
        },
        recording: {
            recordingDetectionClassesKey,
            recordingScoreThresholdKey,
            postEventSecondsKey,
            maxClipLengthKey,
            prolongClipOnMotionKey,
        }
    }
}

export const getSequenceKeys = (props: {
    sequenceName: string;
    actionName?: string;
}) => {
    const { sequenceName, actionName } = props;
    const prefix = 'sequence';

    const actionsKey = `${prefix}:${sequenceName}:actions`;
    const enabledKey = `${prefix}:${sequenceName}:enabled`;
    const testKey = `${prefix}:${sequenceName}:test`;
    const minimumExecutionDelayKey = `${prefix}:${sequenceName}:minimumExecutionDelay`;
    const typeKey = `${prefix}:${sequenceName}:${actionName}:type`;
    const deviceIdKey = `${prefix}:${sequenceName}:${actionName}:deviceId`;
    const actionTitleKey = `${prefix}:${sequenceName}:${actionName}:actionTitle`;
    const presetNameKey = `${prefix}:${sequenceName}:${actionName}:presetName`;
    const switchEnabledKey = `${prefix}:${sequenceName}:${actionName}:switchEnabled`;
    const lockStateKey = `${prefix}:${sequenceName}:${actionName}:lockState`;
    const entryStateKey = `${prefix}:${sequenceName}:${actionName}:entryState`;
    const waitSecondsKey = `${prefix}:${sequenceName}:${actionName}:waitSeconds`;

    return {
        actionsKey,
        enabledKey,
        minimumExecutionDelayKey,
        typeKey,
        deviceIdKey,
        actionTitleKey,
        presetNameKey,
        switchEnabledKey,
        waitSecondsKey,
        lockStateKey,
        entryStateKey,
        testKey,
    };
};

export enum ZoneMatchType {
    Intersect = 'Intersect',
    Contain = 'Contain',
}

const sensorInterfaces: ScryptedInterface[] = [
    ScryptedInterface.BinarySensor,
    ScryptedInterface.FloodSensor,
    ScryptedInterface.EntrySensor,
    ScryptedInterface.Lock,
];
const ruleActionDeviceInterfacesMap: Partial<Record<RuleActionType, ScryptedInterface[]>> = {
    [RuleActionType.Ptz]: [ScryptedInterface.PanTiltZoom],
    [RuleActionType.Switch]: [ScryptedInterface.OnOff],
    [RuleActionType.Lock]: [ScryptedInterface.Lock],
    [RuleActionType.Entry]: [ScryptedInterface.Entry],
    [RuleActionType.Script]: [ScryptedInterface.Program],
};
const cameraInterfaces: ScryptedInterface[] = [
    ScryptedInterface.Camera,
    ScryptedInterface.VideoCamera,
];
const notifierInterfaces: ScryptedInterface[] = [
    ScryptedInterface.Notifier
];
export const allInterfaces = [
    ...sensorInterfaces,
    ...cameraInterfaces,
    ...notifierInterfaces
];

const getInterfacesString = (interfaces: ScryptedInterface[]) =>
    "[" + interfaces.map(int => `'${int}'`) + "]";

export const deviceFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.some(int => ${getInterfacesString([...sensorInterfaces, ...cameraInterfaces])}.includes(int))`;
export const notifierFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.some(int => ${getInterfacesString(notifierInterfaces)}.includes(int))`;
export const sensorsFilter: StorageSetting['deviceFilter'] = `interfaces.some(int => ${getInterfacesString(sensorInterfaces)}.includes(int))`;
export const sensorsFilterWthAn: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && type !== '${ScryptedDeviceType.Doorbell}' && interfaces.some(int => ${getInterfacesString(sensorInterfaces)}.includes(int))`;
export const cameraFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.some(int => ${getInterfacesString(cameraInterfaces)}.includes(int))`;
export const frigateCamerasFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.includes('${FRIGATE_OBJECT_DETECTOR_INTERFACE}')`;

type GetSpecificRules = (props: { group: string, subgroup: string, ruleName: string, showMore: boolean }) => Promise<StorageSetting[]>;
type OnRefreshSettings = () => Promise<void>

export const getNotifierData = (props: {
    notifierId: string,
    ruleType: RuleType,
}) => {
    const { notifierId, ruleType } = props;
    const notifier = sdk.systemManager.getDeviceById(notifierId);
    if (!notifier) {
        return {};
    }

    const pluginId = notifier.pluginId;
    const priorityChoices: NotificationPriority[] = [];
    const isDetectionRule = ruleType === RuleType.Detection;
    const isAudioRule = ruleType === RuleType.Audio;
    const isOccupancyRule = ruleType === RuleType.Occupancy;
    const withActions = [
        HOMEASSISTANT_PLUGIN_ID, ZENTIK_PLUGIN_ID
    ].includes(pluginId) && isDetectionRule;
    const snoozingDefault = pluginId !== PUSHOVER_PLUGIN_ID;
    const openInAppDefault = true;
    const addCameraActionsDefault = pluginId !== PUSHOVER_PLUGIN_ID;
    const withSnoozing = isDetectionRule || isAudioRule || isOccupancyRule;
    const withSound = [PUSHOVER_PLUGIN_ID, HOMEASSISTANT_PLUGIN_ID, ZENTIK_PLUGIN_ID].includes(pluginId);
    const withOpenInApp = [HOMEASSISTANT_PLUGIN_ID, ZENTIK_PLUGIN_ID].includes(pluginId);
    const withChannel = [HOMEASSISTANT_PLUGIN_ID].includes(pluginId);
    const withNotificationIcon = [HOMEASSISTANT_PLUGIN_ID].includes(pluginId);
    const withIconColor = [HOMEASSISTANT_PLUGIN_ID].includes(pluginId);
    const withClearNotification = [HOMEASSISTANT_PLUGIN_ID, ZENTIK_PLUGIN_ID].includes(pluginId);
    const withDeleteNotification = [ZENTIK_PLUGIN_ID].includes(pluginId);
    const withOpenNotification = [ZENTIK_PLUGIN_ID].includes(pluginId);
    const withClearNotificationDefault = true;
    const withDeleteNotificationDefault = false;
    const withOpenNotificationDefault = false;

    if (pluginId === HOMEASSISTANT_PLUGIN_ID) {
        priorityChoices.push(
            NotificationPriority.Normal,
            NotificationPriority.High
        );
    } else if (pluginId === NTFY_PLUGIN_ID) {
        priorityChoices.push(
            NotificationPriority.SuperLow,
            NotificationPriority.Low,
            NotificationPriority.Normal,
            NotificationPriority.High,
            NotificationPriority.SuperHigh,
        );
    } else if (pluginId === PUSHOVER_PLUGIN_ID) {
        priorityChoices.push(
            NotificationPriority.SuperLow,
            NotificationPriority.Low,
            NotificationPriority.Normal,
            NotificationPriority.High,
        );
    } else if (pluginId === NVR_PLUGIN_ID) {
        priorityChoices.push(
            NotificationPriority.Low,
            NotificationPriority.Normal,
            NotificationPriority.High,
        );
    } else if (pluginId === TELEGRAM_PLUGIN_ID) {
        priorityChoices.push(
            NotificationPriority.Low,
            NotificationPriority.Normal,
        );
    } else if (pluginId === ZENTIK_PLUGIN_ID) {
        priorityChoices.push(
            NotificationPriority.Low,
            NotificationPriority.Normal,
            NotificationPriority.High,
        );
    }

    return {
        priorityChoices,
        withActions,
        snoozingDefault,
        withSnoozing,
        addCameraActionsDefault,
        withSound,
        withOpenInApp,
        withChannel,
        withNotificationIcon,
        withIconColor,
        openInAppDefault,
        withClearNotification,
        withDeleteNotification,
        withOpenNotification,
        withClearNotificationDefault,
        withDeleteNotificationDefault,
        withOpenNotificationDefault,
    };
};

export const getNotifierKeys = (props: {
    notifierId: string,
    ruleName: string,
    ruleType: RuleType,
}) => {
    const { notifierId, ruleName, ruleType } = props;
    const { rulePrefix: prefix } = ruleTypeMetadataMap[ruleType];

    const titleKey = `${prefix}:${ruleName}:${notifierId}:title`;
    const actionsKey = `${prefix}:${ruleName}:${notifierId}:actions`;
    const priorityKey = `${prefix}:${ruleName}:${notifierId}:priority`;
    const addSnoozeKey = `${prefix}:${ruleName}:${notifierId}:addSnooze`;
    const addCameraActionsKey = `${prefix}:${ruleName}:${notifierId}:addCameraActions`;
    const soundKey = `${prefix}:${ruleName}:${notifierId}:sound`;
    const openInAppKey = `${prefix}:${ruleName}:${notifierId}:openInApp`;
    const channelKey = `${prefix}:${ruleName}:${notifierId}:channel`;
    const notificationIconKey = `${prefix}:${ruleName}:${notifierId}:notificationIcon`;
    const iconColorKey = `${prefix}:${ruleName}:${notifierId}:iconColor`;
    const clearNotificationKey = `${prefix}:${ruleName}:${notifierId}:clearNotification`;
    const deleteNotificationKey = `${prefix}:${ruleName}:${notifierId}:deleteNotification`;
    const openNotificationKey = `${prefix}:${ruleName}:${notifierId}:openNotification`;

    return {
        actionsKey,
        priorityKey,
        addSnoozeKey,
        addCameraActionsKey,
        titleKey,
        soundKey,
        openInAppKey,
        channelKey,
        notificationIconKey,
        iconColorKey,
        clearNotificationKey,
        openNotificationKey,
        deleteNotificationKey,
    };
};

const getNotifierSettings = (props: {
    notifierId: string,
    ruleName: string,
    ruleType: RuleType,
    group: string,
    subgroup: string,
    showMoreConfigurations: boolean,
}) => {
    const { notifierId, ruleName, ruleType, group, subgroup, showMoreConfigurations } = props;
    const notifier = sdk.systemManager.getDeviceById(notifierId);

    if (!notifier) {
        return []
    }

    const {
        actionsKey,
        priorityKey,
        addSnoozeKey,
        addCameraActionsKey,
        titleKey,
        soundKey,
        openInAppKey,
        channelKey,
        notificationIconKey,
        iconColorKey,
        clearNotificationKey,
        deleteNotificationKey,
        openNotificationKey,
    } = getNotifierKeys({ notifierId, ruleName, ruleType });

    const {
        priorityChoices,
        snoozingDefault,
        openInAppDefault,
        withActions,
        withChannel,
        withSnoozing,
        addCameraActionsDefault,
        withSound,
        withOpenInApp,
        withNotificationIcon,
        withIconColor,
        withClearNotification,
        withDeleteNotification,
        withOpenNotification,
        withClearNotificationDefault,
        withDeleteNotificationDefault,
        withOpenNotificationDefault
    } = getNotifierData({ notifierId, ruleType });

    const titleSetting: StorageSetting = {
        key: titleKey,
        group,
        subgroup,
        type: 'html',
        title: `<<${notifier.name}>>`,
        hide: !showMoreConfigurations,
        defaultValue: `<h4>Set specific seetings for the notifier ${notifier.name}</h4>`,
    };
    const prioritySetting: StorageSetting = {
        key: priorityKey,
        type: 'string',
        title: `Priority`,
        description: 'Depends on the notifier, if High will always be a critical notification',
        group,
        subgroup,
        choices: priorityChoices,
        immediate: true,
        combobox: true,
        hide: !showMoreConfigurations,
        defaultValue: NotificationPriority.Normal
    };
    const actionsSetting: StorageSetting = {
        key: actionsKey,
        title: `Actions`,
        description: 'I.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door", "url": "url"}',
        type: 'string',
        multiple: true,
        group,
        subgroup,
        hide: !showMoreConfigurations
    };
    const addSnoozeSetting: StorageSetting = {
        key: addSnoozeKey,
        title: `Add snoozing actions`,
        type: 'boolean',
        group,
        subgroup,
        hide: !showMoreConfigurations,
        defaultValue: snoozingDefault,
        immediate: true
    };
    const openInAppSetting: StorageSetting = {
        key: openInAppKey,
        title: pluginId === HOMEASSISTANT_PLUGIN_ID ? `Open in the Homeassistant's Scrypted component`
            : `Tap action opens NVR instead of Zentik`,
        type: 'boolean',
        group,
        subgroup,
        hide: !showMoreConfigurations,
        defaultValue: openInAppDefault,
        immediate: true
    };
    const notificationIconSetting: StorageSetting = {
        key: notificationIconKey,
        title: `Notification icon (i.e. "mdi:webcam")`,
        type: 'string',
        group,
        subgroup,
        hide: !showMoreConfigurations,
    };
    const iconColorSetting: StorageSetting = {
        key: iconColorKey,
        title: `Icon color (i.e. "#FF0000" or "red")`,
        type: 'string',
        group,
        subgroup,
        hide: !showMoreConfigurations,
    };
    const channelSetting: StorageSetting = {
        key: channelKey,
        title: `Notification channel`,
        type: 'string',
        group,
        subgroup,
        hide: !showMoreConfigurations
    };
    const addCameraActionsSetting: StorageSetting = {
        key: addCameraActionsKey,
        title: `Add camera actions`,
        description: 'Add to the notification the default actions defined on the camera',
        type: 'boolean',
        group,
        subgroup,
        hide: !showMoreConfigurations,
        defaultValue: addCameraActionsDefault,
        immediate: true
    };
    const soundSetting: StorageSetting = {
        key: soundKey,
        title: `Notification sound`,
        type: 'string',
        group,
        subgroup,
        hide: !showMoreConfigurations,
    };
    const openNotificationSetting: StorageSetting = {
        key: openNotificationKey,
        title: `Add the default open notification action`,
        type: 'boolean',
        group,
        subgroup,
        hide: !showMoreConfigurations,
        defaultValue: withOpenNotificationDefault,
        immediate: true
    };
    const deleteNotificationSetting: StorageSetting = {
        key: deleteNotificationKey,
        title: `Add the default delete notification action`,
        type: 'boolean',
        group,
        subgroup,
        hide: !showMoreConfigurations,
        defaultValue: withDeleteNotificationDefault,
        immediate: true
    };
    const clearNotificationSetting: StorageSetting = {
        key: clearNotificationKey,
        title: `Add the default clear notification action`,
        type: 'boolean',
        group,
        subgroup,
        hide: !showMoreConfigurations,
        defaultValue: withClearNotificationDefault,
        immediate: true
    };
    const settings = [titleSetting, prioritySetting, addCameraActionsSetting];
    if (withSnoozing) {
        settings.push(addSnoozeSetting);
    }
    if (withActions) {
        settings.push(actionsSetting);
    }
    if (withSound) {
        settings.push(soundSetting);
    }
    if (withOpenInApp) {
        settings.push(openInAppSetting);
    }
    if (withChannel) {
        settings.push(channelSetting);
    }
    if (withNotificationIcon) {
        settings.push(notificationIconSetting);
    }
    if (withIconColor) {
        settings.push(iconColorSetting);
    }
    if (withClearNotification) {
        settings.push(clearNotificationSetting);
    }
    if (withOpenNotification) {
        settings.push(openNotificationSetting);
    }
    if (withDeleteNotification) {
        settings.push(deleteNotificationSetting);
    }

    return settings;
};

export const getRuleSettings = async (props: {
    ruleType: RuleType,
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    device: DeviceBase,
    getSpecificRules: GetSpecificRules,
    refreshSettings: OnRefreshSettings,
    logger: Console
}) => {
    const { ruleType, storage, ruleSource, getSpecificRules, refreshSettings } = props;
    const isPlugin = ruleSource === RuleSource.Plugin;
    const group = isPlugin ? pluginRulesGroup : mixinRulesGroup;
    const settings: StorageSetting[] = [];
    const { rulesKey, subgroupPrefix } = ruleTypeMetadataMap[ruleType];
    const isDetectionRule = ruleType === RuleType.Detection;
    const isOccupancyRule = ruleType === RuleType.Occupancy;
    const isAudioRule = ruleType === RuleType.Audio;
    const isRecordingRule = ruleType === RuleType.Recording;

    const rules = storage.getItem(rulesKey) ?? [];
    for (const ruleName of rules) {
        const subgroup = `${subgroupPrefix}: ${ruleName}`;
        const {
            common: {
                textKey,
                enabledKey,
                currentlyActiveKey,
                activationKey,
                notifiersKey,
                showMoreConfigurationsKey,
                dayKey,
                startTimeKey,
                endTimeKey,
                enabledSensorsKey,
                disabledSensorsKey,
                securitySystemModesKey,
                aiEnabledKey,
                aiPromptKey,
                generateClipKey,
                generateClipSpeedKey,
                generateClipPostSecondsKey,
                generateClipPreSecondsKey,
                generateClipTypeKey,
                generateClipMaxExtensionRangeKey,
                imageProcessingKey,
                totalSnoozeKey,
                onActivationSequencesKey,
                onDeactivationSequencesKey,
                onTriggerSequencesKey,
                onResetSequencesKey,
                showActiveZonesKey,
            }
        } = getRuleKeys({ ruleName, ruleType });

        const currentActivation = storage.getItem(activationKey as any) as DetectionRuleActivation || DetectionRuleActivation.Always;
        const showMoreConfigurations = safeParseJson<boolean>(storage.getItem(showMoreConfigurationsKey), false);
        const aiEnabled = safeParseJson<boolean>(storage.getItem(aiEnabledKey), false);
        const generateClip = safeParseJson<boolean>(storage.getItem(generateClipKey), false);
        const notifiers = safeParseJson<string[]>(storage.getItem(notifiersKey), []);
        const advancedSecurityEnabled = ruleType === RuleType.Detection;
        const isAdvancedSecuritySystem = advancedSecurityEnabled && currentActivation === DetectionRuleActivation.AdvancedSecuritySystem;

        settings.push(
            {
                key: enabledKey,
                title: 'Enabled',
                type: 'boolean',
                group,
                subgroup,
                immediate: true,
                defaultValue: true,
            },
            {
                key: currentlyActiveKey,
                title: 'Currently active',
                type: 'boolean',
                group,
                subgroup,
                readonly: true
            },
            {
                key: showMoreConfigurationsKey,
                title: 'Show more configurations',
                type: 'boolean',
                group,
                subgroup,
                immediate: true,
                onPut: async () => await refreshSettings(),
            },
        );

        if ((isOccupancyRule || isDetectionRule)) {
            settings.push(
                {
                    key: generateClipKey,
                    title: 'Notify with a clip',
                    type: 'boolean',
                    group,
                    subgroup,
                    immediate: true,
                    onPut: async () => await refreshSettings(),
                }
            );

            if (generateClip) {
                settings.push(
                    {
                        key: generateClipSpeedKey,
                        title: 'Clip speed',
                        description: 'Define the speed of the clip',
                        group,
                        subgroup,
                        choices: [
                            VideoclipSpeed.SuperSlow,
                            VideoclipSpeed.Slow,
                            VideoclipSpeed.Realtime,
                            VideoclipSpeed.Fast,
                            VideoclipSpeed.SuperFast,
                        ],
                        type: 'string',
                        immediate: true,
                        defaultValue: VideoclipSpeed.Fast,
                    },
                    {
                        key: generateClipPreSecondsKey,
                        title: 'Clip pre event duration',
                        description: 'How many seconds to record pre event',
                        group,
                        subgroup,
                        type: 'number',
                        defaultValue: isOccupancyRule ?
                            defaultOccupancyClipPreSeconds :
                            defaultClipPreSeconds,
                    },
                    {
                        key: generateClipPostSecondsKey,
                        title: 'Clip post duration',
                        description: 'How many seconds to record post event',
                        group,
                        subgroup,
                        type: 'number',
                        defaultValue: defaultClipPostSeconds
                    },
                    {
                        key: generateClipTypeKey,
                        title: 'Clip type',
                        description: 'MP4 supported only by HA/Zentik notifiers, GIF supported mostly by everything',
                        group,
                        subgroup,
                        immediate: true,
                        type: 'string',
                        choices: [VideoclipType.GIF, VideoclipType.MP4],
                        defaultValue: defaultVideoclipType,
                    },
                    {
                        key: generateClipMaxExtensionRangeKey,
                        title: 'Max clip extension range (seconds)',
                        description: 'Maximum time to extend existing clips instead of generating new ones',
                        group,
                        subgroup,
                        type: 'number',
                        defaultValue: 30,
                    },
                );
            }

            if (isDetectionRule || isOccupancyRule) {
                settings.push(
                    {
                        key: imageProcessingKey,
                        title: 'Image post processing',
                        description: 'Set the post processing of the image. Default depends on the detection source, Crop for NVR and FullFrame for RawDetections',
                        type: 'string',
                        choices: Object.keys(ImagePostProcessing),
                        immediate: true,
                        defaultValue: ImagePostProcessing.Default,
                        group,
                        subgroup,
                    },
                    {
                        key: showActiveZonesKey,
                        title: 'Show active zones',
                        description: 'Highlight active zones in notifications or processing',
                        group,
                        subgroup,
                        type: 'boolean',
                        immediate: true,
                        defaultValue: false,
                    }
                );
            }
        }

        if (isDetectionRule) {
            settings.push(
                {
                    key: aiEnabledKey,
                    title: 'Enable AI to generate descriptions',
                    type: 'boolean',
                    group,
                    subgroup,
                    immediate: true,
                    defaultValue: false,
                    onPut: async () => await refreshSettings(),
                }
            );

            if (aiEnabled) {
                settings.push(
                    {
                        key: aiPromptKey,
                        title: 'AI prompt',
                        description: 'Leave blank to use the general defined in AI section',
                        type: 'textarea',
                        group,
                        subgroup,
                        immediate: true,
                    }
                );
            }
        }

        if (ruleType !== RuleType.Timelapse) {
            settings.push({
                key: activationKey,
                title: 'Activation',
                group,
                subgroup,
                choices: advancedSecurityEnabled ? [
                    DetectionRuleActivation.Always,
                    DetectionRuleActivation.OnActive,
                    DetectionRuleActivation.Schedule,
                    DetectionRuleActivation.AdvancedSecuritySystem,
                ] : [
                    DetectionRuleActivation.Always,
                    DetectionRuleActivation.OnActive,
                    DetectionRuleActivation.Schedule,
                ],
                defaultValue: DetectionRuleActivation.Always,
                placeholder: DetectionRuleActivation.Always,
                immediate: true,
                combobox: true,
                onPut: async () => await refreshSettings()
            });
        }

        const securitySystemModesSetting: StorageSetting = {
            key: securitySystemModesKey,
            title: 'Alarm modes',
            description: 'Modes of the selected security system to trigger this rule',
            group,
            subgroup,
            multiple: true,
            immediate: true,
            combobox: true,
            type: 'string',
            choices: [
                SecuritySystemMode.Disarmed,
                SecuritySystemMode.HomeArmed,
                SecuritySystemMode.NightArmed,
                SecuritySystemMode.AwayArmed,
            ],
            defaultValue: [],
            hide: !showMoreConfigurations
        };

        if (isAdvancedSecuritySystem) {
            settings.push({
                ...securitySystemModesSetting,
                hide: false,
            });
        }

        if (!isRecordingRule) {
            settings.push(
                {
                    key: notifiersKey,
                    title: 'Notifiers',
                    group,
                    subgroup,
                    type: 'device',
                    multiple: true,
                    combobox: true,
                    deviceFilter: notifierFilter,
                    defaultValue: [],
                    immediate: true,
                    onPut: async () => await refreshSettings()
                }
            );
        }

        if (currentActivation === DetectionRuleActivation.Schedule && ruleType !== RuleType.Timelapse) {
            settings.push(
                {
                    key: dayKey,
                    title: 'Day',
                    description: 'Leave empty to affect all days',
                    group,
                    subgroup,
                    type: 'day',
                    multiple: true,
                    immediate: true,
                },
                {
                    key: startTimeKey,
                    title: 'Start time',
                    group,
                    subgroup,
                    type: 'time',
                    immediate: true,
                },
                {
                    key: endTimeKey,
                    title: 'End time',
                    group,
                    subgroup,
                    type: 'time',
                    immediate: true,
                }
            );
        }

        const specificSettings = await getSpecificRules({ ruleName, subgroup, group, showMore: showMoreConfigurations });
        settings.push(...specificSettings);

        const sequenceNames = storage.getItem(ruleSequencesKey) as string[] || [];
        if (currentActivation !== DetectionRuleActivation.Always) {
            settings.push(
                {
                    key: onActivationSequencesKey,
                    title: 'On-activation sequences',
                    description: 'Sequences to execute when the rule is activated',
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    immediate: true,
                    choices: sequenceNames,
                    defaultValue: [],
                    hide: !showMoreConfigurations
                },
                {
                    key: onDeactivationSequencesKey,
                    title: 'On-deactivation sequences',
                    description: 'Sequences to execute when the rule is deactivated',
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    immediate: true,
                    choices: sequenceNames,
                    defaultValue: [],
                    hide: !showMoreConfigurations
                }
            );
        }

        settings.push(
            {
                key: onTriggerSequencesKey,
                title: 'On-trigger sequences',
                description: 'Sequences to execute when the rule is triggered',
                group,
                subgroup,
                multiple: true,
                combobox: true,
                immediate: true,
                choices: sequenceNames,
                defaultValue: [],
                hide: !showMoreConfigurations
            },
            {
                key: onResetSequencesKey,
                title: 'On-reset sequences',
                description: 'Sequences to execute when the rule is reset',
                group,
                subgroup,
                multiple: true,
                combobox: true,
                immediate: true,
                choices: sequenceNames,
                defaultValue: [],
                hide: !showMoreConfigurations
            }
        );

        if (!isOccupancyRule && !isRecordingRule) {
            settings.push({
                key: textKey,
                title: isDetectionRule ? 'Custom text' : 'Notification text',
                description: isAudioRule ?
                    'Available arguments ${duration} ${decibels}' :
                    'Available arguments ${room} ${time} ${nvrLink} ${zone} ${classname} ${label}',
                group,
                subgroup,
                type: 'string',
                defaultValue: isAudioRule ? 'Audio detected: ${decibels} dB for ${duration} seconds' : undefined,
                hide: ruleType === RuleType.Detection && !showMoreConfigurations
            });
        }

        if (!isAdvancedSecuritySystem) {
            settings.push(
                {
                    key: enabledSensorsKey,
                    title: 'Open sensors',
                    description: 'Sensors that must be enabled to trigger this rule',
                    group,
                    subgroup,
                    multiple: true,
                    immediate: true,
                    combobox: true,
                    type: 'device',
                    deviceFilter: sensorsFilter,
                    hide: !showMoreConfigurations
                },
                {
                    key: disabledSensorsKey,
                    title: 'Closed sensors',
                    description: 'Sensors that must be disabled to trigger this rule',
                    group,
                    subgroup,
                    multiple: true,
                    immediate: true,
                    combobox: true,
                    type: 'device',
                    deviceFilter: sensorsFilter,
                    hide: !showMoreConfigurations
                },
                {
                    ...securitySystemModesSetting,
                }
            );
        }

        if (!isRecordingRule) {
            settings.push(
                {
                    key: totalSnoozeKey,
                    title: 'Snooze per rule',
                    description: 'If enabled, snooze actions will act for any notifier of the rule, rather then per used device',
                    type: 'boolean',
                    group,
                    subgroup,
                    immediate: true,
                    defaultValue: false,
                }
            );
        }

        for (const notifierId of notifiers) {
            const notifierSettings = getNotifierSettings({
                group,
                notifierId,
                ruleName,
                ruleType,
                showMoreConfigurations,
                subgroup
            });

            settings.push(...notifierSettings);
        }
    }

    return settings;
}

const getDeviceFilter = (interfaces: ScryptedInterface[]) => {
    const filter: StorageSetting['deviceFilter'] = `interfaces.some(int => ${getInterfacesString(interfaces)}.includes(int))`;
    return filter
}

export const getSequencesSettings = async (props: {
    storage: StorageSettings<any>,
    refreshSettings: OnRefreshSettings,
    logger: Console,
    onTestSequence: (sequenceName: string) => Promise<void>,
}) => {
    const {
        storage,
        refreshSettings,
        onTestSequence,
    } = props;

    const settings: StorageSetting[] = [];

    const sequenceNames = storage.getItem(ruleSequencesKey) as string[] || [];
    const group = ruleSequencesGroup;

    for (const sequenceName of sequenceNames) {
        const subgroup = `${sequenceName}`;
        const { actionsKey, minimumExecutionDelayKey, enabledKey, testKey } = getSequenceKeys({ sequenceName });
        const actionNames = safeParseJson<string[]>(storage.getItem(actionsKey), []);

        settings.push(
            {
                key: enabledKey,
                title: 'Enabled',
                type: 'boolean',
                group,
                subgroup,
                immediate: true,
                defaultValue: true,
                onPut: async () => await refreshSettings(),
            },
            {
                key: minimumExecutionDelayKey,
                title: 'Minimum execution delay (seconds)',
                type: 'number',
                group,
                subgroup,
                immediate: true,
                defaultValue: 15,
                onPut: async () => await refreshSettings(),
            },
            {
                key: actionsKey,
                title: 'Actions',
                type: 'string',
                group,
                multiple: true,
                subgroup,
                choices: [],
                combobox: true,
                immediate: true,
                onPut: async () => await refreshSettings(),
            },
        )

        for (const actionName of actionNames) {
            const {
                actionTitleKey,
                deviceIdKey,
                presetNameKey,
                typeKey,
                switchEnabledKey,
                waitSecondsKey,
                lockStateKey,
                entryStateKey,
            } = getSequenceKeys({ sequenceName, actionName });
            const currentType = storage.getItem(typeKey as any) as RuleActionType;
            const device = storage.getItem(deviceIdKey as any) as DeviceBase;

            settings.push(
                {
                    key: `Action: ${actionTitleKey}`,
                    title: `${actionName}`,
                    description: `Define the action settings below for ${actionName}`,
                    type: 'html',
                    group,
                    subgroup,
                },
                {
                    key: typeKey,
                    title: `Action type`,
                    type: 'string',
                    group,
                    subgroup,
                    choices: Object.values(RuleActionType),
                    immediate: true,
                    onPut: async () => await refreshSettings(),
                }
            );

            if (currentType) {
                if (currentType === RuleActionType.Wait) {
                    settings.push(
                        {
                            key: waitSecondsKey,
                            title: `Seconds`,
                            type: 'number',
                            group,
                            subgroup,
                            immediate: true,
                            onPut: async () => await refreshSettings(),
                        }
                    );
                } if (currentType === RuleActionType.Script) {
                    const ruleActionDevicesFilter = getDeviceFilter(ruleActionDeviceInterfacesMap[currentType] || []);

                    settings.push(
                        {
                            key: deviceIdKey,
                            title: `Script`,
                            group,
                            subgroup,
                            immediate: true,
                            type: 'device',
                            deviceFilter: ruleActionDevicesFilter,
                            onPut: async () => await refreshSettings(),
                        }
                    );
                } else {
                    const ruleActionDevicesFilter = getDeviceFilter(ruleActionDeviceInterfacesMap[currentType] || []);

                    settings.push({
                        key: deviceIdKey,
                        title: `Device`,
                        group,
                        subgroup,
                        immediate: true,
                        type: 'device',
                        deviceFilter: ruleActionDevicesFilter,
                        onPut: async () => await refreshSettings(),
                    });

                    if (device) {
                        const foundDevice = sdk.systemManager.getDeviceById<PanTiltZoom>(device.id);
                        if (foundDevice) {
                            if (currentType === RuleActionType.Ptz) {
                                const presetNames = Object.entries(foundDevice.ptzCapabilities?.presets || {}).map(
                                    item => `${item[1]}:${item[0]}`
                                );
                                settings.push(
                                    {
                                        key: presetNameKey,
                                        title: `Preset name`,
                                        type: 'string',
                                        group,
                                        subgroup,
                                        immediate: true,
                                        choices: presetNames,
                                        onPut: async () => await refreshSettings(),
                                    }
                                );
                            } else if (currentType === RuleActionType.Switch) {
                                settings.push(
                                    {
                                        key: switchEnabledKey,
                                        title: `On/Off`,
                                        type: 'boolean',
                                        group,
                                        subgroup,
                                        immediate: true,
                                        onPut: async () => await refreshSettings(),
                                    }
                                );
                            } else if (currentType === RuleActionType.Lock) {
                                settings.push(
                                    {
                                        key: lockStateKey,
                                        title: `Lock/unlock`,
                                        type: 'boolean',
                                        group,
                                        subgroup,
                                        immediate: true,
                                        onPut: async () => await refreshSettings(),
                                    }
                                );
                            } else if (currentType === RuleActionType.Entry) {
                                settings.push(
                                    {
                                        key: entryStateKey,
                                        title: `Open/close`,
                                        type: 'boolean',
                                        group,
                                        subgroup,
                                        immediate: true,
                                        onPut: async () => await refreshSettings(),
                                    }
                                );
                            }
                        }
                    }
                }
            }
        }

        settings.push({
            key: testKey,
            title: 'Test sequence',
            type: 'button',
            group,
            subgroup,
            immediate: true,
            onPut: async () => {
                await onTestSequence(sequenceName);
            },
        });
    }

    return settings;
}

export const getDetectionRulesSettings = async (props: {
    storage: StorageSettings<any>,
    zones?: string[],
    frigateZones?: string[],
    people?: string[],
    frigateLabels?: string[],
    audioLabels?: string[],
    ruleSource: RuleSource,
    device?: DeviceBase,
    refreshSettings: OnRefreshSettings,
    logger: Console,
    plugin: AdvancedNotifierPlugin
}) => {
    const {
        storage,
        zones,
        frigateZones,
        device,
        ruleSource,
        frigateLabels,
        refreshSettings,
        logger,
        people,
        audioLabels,
        plugin
    } = props;
    const isPlugin = ruleSource === RuleSource.Plugin;
    const { isCamera } = !isPlugin ? isDeviceSupported(device) : {};

    const getSpecificRules: GetSpecificRules = async ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { detection, common, } = getRuleKeys({ ruleName, ruleType: RuleType.Detection });

        const { scoreThresholdKey, activationKey, minDelayKey, minMqttPublishDelayKey, devicesKey } = common;
        const {
            blacklistedZonesKey,
            nvrEventsKey,
            frigateLabelsKey,
            audioLabelsKey,
            recordingTriggerSecondsKey,
            useNvrDetectionsKey,
            detectionSourceKey,
            whitelistedZonesKey,
            detectionClassesKey,
            peopleKey,
            plateMaxDistanceKey,
            platesKey,
            labelScoreKey,
            clipDescriptionKey,
            clipConfidenceKey,
            aiFilterKey,
        } = detection;

        const useNvrDetections = storage.getItem(useNvrDetectionsKey) as boolean ?? false;
        const clipDescription = storage.getItem(clipDescriptionKey) as string ?? '';
        const detectionClasses = safeParseJson<DetectionClass[]>(storage.getItem(detectionClassesKey), []);
        const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
        const detectionSource = storage.getItem(detectionSourceKey) as ScryptedEventSource ||
            (useNvrDetections ? ScryptedEventSource.NVR : ScryptedEventSource.RawDetection);
        const showCameraSettings = isPlugin || isCamera;

        if (isCamera || isPlugin) {
            settings.push(
                {
                    key: detectionSourceKey,
                    title: 'Detections source',
                    description: 'Select which detections should be used. The snapshots will come from the same source',
                    type: 'string',
                    defaultValue: detectionSource,
                    group,
                    subgroup,
                    immediate: true,
                    combobox: true,
                    onPut: async () => {
                        await refreshSettings()
                    },
                    choices: frigateLabels ? [
                        ScryptedEventSource.RawDetection,
                        ScryptedEventSource.NVR,
                        ScryptedEventSource.Frigate,
                    ] : [
                        ScryptedEventSource.RawDetection,
                        ScryptedEventSource.NVR,
                    ]
                }
            );
        }

        const isFrigate = detectionSource === ScryptedEventSource.Frigate;
        const isNvr = detectionSource === ScryptedEventSource.NVR;
        const isRawDetection = detectionSource === ScryptedEventSource.RawDetection;

        if (showCameraSettings) {
            settings.push(
                {
                    key: detectionClassesKey,
                    title: 'Detection classes',
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    choices: [
                        ...defaultDetectionClasses,
                        ...Object.values(SupportedSensorType),
                    ],
                    defaultValue: [],
                    immediate: true,
                    onPut: async () => {
                        await refreshSettings()
                    },
                },
            );

            if (isFrigate) {
                const frigateLabelsChoices = frigateLabels?.filter(label => {
                    const det = detectionClassesDefaultMap[label];

                    return det && detectionClasses.includes(det);
                });
                settings.push(
                    {
                        key: frigateLabelsKey,
                        title: 'Frigate labels',
                        group,
                        subgroup,
                        multiple: true,
                        combobox: true,
                        immediate: true,
                        choices: frigateLabelsChoices,
                        defaultValue: []
                    }
                );
            }

            if (isRawDetection && detectionClasses.includes(DetectionClass.Audio)) {
                settings.push(
                    {
                        key: audioLabelsKey,
                        title: 'Audio labels',
                        description: 'Leave blank to trigger on every audio event',
                        group,
                        subgroup,
                        multiple: true,
                        combobox: true,
                        immediate: true,
                        choices: audioLabels,
                        defaultValue: []
                    }
                );
            }

            if (isNvr && isPlugin) {
                settings.push(
                    {
                        key: nvrEventsKey,
                        title: 'NVR events',
                        group,
                        subgroup,
                        multiple: true,
                        combobox: true,
                        immediate: true,
                        choices: Object.values(NvrEvent),
                        defaultValue: []
                    },
                );
            }

            settings.push(
                {
                    key: clipDescriptionKey,
                    title: 'CLIP Description',
                    type: 'string',
                    group,
                    subgroup,
                    onPut: async () => {
                        await refreshSettings()
                    },
                },
            );

            if (clipDescription) {
                settings.push(
                    {
                        key: clipConfidenceKey,
                        title: 'CLIP confidence level',
                        description: 'Low could include false positives in the result',
                        type: 'string',
                        choices: Object.keys(SimilarityConfidence),
                        immediate: true,
                        defaultValue: SimilarityConfidence.Medium,
                        group,
                        subgroup,
                    },
                );
            }

            settings.push(
                {
                    key: aiFilterKey,
                    title: 'AI filter',
                    description: 'The prompt should be a question. This plugin will force the answer to be yes/no',
                    placeholder: 'Does the image show a guy with a red hat?',
                    type: 'string',
                    group,
                    subgroup,
                    onPut: async () => {
                        await refreshSettings()
                    },
                },
            );

            settings.push(
                {
                    key: scoreThresholdKey,
                    title: 'Score threshold',
                    description: 'Applied after detections. Threshold defined on the object detector will still take precedence, default to 0.5 for audio events, 0.7 otherwise',
                    group,
                    subgroup,
                    type: 'number',
                    hide: !showMore
                },
            );

            const hasFace = detectionClasses.includes(DetectionClass.Face);
            const hasPlate = detectionClasses.includes(DetectionClass.Plate);

            if (hasFace || hasPlate) {
                settings.push({
                    key: labelScoreKey,
                    title: 'Minimum label score',
                    description: 'Leave blank to match any score',
                    group,
                    subgroup,
                });
            }

            if (hasFace) {
                settings.push({
                    key: peopleKey,
                    title: 'Whitelisted faces',
                    description: 'Leave blank to match faces',
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    choices: people,
                    defaultValue: [],
                    immediate: true,
                });
            }

            if (hasPlate) {
                settings.push(
                    {
                        key: platesKey,
                        title: 'Whitelisted plates',
                        description: 'Leave blank to match plate',
                        group,
                        subgroup,
                        multiple: true,
                        combobox: true,
                        choices: [],
                        defaultValue: [],
                        immediate: true,
                    },
                    {
                        key: plateMaxDistanceKey,
                        title: 'Plate max distance',
                        description: 'Define how many characters the plate can differ (Whitespaces will not considered)',
                        group,
                        subgroup,
                        type: 'number',
                        defaultValue: 2,
                    }
                );
            }
        }

        if (isPlugin && activationType !== DetectionRuleActivation.OnActive) {
            settings.push({
                key: devicesKey,
                title: 'Devices',
                description: 'If empty, all devices will apply',
                group,
                subgroup,
                type: 'device',
                multiple: true,
                immediate: true,
                combobox: true,
                deviceFilter: isFrigate ? frigateCamerasFilter : deviceFilter,
                defaultValue: [],
                onPut: async () => await refreshSettings(),
            });
        }

        let zonesToUse: string[] = [];

        if (!isCamera) {
            const devices = storage.getItem(devicesKey) as string[] ?? [];

            for (const deviceId of devices) {
                const deviceMixin = plugin.currentCameraMixinsMap[deviceId];
                if (deviceMixin) {
                    const zones = (await deviceMixin.getObserveZones()).map(item => item.name);
                    const { frigateZones } = await deviceMixin.getFrigateData();

                    const cameraZones = isFrigate ? frigateZones : zones;
                    for (const cameraZone of cameraZones) {
                        zonesToUse.push(`${deviceMixin.name}::${cameraZone}`);
                    }
                }
            }
        } else {
            zonesToUse = isFrigate ? frigateZones : zones;
        }

        const zonesDescription = isFrigate ? 'Zones defined on the Frigate interface' :
            'Zones defined in the `Object detection` section of type `Observe`';
        if (zonesToUse) {
            settings.push(
                {
                    key: whitelistedZonesKey,
                    title: 'Whitelisted zones',
                    description: zonesDescription,
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    immediate: true,
                    choices: zonesToUse,
                    readonly: !zonesToUse?.length,
                    defaultValue: []
                },
                {
                    key: blacklistedZonesKey,
                    title: 'Blacklisted zones',
                    description: zonesDescription,
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    immediate: true,
                    choices: zonesToUse,
                    readonly: !zonesToUse?.length,
                    defaultValue: []
                },
            );
        }

        let minDelayDescription = 'Minimum amount of seconds to wait until a notification is sent for the same detection type.';
        if (isPlugin) {
            minDelayDescription += ' Overrides the device setting';
        }

        settings.push(
            {
                key: minDelayKey,
                title: 'Minimum notification delay',
                description: minDelayDescription,
                group,
                subgroup,
                type: 'number',
                placeholder: '-',
                hide: !showMore
            },
            {
                key: minMqttPublishDelayKey,
                title: 'Minimum MQTT publish delay',
                description: 'Minimum amount of seconds to wait until a new image is published on MQTT',
                group,
                subgroup,
                type: 'number',
                placeholder: '15',
                defaultValue: 15,
                hide: !showMore
            },
            {
                key: recordingTriggerSecondsKey,
                title: 'Disable recording in seconds',
                description: 'Set a value here in seconds to enable the camera recording when the rule is triggered. After the seconds specified, recording will be disabled',
                group,
                subgroup,
                type: 'number',
                placeholder: '-',
                hide: !showMore
            },
        )

        return settings;
    };

    return getRuleSettings({
        getSpecificRules,
        ruleSource,
        ruleType: RuleType.Detection,
        storage,
        refreshSettings,
        logger,
        device,
    });
}

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById(NVR_PLUGIN_ID, 'motion')?.id;

export const getOccupancyRulesSettings = async (props: {
    storage: StorageSettings<any>,
    zones?: string[],
    ruleSource: RuleSource,
    refreshSettings: OnRefreshSettings,
    onManualCheck: (ruleName: string) => Promise<void>,
    logger: Console,
    device: DeviceBase,
}) => {
    const { storage, zones, ruleSource, refreshSettings, logger, device, onManualCheck } = props;

    const getSpecificRules: GetSpecificRules = async ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { occupancy, common } = getRuleKeys({ ruleName, ruleType: RuleType.Occupancy });

        const { scoreThresholdKey } = common;
        const {
            captureZoneKey,
            changeStateConfirmKey,
            forceUpdateKey,
            maxObjectsKey,
            zoneKey,
            zoneMatchTypeKey,
            zoneNotOccupiedTextKey,
            zoneOccupiedTextKey,
            detectionClassKey,
            detectedObjectsKey,
            confirmWithAiKey,
            occupiesKey,
            manualCheckKey
        } = occupancy;

        settings.push(
            {
                key: occupiesKey,
                title: 'Occupies',
                type: 'boolean',
                group,
                subgroup,
                readonly: true,
            },
            {
                key: detectedObjectsKey,
                title: 'Detected objects',
                type: 'number',
                group,
                subgroup,
                readonly: true,
            },
            {
                key: detectionClassKey,
                title: 'Detection class',
                group,
                subgroup,
                choices: basicDetectionClasses,
                immediate: true
            },
            {
                key: zoneKey,
                title: 'Observe zone',
                group,
                subgroup,
                choices: zones,
                readonly: !zones.length,
                immediate: true
            },
            {
                key: confirmWithAiKey,
                title: 'Confirm occupancy with AI',
                description: 'In the final stages of check, confirm the result with AI to avoid false positives',
                group,
                subgroup,
                immediate: true,
                type: 'boolean'
            },
            {
                key: captureZoneKey,
                title: 'Capture zone',
                group,
                subgroup,
                type: 'clippath',
                hide: !showMore
            },
            {
                key: zoneMatchTypeKey,
                title: 'Zone type',
                group,
                subgroup,
                choices: Object.values(ZoneMatchType),
                defaultValue: ZoneMatchType.Intersect,
                immediate: true
            },
            {
                key: scoreThresholdKey,
                title: 'Score threshold',
                group,
                subgroup,
                type: 'number',
                placeholder: '0.5',
            },
            {
                key: changeStateConfirmKey,
                title: 'Occupancy confirmation',
                description: 'Seconds to wait until an occupancy state change gets confirmed',
                group,
                subgroup,
                type: 'number',
                placeholder: '30',
            },
            {
                key: forceUpdateKey,
                title: 'Force update in seconds',
                description: 'Seconds to wait until a force update should happen',
                group,
                subgroup,
                type: 'number',
                placeholder: '30',
            },
            {
                key: maxObjectsKey,
                title: 'Max objects',
                description: 'Amount of objects that can fit the zone (if set to 2 and only 1 is detected, zone will be considered free)',
                group,
                subgroup,
                type: 'number',
                placeholder: '1',
                hide: !showMore
            },
            {
                key: zoneOccupiedTextKey,
                title: 'Zone occupied text',
                description: 'Text to use for the notification when the rule gets activated (zone occupied). Available arguments ${detectedObjects} ${maxObjects}',
                group,
                subgroup,
                type: 'string',
            },
            {
                key: zoneNotOccupiedTextKey,
                title: 'Zone not occupied text',
                description: 'Text to use for the notification when the rule gets deactivated (zone not occupied). Available arguments ${detectedObjects} ${maxObjects}',
                group,
                subgroup,
                type: 'string',
            },
            {
                key: manualCheckKey,
                title: 'Check manually with AI',
                group,
                subgroup,
                type: 'button',
                onPut: async () => await onManualCheck(ruleName),
            },
        );

        return settings;
    };

    return getRuleSettings({
        getSpecificRules,
        ruleSource,
        ruleType: RuleType.Occupancy,
        storage,
        refreshSettings,
        logger,
        device,
    });
}

export const getTimelapseRulesSettings = async (props: {
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    onGenerateTimelapse: (ruleName: string) => Promise<void>,
    onCleanDataTimelapse: (ruleName: string) => Promise<void>,
    refreshSettings: OnRefreshSettings,
    logger: Console,
    device: DeviceBase,
}) => {
    const { storage, ruleSource, onCleanDataTimelapse, onGenerateTimelapse, refreshSettings, logger, device } = props;

    const getSpecificRules: GetSpecificRules = async ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { timelapse, common } = getRuleKeys({ ruleName, ruleType: RuleType.Timelapse });

        const { textKey, dayKey, startTimeKey, endTimeKey } = common;
        const {
            cleanDataKey,
            framesAcquisitionDelayKey,
            generateKey,
            regularSnapshotIntervalKey,
            timelapseFramerateKey,
        } = timelapse;

        settings.push(
            {
                key: textKey,
                title: 'Notification message',
                group,
                subgroup,
                value: storage.getItem(textKey),
                type: 'string',
            },
            {
                key: regularSnapshotIntervalKey,
                title: 'Force snapshot seconds',
                description: 'Force a frame acquisition on a regular basis',
                group,
                subgroup,
                type: 'number',
                placeholder: '15',
                defaultValue: 15
            },
            {
                key: dayKey,
                title: 'Day',
                description: 'Leave empty to affect all days',
                group,
                subgroup,
                type: 'day',
                multiple: true,
                immediate: true,
                defaultValue: []
            },
            {
                key: startTimeKey,
                immediate: true,
                title: 'Start time',
                group,
                subgroup,
                type: 'time',
            },
            {
                key: endTimeKey,
                immediate: true,
                title: 'End time',
                group,
                subgroup,
                type: 'time',
            },
            {
                key: framesAcquisitionDelayKey,
                title: 'Frames acquisition delay',
                description: 'Minimum amount of seconds to wait until a new frame is recorded',
                group,
                subgroup,
                type: 'number',
                placeholder: '2',
                defaultValue: 2,
                hide: !showMore
            },
            {
                key: timelapseFramerateKey,
                title: 'Timelapse framerate',
                description: 'Framerate of the output timelapse',
                group,
                subgroup,
                type: 'number',
                placeholder: '10',
                defaultValue: 10,
                hide: !showMore
            },
            {
                key: generateKey,
                title: 'Generate now',
                group,
                subgroup,
                type: 'button',
                onPut: async () => onGenerateTimelapse(ruleName),
                hide: !showMore
            },
            {
                key: cleanDataKey,
                title: 'Cleanup data',
                group,
                subgroup,
                type: 'button',
                onPut: async () => onCleanDataTimelapse(ruleName),
                hide: !showMore
            }
        );

        return settings;
    };

    return getRuleSettings({
        getSpecificRules,
        ruleSource,
        ruleType: RuleType.Timelapse,
        storage,
        refreshSettings,
        logger,
        device,
    });
}

export const getAudioRulesSettings = async (props: {
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    refreshSettings: OnRefreshSettings,
    logger: Console,
    device: DeviceBase,
}) => {
    const { storage, ruleSource, refreshSettings, logger, device } = props;

    const getSpecificRules: GetSpecificRules = async ({ group, ruleName, subgroup }) => {
        const settings: StorageSetting[] = [];

        const { audio, common } = getRuleKeys({ ruleName, ruleType: RuleType.Audio });

        const { textKey, minDelayKey } = common;
        const { decibelThresholdKey, audioDurationKey, hitPercentageKey } = audio;

        settings.push(
            {
                key: textKey,
                title: 'Notification message',
                group,
                subgroup,
                value: storage.getItem(textKey),
                type: 'string',
            },
            {
                key: decibelThresholdKey,
                title: 'Decibel threshold',
                description: 'Decibel value to trigger the notification',
                group,
                subgroup,
                type: 'number',
                placeholder: '-30',
                defaultValue: -30
            },
            {
                key: audioDurationKey,
                title: 'Samples window',
                description: 'How many seconds to analyze. (Basic object detector emits by default every 2 seconds)',
                group,
                subgroup,
                type: 'number',
                placeholder: '6',
                defaultValue: 6,
            },
            {
                key: hitPercentageKey,
                title: 'Hits percentage',
                description: 'How many samples must hit de threshold to consider the notification',
                group,
                subgroup,
                type: 'number',
                placeholder: '80',
                defaultValue: 80,
            },
            {
                key: minDelayKey,
                title: 'Minimum notification delay',
                description: 'Minimum amount of seconds to wait between notifications.',
                group,
                subgroup,
                type: 'number',
                placeholder: '-',
                defaultValue: 10,
            },
        );

        return settings;
    };

    return getRuleSettings({
        getSpecificRules,
        ruleSource,
        ruleType: RuleType.Audio,
        storage,
        refreshSettings,
        logger,
        device,
    });
}

export function getRecordingRules(props: {
    deviceStorage?: StorageSettings<any>,
    pluginStorage: StorageSettings<any>,
    console: Console,
    device?: DeviceBase,
}) {
    const { deviceStorage, pluginStorage, console, device } = props;
    const ruleType = RuleType.Recording;
    const { rulesKey } = ruleTypeMetadataMap[ruleType];
    const { securitySystem } = pluginStorage.values;
    const deviceId = device?.id;

    const availableRules: RecordingRule[] = [];
    const allowedRules: RecordingRule[] = [];

    const deviceRules = deviceStorage?.getItem(rulesKey) as string[] || [];
    const pluginRules = pluginStorage?.getItem(rulesKey) as string[] || [];

    const processRules = (rules: string[], source: RuleSource) => {
        const isPlugin = source === RuleSource.Plugin;
        const isDevice = source === RuleSource.Device;
        const storage = isDevice ? deviceStorage : pluginStorage;
        for (const ruleName of rules) {
            const { recording, common } = getRuleKeys({ ruleName, ruleType });

            const { devicesKey } = common;
            const {
                recordingDetectionClassesKey,
                recordingScoreThresholdKey,
                postEventSecondsKey,
                maxClipLengthKey,
                prolongClipOnMotionKey,
            } = recording;

            const detectionClasses = storage.getItem(recordingDetectionClassesKey) as string[] || [];
            const scoreThreshold = storage.getItem(recordingScoreThresholdKey) as number;
            const postEventSeconds = storage.getItem(postEventSecondsKey) as number;
            const maxClipLength = storage.getItem(maxClipLengthKey) as number;
            const prolongClipOnMotion = storage.getItem(prolongClipOnMotionKey) as boolean;
            const mainDevices = storage.getItem(devicesKey) as string[] ?? [];
            const allDevices = getElegibleDevices().map(device => device.id);

            const devices = !isPlugin ? [deviceId] : mainDevices.length ? mainDevices : allDevices;

            const { rule, basicRuleAllowed } = initBasicRule({
                ruleName,
                ruleSource: source,
                ruleType: RuleType.Recording,
                storage,
                securitySystem,
                logger: console
            });

            const recordingRule: RecordingRule = {
                ...rule,
                detectionClasses,
                scoreThreshold,
                postEventSeconds,
                maxClipLength,
                prolongClipOnMotion,
                devices,
            };

            availableRules.push(recordingRule);
            const deviceOk = (!!devices?.length && (deviceId ? devices.includes(deviceId) : true));

            if (basicRuleAllowed && deviceOk) {
                allowedRules.push(recordingRule);
            }
        }
    }

    processRules(pluginRules, RuleSource.Plugin);

    if (deviceStorage) {
        processRules(deviceRules, RuleSource.Device);
    }

    return {
        availableRules,
        allowedRules,
    };
}

export const getRecordingRulesSettings = async (props: {
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    refreshSettings: OnRefreshSettings,
    logger: Console,
    device?: DeviceBase,
}) => {
    const { storage, ruleSource, refreshSettings, logger, device } = props;

    const getSpecificRules: GetSpecificRules = async ({ group, ruleName, subgroup }) => {
        const settings: StorageSetting[] = [];

        const { recording, common } = getRuleKeys({ ruleName, ruleType: RuleType.Recording });
        const { devicesKey, minDelayKey } = common;

        const {
            recordingDetectionClassesKey,
            recordingScoreThresholdKey,
            postEventSecondsKey,
            maxClipLengthKey,
            prolongClipOnMotionKey,
        } = recording;

        settings.push(
            {
                key: devicesKey,
                title: 'Devices',
                description: 'Select cameras',
                group,
                subgroup,
                type: 'device',
                multiple: true,
                immediate: true,
                combobox: true,
                deviceFilter: cameraFilter,
                defaultValue: [],
                onPut: async () => await refreshSettings(),
            },
            {
                key: recordingDetectionClassesKey,
                title: 'Detection classes',
                description: 'Classes to trigger the recording',
                group,
                subgroup,
                type: 'string',
                multiple: true,
                combobox: true,
                choices: basicDetectionClasses,
                defaultValue: [DetectionClass.Person],
            },
            {
                key: recordingScoreThresholdKey,
                title: 'Score threshold',
                description: 'Minimum score to trigger the recording',
                group,
                subgroup,
                type: 'number',
            },
            {
                key: minDelayKey,
                title: 'Minimum delay between clips',
                description: 'Minimum seconds between recordings',
                group,
                subgroup,
                type: 'number',
                defaultValue: 30,
            },
            {
                key: postEventSecondsKey,
                title: 'Post event seconds',
                description: 'Seconds to record after the event',
                group,
                subgroup,
                type: 'number',
                defaultValue: 10,
            },
            {
                key: maxClipLengthKey,
                title: 'Max clip length',
                description: 'Maximum length of the clip in seconds',
                group,
                subgroup,
                type: 'number',
                defaultValue: 60,
            },
            {
                key: prolongClipOnMotionKey,
                title: 'Prolong clip on motion',
                description: 'Continue recording if motion is detected',
                group,
                subgroup,
                type: 'boolean',
                defaultValue: true,
                immediate: true,
            }
        );

        return settings;
    };

    return getRuleSettings({
        getSpecificRules,
        ruleSource,
        ruleType: RuleType.Recording,
        storage,
        refreshSettings,
        logger,
        device,
    });
}

export enum RuleSource {
    Plugin = 'Plugin',
    Device = 'Device',
}

export interface Action {
    aciton: string;
    title: string;
    icon: string;
}

export interface BaseRule {
    activationType: DetectionRuleActivation;
    source: RuleSource;
    isEnabled: boolean;
    currentlyActive?: boolean;
    useAi: boolean;
    aiPrompt: string;
    ruleType: RuleType;
    name: string;
    deviceId?: string;
    notifiers: string[];
    customText?: string;
    securitySystemModes?: SecuritySystemMode[];
    minDelay?: number;
    minMqttPublishDelay?: number;
    devices?: string[];
    startRuleText?: string;
    endRuleText?: string;
    generateClip: boolean;
    totalSnooze: boolean;
    generateClipSpeed: VideoclipSpeed;
    generateClipType: VideoclipType;
    generateClipPostSeconds: number;
    generateClipPreSeconds: number;
    onActivationSequences?: RuleActionsSequence[];
    onDeactivationSequences?: RuleActionsSequence[];
    onTriggerSequences?: RuleActionsSequence[];
    onResetSequences?: RuleActionsSequence[];
    imageProcessing: ImagePostProcessing;
    showActiveZones?: boolean;
    notifierData: Record<string, {
        actions: ExtendedNotificationAction[],
        priority: NotificationPriority,
        addSnooze: boolean,
        addCameraActions: boolean,
        sound: string,
        openInApp?: boolean,
        channel?: string,
        notificationIcon?: string,
        iconColor?: string,
        addDeleteNotificationAction?: boolean,
        addClearNotificationAction?: boolean,
        addOpenNotificationAction?: boolean,
    }>;
}

export interface DetectionRule extends BaseRule {
    detectionClasses?: RuleDetectionClass[];
    nvrEvents?: NvrEvent[];
    frigateLabels?: string[];
    audioLabels?: string[];
    scoreThreshold?: number;
    labelScoreThreshold?: number;
    whitelistedZones?: string[];
    blacklistedZones?: string[];
    people?: string[];
    plates?: string[];
    clipDescription?: string;
    aiFilter?: string;
    clipConfidence?: SimilarityConfidence;
    plateMaxDistance?: number;
    disableNvrRecordingSeconds?: number;
    detectionSource?: ScryptedEventSource;
    maxClipExtensionRange?: number;
}

export interface RecordingRule extends BaseRule {
    detectionClasses: string[];
    scoreThreshold: number;
    postEventSeconds: number;
    maxClipLength: number;
    prolongClipOnMotion: boolean;
}

export const getMinutes = (date: Moment) => date.minutes() + (date.hours() * 60);

export const isSchedulerActive = (props: { startTime: number, endTime: number }) => {
    const { startTime, endTime } = props;
    let enabled = false;
    const referenceStart = moment(Number(startTime));
    const referenceEnd = moment(Number(endTime));
    const now = moment();

    const startMinutes = getMinutes(referenceStart);
    const nowMinutes = getMinutes(now);
    const endMinutes = getMinutes(referenceEnd);

    if (startMinutes > endMinutes) {
        // Interval crosses midnight
        if (nowMinutes < startMinutes) {
            // current time crosses midnight
            enabled = nowMinutes <= endMinutes;
        } else {
            enabled = nowMinutes >= startMinutes;
        }
    } else {
        enabled = nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    }

    return enabled;
};

const initBasicRule = (props: {
    ruleType: RuleType,
    storage?: StorageSettings<string>,
    ruleName: string,
    ruleSource: RuleSource,
    securitySystem?: ScryptedDeviceBase,
    logger: Console
}) => {
    const { storage, ruleType, ruleName, ruleSource, securitySystem, logger } = props;

    const { common: {
        currentlyActiveKey,
        activationKey,
        dayKey,
        startTimeKey,
        endTimeKey,
        enabledSensorsKey,
        disabledSensorsKey,
        securitySystemModesKey,
        enabledKey,
        notifiersKey,
        textKey,
        aiEnabledKey,
        aiPromptKey,
        generateClipKey,
        generateClipSpeedKey,
        generateClipPostSecondsKey,
        generateClipPreSecondsKey,
        generateClipTypeKey,
        imageProcessingKey,
        totalSnoozeKey,
        onActivationSequencesKey,
        onDeactivationSequencesKey,
        onTriggerSequencesKey,
        onResetSequencesKey,
        devicesKey,
        showActiveZonesKey,
    } } = getRuleKeys({
        ruleType,
        ruleName,
    });

    const isEnabled = storage.getItem(enabledKey);
    const currentlyActive = storage.getItem(currentlyActiveKey);
    const useAi = storage.getItem(aiEnabledKey);
    const aiPrompt = storage.getItem(aiPromptKey);
    const customText = storage.getItem(textKey);
    const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
    const generateClipSpeed = storage.getItem(generateClipSpeedKey) as VideoclipSpeed || VideoclipSpeed.Fast;
    const securitySystemModes = storage.getItem(securitySystemModesKey) as SecuritySystemMode[] ?? [];
    const notifiers = storage.getItem(notifiersKey) as string[] ?? [];
    const generateClip = storage.getItem(generateClipKey) as boolean ?? false;
    const totalSnooze = storage.getItem(totalSnoozeKey) as boolean ?? false;
    const generateClipPostSeconds = safeParseJson<number>(storage.getItem(generateClipPostSecondsKey)) ?? (ruleType === RuleType.Occupancy ? defaultOccupancyClipPreSeconds : defaultClipPreSeconds);
    const generateClipPreSeconds = safeParseJson<number>(storage.getItem(generateClipPreSecondsKey)) ?? defaultClipPostSeconds;
    const generateClipType = storage.getItem(generateClipTypeKey) ?? defaultVideoclipType;
    const imageProcessing = (storage.getItem(imageProcessingKey) as ImagePostProcessing) || ImagePostProcessing.Default;
    const showActiveZones = storage.getItem(showActiveZonesKey) as boolean ?? false;
    const onActivationSequencesNames = storage.getItem(onActivationSequencesKey) as string[] ?? [];
    const onDeactivationSequencesNames = storage.getItem(onDeactivationSequencesKey) as string[] ?? [];
    const onTriggerSequencesNames = storage.getItem(onTriggerSequencesKey) as string[] ?? [];
    const onResetSequencesNames = storage.getItem(onResetSequencesKey) as string[] ?? [];
    const devices = storage.getItem(devicesKey) as string[] ?? [];

    const onActivationSequences: RuleActionsSequence[] = [];
    const onDeactivationSequences: RuleActionsSequence[] = [];
    if (activationType !== DetectionRuleActivation.Always) {
        for (const sequenceName of onActivationSequencesNames) {
            const sequenceObject = getSequenceObject({ sequenceName, storage });
            if (sequenceObject) {
                onActivationSequences.push(sequenceObject);
            }
        }
        for (const sequenceName of onDeactivationSequencesNames) {
            const sequenceObject = getSequenceObject({ sequenceName, storage });
            if (sequenceObject) {
                onDeactivationSequences.push(sequenceObject);
            }
        }
    }

    const onTriggerSequences: RuleActionsSequence[] = [];
    for (const sequenceName of onTriggerSequencesNames) {
        const sequenceObject = getSequenceObject({ sequenceName, storage });
        if (sequenceObject) {
            onTriggerSequences.push(sequenceObject);
        }
    }
    const onResetSequences: RuleActionsSequence[] = [];
    for (const sequenceName of onResetSequencesNames) {
        const sequenceObject = getSequenceObject({ sequenceName, storage });
        if (sequenceObject) {
            onResetSequences.push(sequenceObject);
        }
    }

    const rule: BaseRule = {
        isEnabled,
        imageProcessing,
        showActiveZones,
        ruleType,
        useAi,
        aiPrompt,
        currentlyActive,
        name: ruleName,
        notifiers,
        customText,
        totalSnooze,
        activationType,
        source: ruleSource,
        securitySystemModes,
        devices,
        generateClip,
        generateClipType,
        generateClipSpeed: generateClip ? generateClipSpeed : undefined,
        generateClipPostSeconds: generateClip ? generateClipPostSeconds : undefined,
        generateClipPreSeconds: generateClip ? generateClipPreSeconds : undefined,
        notifierData: {},
        onActivationSequences,
        onDeactivationSequences,
        onTriggerSequences,
        onResetSequences
    };

    for (const notifierId of notifiers) {
        const {
            withActions,
            withSnoozing,
            snoozingDefault,
            openInAppDefault,
            addCameraActionsDefault,
            withSound,
            withOpenInApp,
            withNotificationIcon,
            withIconColor,
            withChannel,
            withClearNotificationDefault,
            withDeleteNotificationDefault,
            withOpenNotificationDefault,
        } = getNotifierData({ notifierId, ruleType });
        const {
            actionsKey,
            priorityKey,
            addSnoozeKey,
            addCameraActionsKey,
            soundKey,
            openInAppKey,
            channelKey,
            notificationIconKey,
            iconColorKey,
            clearNotificationKey,
            deleteNotificationKey,
            openNotificationKey,
        } = getNotifierKeys({ notifierId, ruleName, ruleType });
        const actions = storage.getItem(actionsKey) as string[] ?? [];
        const priority = storage.getItem(priorityKey) as NotificationPriority;
        const addSnooze = withSnoozing ? storage.getItem(addSnoozeKey) ?? snoozingDefault : false;
        const openInApp = withOpenInApp ? storage.getItem(openInAppKey) ?? openInAppDefault : false;
        const sound = withSound ? storage.getItem(soundKey) : undefined;
        const channel = withChannel ? storage.getItem(channelKey) : undefined;
        const notificationIcon = withNotificationIcon ? storage.getItem(notificationIconKey) : undefined;
        const iconColor = withIconColor ? storage.getItem(iconColorKey) : undefined;
        const addCameraActions = storage.getItem(addCameraActionsKey) ?? addCameraActionsDefault;
        const addDeleteNotificationAction = storage.getItem(deleteNotificationKey) ?? withDeleteNotificationDefault;
        const addClearNotificationAction = storage.getItem(clearNotificationKey) ?? withClearNotificationDefault;
        const addOpenNotificationAction = storage.getItem(openNotificationKey) ?? withOpenNotificationDefault;
        rule.notifierData[notifierId] = {
            actions: withActions ? actions.map(action => safeParseJson(action)) : [],
            priority,
            addSnooze,
            addCameraActions,
            sound,
            openInApp,
            channel,
            notificationIcon,
            iconColor,
            addDeleteNotificationAction,
            addClearNotificationAction,
            addOpenNotificationAction,
        };
    }

    let timeAllowed = true;

    if (activationType === DetectionRuleActivation.Schedule || ruleType === RuleType.Timelapse) {
        const days = storage.getItem(dayKey) as number[];
        const startTime = storage.getItem(startTimeKey) as number;
        const endTime = storage.getItem(endTimeKey) as number;

        const currentDate = new Date();
        const currentDay = currentDate.getDay();

        const dayOk = !days?.length || days.includes(currentDay);
        if (!dayOk) {
            timeAllowed = false;
        } else {
            timeAllowed = isSchedulerActive({ endTime, startTime });
        }
    }

    let sensorsOk = true;
    const enabledSensors = storage.getItem(enabledSensorsKey) as string[] ?? [];
    const disabledSensors = storage.getItem(disabledSensorsKey) as string[] ?? [];

    if (!!enabledSensors.length || !!disabledSensors.length) {
        if (!!enabledSensors.length) {
            sensorsOk = enabledSensors.every(sensorId => {
                const sensorDevice = sdk.systemManager.getDeviceById<DeviceInterface>(sensorId);
                if (!sensorDevice) {
                    return false;
                }

                const { isSupported, sensorType } = isDeviceSupported(sensorDevice);
                if (!isSupported) {
                    logger.error(`Sensor ${sensorDevice.name} (${sensorDevice.id}) of type ${sensorDevice.type} not supported`);
                    return false
                }

                const metadata = binarySensorMetadataMap[sensorType];
                if (!metadata) {
                    logger.error(`Metadata for ${sensorType} not found`);
                    return false
                }
                return metadata.isActiveFn(sensorDevice);
            });
        }
        if (!!disabledSensors.length && sensorsOk) {
            sensorsOk = disabledSensors.every(sensorId => {
                const sensorDevice = sdk.systemManager.getDeviceById<DeviceInterface>(sensorId);
                if (!sensorDevice) {
                    return false;
                }
                const { isSupported, sensorType } = isDeviceSupported(sensorDevice);
                if (!isSupported) {
                    logger.error(`Sensor ${sensorDevice.name} (${sensorDevice.id}) of type ${sensorDevice.type} not supported`);
                    return false
                }

                const metadata = binarySensorMetadataMap[sensorType];
                if (!metadata) {
                    logger.error(`Metadata for ${sensorType} not found`);
                    return false
                }
                return !metadata.isActiveFn(sensorDevice);
            });
        }
    }

    const isAdvancedSecuritySystem = activationType === DetectionRuleActivation.AdvancedSecuritySystem;

    let isSecuritySystemEnabled = !isAdvancedSecuritySystem;
    let securitySyetemState;
    const securitySystemDeviceId = securitySystem?.id;
    let securitySystemDevice: SecuritySystem;

    if (isAdvancedSecuritySystem) {
        securitySystemDevice = sdk.systemManager.getDeviceById<SecuritySystem>(
            ADVANCED_NOTIFIER_INTERFACE,
            ALARM_SYSTEM_NATIVE_ID
        );
    } else if (securitySystemDeviceId) {
        securitySystemDevice = sdk.systemManager.getDeviceById<SecuritySystem>(securitySystemDeviceId);
    }

    if (securitySystemDevice && securitySystemModes?.length) {
        securitySyetemState = securitySystemDevice.securitySystemState;
        const currentMode = securitySyetemState?.mode;
        isSecuritySystemEnabled = currentMode ? securitySystemModes.includes(currentMode) : false;
    }

    const basicRuleAllowed =
        isEnabled &&
        timeAllowed &&
        sensorsOk &&
        isSecuritySystemEnabled;

    return {
        rule,
        basicRuleAllowed,
        isEnabled,
        timeAllowed,
        sensorsOk,
        isSecuritySystemEnabled,
        securitySyetemState,
        securitySystemModes: securitySystemModes ?? []
    };
}

export const getSequenceObject = (props: {
    sequenceName: string,
    storage: StorageSettings<any>,
}) => {
    const { sequenceName, storage } = props;
    const { actionsKey, minimumExecutionDelayKey, enabledKey } = getSequenceKeys({ sequenceName });
    const actionNames = safeParseJson<string[]>(storage.getItem(actionsKey), []);
    const minimumExecutionDelay = safeParseJson<number>(storage.getItem(minimumExecutionDelayKey), 15);
    const enabled = safeParseJson<boolean>(storage.getItem(enabledKey), true);
    const sequence: RuleActionsSequence = {
        name: sequenceName,
        enabled,
        minimumExecutionDelay,
        actions: [],
    };

    for (const actionName of actionNames) {
        const {
            deviceIdKey,
            presetNameKey,
            typeKey,
            switchEnabledKey,
            waitSecondsKey,
            lockStateKey,
            entryStateKey
        } = getSequenceKeys({ sequenceName, actionName });
        const currentType = storage.getItem(typeKey as any) as RuleActionType;

        if (currentType === RuleActionType.Wait) {
            sequence.actions.push({
                actionName,
                deviceId: '',
                type: currentType,
                seconds: safeParseJson<number>(storage.getItem(waitSecondsKey as any))
            })
        } if (currentType === RuleActionType.Script) {
            const device = storage.getItem(deviceIdKey as any) as DeviceBase;

            sequence.actions.push({
                actionName,
                deviceId: device?.id,
                type: currentType,
            })
        } else {
            const device = storage.getItem(deviceIdKey as any) as DeviceBase;
            if (device) {
                if (currentType === RuleActionType.Ptz) {
                    sequence.actions.push({
                        actionName,
                        deviceId: device.id,
                        type: currentType,
                        presetName: storage.getItem(presetNameKey as any) as string
                    })
                } else if (currentType === RuleActionType.Switch) {
                    sequence.actions.push({
                        actionName,
                        deviceId: device.id,
                        type: currentType,
                        turnOn: safeParseJson<number>(storage.getItem(switchEnabledKey as any))
                    })
                } else if (currentType === RuleActionType.Lock) {
                    sequence.actions.push({
                        actionName,
                        deviceId: device.id,
                        type: currentType,
                        lock: safeParseJson<number>(storage.getItem(lockStateKey as any))
                    })
                } else if (currentType === RuleActionType.Entry) {
                    sequence.actions.push({
                        actionName,
                        deviceId: device.id,
                        type: currentType,
                        openEntry: safeParseJson<number>(storage.getItem(entryStateKey as any))
                    })
                }
            }
        }
    }

    return sequence;
};

export const getDetectionRules = (props: {
    deviceStorage?: StorageSettings<any>,
    pluginStorage: StorageSettings<PluginSettingKey>,
    device?: DeviceBase & StorageSettingsDevice,
    console: Console,
}) => {
    const { console, pluginStorage, device, deviceStorage } = props;
    const availableRules: DetectionRule[] = [];
    const allowedRules: DetectionRule[] = [];
    const enabledAudioLabelsSet: Set<string> = new Set();
    let anyAllowedNvrRule = false;
    let shouldListenDoorbell = false;
    let shouldListenAudioSensor = false;

    const deviceId = device?.id;

    const { onActiveDevices, securitySystem } = pluginStorage.values;

    const { rulesKey } = ruleTypeMetadataMap[RuleType.Detection];

    const processDetectionRules = (storage: StorageSettings<any>, ruleSource: RuleSource) => {
        const detectionRuleNames = storage.getItem(rulesKey) ?? [];
        const isPlugin = ruleSource === RuleSource.Plugin;

        for (const detectionRuleName of detectionRuleNames) {
            const {
                common: {
                    activationKey,
                    scoreThresholdKey,
                    textKey,
                    minDelayKey,
                    minMqttPublishDelayKey,
                    generateClipMaxExtensionRangeKey,
                    devicesKey,
                },
                detection: {
                    useNvrDetectionsKey,
                    detectionSourceKey,
                    detectionClassesKey,
                    whitelistedZonesKey,
                    blacklistedZonesKey,
                    nvrEventsKey,
                    frigateLabelsKey,
                    audioLabelsKey,
                    recordingTriggerSecondsKey,
                    peopleKey,
                    plateMaxDistanceKey,
                    platesKey,
                    labelScoreKey,
                    clipDescriptionKey,
                    clipConfidenceKey,
                    aiFilterKey,
                } } = getRuleKeys({
                    ruleType: RuleType.Detection,
                    ruleName: detectionRuleName,
                });

            const useNvrDetections = storage.getItem(useNvrDetectionsKey) as boolean;
            const detectionSource = storage.getItem(detectionSourceKey) as ScryptedEventSource ||
                (useNvrDetections ? ScryptedEventSource.NVR : ScryptedEventSource.RawDetection);
            const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
            const customText = storage.getItem(textKey) as string || undefined;
            const mainDevices = storage.getItem(devicesKey) as string[] ?? [];
            const allDevices = getElegibleDevices(detectionSource === ScryptedEventSource.Frigate).map(device => device.id);

            const devices = !isPlugin ? [deviceId] : mainDevices.length ? mainDevices : allDevices;
            const devicesToUse = activationType === DetectionRuleActivation.OnActive ? onActiveDevices : devices;

            const detectionClasses = storage.getItem(detectionClassesKey) as RuleDetectionClass[] ?? [];
            const isAudioOnly = detectionClasses.length === 1 && detectionClasses[0] === DetectionClass.Audio;

            const nvrEvents = storage.getItem(nvrEventsKey) as NvrEvent[] ?? [];
            const frigateLabels = storage.getItem(frigateLabelsKey) as string[] ?? [];
            const audioLabels = storage.getItem(audioLabelsKey) as string[] ?? [];
            const scoreThreshold = storage.getItem(scoreThresholdKey) as number || (isAudioOnly ? 0.5 : 0.7);
            const minDelay = storage.getItem(minDelayKey) as number;
            const aiFilter = storage.getItem(aiFilterKey) as string;
            const clipDescription = storage.getItem(clipDescriptionKey) as string;
            const clipConfidence = storage.getItem(clipConfidenceKey) as SimilarityConfidence;
            const minMqttPublishDelay = storage.getItem(minMqttPublishDelayKey) as number || 15;
            const disableNvrRecordingSeconds = storage.getItem(recordingTriggerSecondsKey) as number;
            const maxClipExtensionRange = storage.getItem(generateClipMaxExtensionRangeKey) as number ?? 30;

            const { rule, basicRuleAllowed, ...restCriterias } = initBasicRule({
                ruleName: detectionRuleName,
                ruleSource,
                ruleType: RuleType.Detection,
                storage,
                securitySystem,
                logger: console
            });

            const detectionRule: DetectionRule = {
                ...rule,
                scoreThreshold,
                detectionClasses,
                nvrEvents,
                devices: devicesToUse,
                customText,
                deviceId,
                disableNvrRecordingSeconds,
                minDelay,
                clipDescription,
                clipConfidence,
                minMqttPublishDelay,
                detectionSource,
                frigateLabels,
                audioLabels,
                aiFilter,
                maxClipExtensionRange,
            };

            detectionRule.whitelistedZones = storage.getItem(whitelistedZonesKey) as string[] ?? [];
            detectionRule.blacklistedZones = storage.getItem(blacklistedZonesKey) as string[] ?? [];

            const hasFace = detectionClasses.includes(DetectionClass.Face);
            const hasPlate = detectionClasses.includes(DetectionClass.Plate);
            const hasAudio = detectionClasses.includes(DetectionClass.Audio);

            if (hasFace || hasPlate) {
                detectionRule.labelScoreThreshold = storage.getItem(labelScoreKey) as number ?? 0;
            }

            if (hasFace) {
                detectionRule.people = storage.getItem(peopleKey) as string[] ?? [];
            }

            if (hasPlate) {
                detectionRule.plates = storage.getItem(platesKey) as string[] ?? [];
                detectionRule.plateMaxDistance = storage.getItem(plateMaxDistanceKey) as number ?? 0;
            }

            let isSensorEnabled = true;
            if (isPlugin && device) {
                const { isSensor, sensorType } = isDeviceSupported(device);

                if (
                    isSensor &&
                    !mainDevices.length
                ) {
                    isSensorEnabled = detectionClasses.includes(sensorType);
                }
            }

            const deviceOk = (!!devicesToUse?.length && (deviceId ? devicesToUse.includes(deviceId) : true));
            const ruleAllowed =
                basicRuleAllowed &&
                deviceOk &&
                isSensorEnabled;

            console.debug(`Rule processed: ${JSON.stringify({
                detectionRule,
                ruleAllowed,
                devices: !!devicesToUse.length,
                deviceOk,
                deviceIdDefined: !!deviceId,
                isSensorEnabled,
                ...restCriterias,
            })}`);

            if (deviceOk || (isPlugin && activationType === DetectionRuleActivation.OnActive)) {
                availableRules.push(cloneDeep(detectionRule));
            }

            if (ruleAllowed) {
                allowedRules.push(cloneDeep(detectionRule));
                !anyAllowedNvrRule && (anyAllowedNvrRule = detectionRule.detectionSource === ScryptedEventSource.NVR);
                !shouldListenDoorbell && (shouldListenDoorbell = detectionClasses.includes(DetectionClass.Doorbell));
                !shouldListenAudioSensor && hasAudio && (shouldListenAudioSensor = true);
                for (const audioLabel of detectionRule.audioLabels || []) {
                    enabledAudioLabelsSet.add(audioLabel);
                }
            }

        }
    };

    processDetectionRules(pluginStorage, RuleSource.Plugin);

    if (deviceStorage) {
        processDetectionRules(deviceStorage, RuleSource.Device);
    }

    return {
        availableRules,
        allowedRules,
        anyAllowedNvrRule,
        shouldListenDoorbell,
        shouldListenAudioSensor,
        enabledAudioLabels: Array.from(enabledAudioLabelsSet)
    };
}

export interface OccupancyRule extends BaseRule {
    detectionClass?: DetectionClass;
    scoreThreshold?: number;
    changeStateConfirm?: number;
    forceUpdate?: number;
    maxObjects?: number;
    observeZone?: string;
    zoneOccupiedText?: string;
    zoneNotOccupiedText: string;
    zoneType: ZoneMatchType;
    captureZone?: Point[];
    occupies: boolean;
    detectedObjects: number;
    confirmWithAi: boolean;
}

export const getDeviceOccupancyRules = (
    props: {
        deviceStorage?: StorageSettings<any>,
        pluginStorage?: StorageSettings<any>,
        device: DeviceBase,
    }
) => {
    const { deviceStorage, pluginStorage, device } = props;
    const availableRules: OccupancyRule[] = [];
    const allowedRules: OccupancyRule[] = [];

    const { securitySystem } = pluginStorage.values;
    const { rulesKey } = ruleTypeMetadataMap[RuleType.Occupancy];
    const occupancyRuleNames = deviceStorage.getItem(rulesKey) ?? [];

    for (const occupancyRuleName of occupancyRuleNames) {
        const {
            common: {
                scoreThresholdKey,
            },
            occupancy: {
                captureZoneKey,
                changeStateConfirmKey,
                detectionClassKey,
                forceUpdateKey,
                maxObjectsKey,
                zoneKey,
                zoneMatchTypeKey,
                zoneNotOccupiedTextKey,
                zoneOccupiedTextKey,
                detectedObjectsKey,
                occupiesKey,
                confirmWithAiKey,
            }
        } = getRuleKeys({
            ruleType: RuleType.Occupancy,
            ruleName: occupancyRuleName,
        });

        const { rule, basicRuleAllowed } = initBasicRule({
            ruleName: occupancyRuleName,
            ruleSource: RuleSource.Device,
            ruleType: RuleType.Occupancy,
            storage: deviceStorage,
            securitySystem,
            logger: console
        });

        const zoneOccupiedText = deviceStorage.getItem(zoneOccupiedTextKey) as string;
        const zoneNotOccupiedText = deviceStorage.getItem(zoneNotOccupiedTextKey) as string;
        const detectionClass = deviceStorage.getItem(detectionClassKey) as DetectionClass;
        const scoreThreshold = deviceStorage.getItem(scoreThresholdKey) as number || 0.5;
        const changeStateConfirm = deviceStorage.getItem(changeStateConfirmKey) as number || 30;
        const forceUpdate = deviceStorage.getItem(forceUpdateKey) as number || 30;
        const maxObjects = deviceStorage.getItem(maxObjectsKey) as number || 1;
        const observeZone = deviceStorage.getItem(zoneKey) as string;
        const zoneMatchType = deviceStorage.getItem(zoneMatchTypeKey) as ZoneMatchType;
        const captureZone = deviceStorage.getItem(captureZoneKey) as Point[];
        const occupies = deviceStorage.getItem(occupiesKey) as boolean;
        const confirmWithAi = deviceStorage.getItem(confirmWithAiKey) as boolean;
        const detectedObjects = deviceStorage.getItem(detectedObjectsKey) as number;

        const occupancyRule: OccupancyRule = {
            ...rule,
            zoneNotOccupiedText,
            zoneOccupiedText,
            detectionClass,
            observeZone,
            deviceId: device.id,
            scoreThreshold,
            changeStateConfirm,
            forceUpdate,
            zoneType: zoneMatchType,
            maxObjects,
            captureZone,
            occupies,
            detectedObjects,
            confirmWithAi,
        };

        const ruleAllowed = basicRuleAllowed && !!detectionClass && !!observeZone;

        availableRules.push(cloneDeep(occupancyRule));

        if (ruleAllowed) {
            allowedRules.push(cloneDeep(occupancyRule));
        }
    }

    return {
        availableRules,
        allowedRules,
    };
}

export interface TimelapseRule extends BaseRule {
    timelapseFramerate?: number;
    regularSnapshotInterval?: number;
    lastGenerated?: number;
    additionalFfmpegParameters?: string;
}

export interface AudioRule extends BaseRule {
    decibelThreshold: number;
    hitPercentage: number;
    audioDuration: number;
}

export const getDeviceTimelapseRules = (
    props: {
        deviceStorage?: StorageSettings<any>,
        pluginStorage?: StorageSettings<any>,
        console: Console
        device: DeviceBase,
    }
) => {
    const { deviceStorage, console, pluginStorage, device } = props;
    const availableRules: TimelapseRule[] = [];
    const allowedRules: TimelapseRule[] = [];

    const { securitySystem } = pluginStorage.values;
    const { rulesKey } = ruleTypeMetadataMap[RuleType.Timelapse];

    const timelapseRuleNames = deviceStorage.getItem(rulesKey) ?? [];
    for (const timelapseRuleName of timelapseRuleNames) {
        const {
            common: {
                textKey
            },
            timelapse: {
                framesAcquisitionDelayKey,
                regularSnapshotIntervalKey,
                timelapseFramerateKey,
                lastGeneratedKey,
            }
        } = getRuleKeys({
            ruleType: RuleType.Timelapse,
            ruleName: timelapseRuleName,
        });

        const { rule, basicRuleAllowed } = initBasicRule({
            ruleName: timelapseRuleName,
            ruleSource: RuleSource.Device,
            ruleType: RuleType.Timelapse,
            storage: deviceStorage,
            securitySystem,
            logger: console
        });

        const customText = deviceStorage.getItem(textKey) as string;
        const minDelay = deviceStorage.getItem(framesAcquisitionDelayKey) as number;
        const timelapseFramerate = deviceStorage.getItem(timelapseFramerateKey) as number;
        const lastGenerated = deviceStorage.getItem(lastGeneratedKey) as number;
        const regularSnapshotInterval = deviceStorage.getItem(regularSnapshotIntervalKey) as number;

        const timelapseRule: TimelapseRule = {
            ...rule,
            customText,
            minDelay,
            timelapseFramerate,
            regularSnapshotInterval,
            deviceId: device.id,
            lastGenerated
        };


        console.debug(`Timelapse rule processed: ${JSON.stringify({
            timelapseRule,
            basicRuleAllowed,
        })}`);

        availableRules.push(cloneDeep(timelapseRule));

        if (basicRuleAllowed) {
            allowedRules.push(cloneDeep(timelapseRule));
        }
    }

    return {
        availableRules,
        allowedRules,
    };
}

export const getDeviceAudioRules = (
    props: {
        deviceStorage?: StorageSettings<any>,
        pluginStorage?: StorageSettings<any>,
        console: Console
        device: DeviceBase,
    }
) => {
    const { deviceStorage, console, pluginStorage, device } = props;
    const availableRules: AudioRule[] = [];
    const allowedRules: AudioRule[] = [];

    if (device.interfaces.includes(ScryptedInterface.AudioVolumeControl)) {
        const { securitySystem } = pluginStorage.values;
        const { rulesKey } = ruleTypeMetadataMap[RuleType.Audio];

        const audioRuleNames = deviceStorage.getItem(rulesKey) ?? [];
        for (const audioRuleName of audioRuleNames) {
            const {
                common: {
                    textKey,
                    minDelayKey,
                },
                audio: {
                    decibelThresholdKey,
                    audioDurationKey,
                    hitPercentageKey,
                }
            } = getRuleKeys({
                ruleType: RuleType.Audio,
                ruleName: audioRuleName,
            });

            const { rule, basicRuleAllowed } = initBasicRule({
                ruleName: audioRuleName,
                ruleSource: RuleSource.Device,
                ruleType: RuleType.Audio,
                storage: deviceStorage,
                securitySystem,
                logger: console
            });

            const customText = deviceStorage.getItem(textKey) as string;
            const decibelThreshold = deviceStorage.getItem(decibelThresholdKey) as number ?? -30;
            const audioDuration = deviceStorage.getItem(audioDurationKey) as number ?? 6;
            const hitPercentage = deviceStorage.getItem(hitPercentageKey) as number || 80;
            const minDelay = deviceStorage.getItem(minDelayKey) as number;

            const audioRule: AudioRule = {
                ...rule,
                customText,
                decibelThreshold,
                audioDuration,
                hitPercentage,
                minDelay,
                deviceId: device.id
            };


            console.debug(`Audio rule processed: ${JSON.stringify({
                audioRule,
                basicRuleAllowed,
            })}`);

            availableRules.push(cloneDeep(audioRule));

            if (basicRuleAllowed) {
                allowedRules.push(audioRule);
            }
        }
    }

    return {
        availableRules,
        allowedRules,
    };
}

export const getAllDevices = () => {
    return Object.keys(sdk.systemManager.getSystemState()).map(id => sdk.systemManager.getDeviceById(id));
}

export const convertSettingsToStorageSettings = async (props: {
    device: StorageSettingsDevice,
    dynamicSettings: StorageSetting[],
    initStorage: StorageSettingsDict<string>,
}) => {
    const { device, dynamicSettings, initStorage } = props;

    const onPutToRestore: Record<string, any> = {};
    Object.entries(initStorage).forEach(([key, setting]) => {
        if (setting.onPut) {
            onPutToRestore[key] = setting.onPut;
        }
    });

    const settings: StorageSetting[] = await new StorageSettings(device, initStorage).getSettings();

    settings.push(...dynamicSettings);

    const deviceSettings: StorageSettingsDict<string> = {};

    for (const setting of settings) {
        const { value, key, onPut, ...rest } = setting;
        deviceSettings[key] = {
            ...rest,
            value: rest.type === 'html' ? value : undefined
        };
        if (setting.onPut) {
            deviceSettings[key].onPut = setting.onPut.bind(device)
        }
    }

    const updateStorageSettings = new StorageSettings(device, deviceSettings);

    Object.entries(onPutToRestore).forEach(([key, onPut]) => {
        updateStorageSettings.settings[key].onPut = onPut;
    });

    return updateStorageSettings;
}

export enum SupportedSensorType {
    Lock = 'lock',
    Binary = 'binary',
    Flood = 'flood',
    Entry = 'entry'
};

export enum NotifierPayloadKey {
    Body = 'Body',
    Subtitle = 'Subtitle',
    bodyWithSubtitle = 'BodyWithSubtitle'
}

export type DetectionEvent = DetectionClass | NvrEvent | SupportedSensorType;
export type RuleDetectionClass = DetectionClass | SupportedSensorType;

export const isDeviceSupported = (device: DeviceBase) => {
    const { interfaces, type } = device;
    const isCamera = [ScryptedInterface.VideoCamera, ScryptedInterface.Camera].some(int => interfaces.includes(int));

    const isLock = interfaces.includes(ScryptedInterface.Lock);
    const isBinarySensor = !isCamera && interfaces.includes(ScryptedInterface.BinarySensor);
    const isFloodSensor = interfaces.includes(ScryptedInterface.FloodSensor);
    const isEntrySensor = interfaces.includes(ScryptedInterface.EntrySensor);

    const isNotifier = interfaces.includes(ScryptedInterface.Notifier);
    const isDoorbell = type === ScryptedDeviceType.Doorbell;

    const isSensor = isLock || isBinarySensor || isFloodSensor || isEntrySensor;
    const isSupported = isCamera || isDoorbell || isSensor || isNotifier;

    const sensorType: SupportedSensorType = isLock ? SupportedSensorType.Lock :
        isFloodSensor ? SupportedSensorType.Flood :
            isEntrySensor ? SupportedSensorType.Entry :
                isBinarySensor ? SupportedSensorType.Binary :
                    undefined;

    return {
        isCamera,
        isSensor,
        isLock,
        isBinarySensor,
        isFloodSensor,
        isEntrySensor,
        isSupported,
        sensorType,
        isNotifier,
        isDoorbell,
    }
}

export interface BinarySensorMetadata {
    isActiveFn: (device: ScryptedDeviceBase, value?: any) => boolean,
    interface: ScryptedInterface
};

export const binarySensorMetadataMap: Record<SupportedSensorType, BinarySensorMetadata> = {
    [SupportedSensorType.Binary]: {
        interface: ScryptedInterface.BinarySensor,
        isActiveFn: (device, value) => !!(device?.binaryState ?? value),
    },
    [SupportedSensorType.Lock]: {
        interface: ScryptedInterface.Lock,
        isActiveFn: (device, value) => (device?.lockState ?? value) === LockState.Unlocked
    },
    [SupportedSensorType.Entry]: {
        interface: ScryptedInterface.EntrySensor,
        isActiveFn: (device, value) => !!(device?.entryOpen ?? value),
    },
    [SupportedSensorType.Flood]: {
        interface: ScryptedInterface.FloodSensor,
        isActiveFn: (device, value) => !!(device?.flooded ?? value),
    },
}

export const toKebabCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\s]+/g, '-')
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export const toSnakeCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-\s]+/g, '_')
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export const toTitleCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\w/, char => char.toUpperCase());

export const splitRules = (props: {
    allRules: BaseRule[],
    rulesToActivate: BaseRule[],
    currentlyRunningRules: BaseRule[],
    device?: ScryptedDeviceBase,
}) => {
    const { currentlyRunningRules, rulesToActivate, allRules, device } = props;

    const rulesToEnable: BaseRule[] = [];
    const rulesToDisable: BaseRule[] = [];

    for (const rule of allRules) {
        const isCurrentlyActive = currentlyRunningRules.find(innerRule => rule.name === innerRule.name);
        const shouldBeActive = rulesToActivate.find(innerRule => rule.name === innerRule.name);
        const isPluginForDevice = rule.source === RuleSource.Plugin && !!device;
        const isActuallyActive = rule.currentlyActive;

        if (shouldBeActive && (!isCurrentlyActive || !isActuallyActive)) {
            rulesToEnable.push(cloneDeep(rule));
        } else if (!shouldBeActive && (isCurrentlyActive || (isActuallyActive && !isPluginForDevice))) {
            rulesToDisable.push(cloneDeep(rule));
        }
    }

    return [
        rulesToEnable,
        rulesToDisable,
    ];
}

export const getSnoozeId = (props: {
    cameraId: string,
    notifierId: string,
    priority: NotificationPriority,
    rule?: BaseRule,
    detection?: ObjectDetectionResult
}) => {
    const { cameraId, priority, notifierId, detection, rule } = props;

    let specificIdentifier: string;
    if (detection && rule?.ruleType === RuleType.Detection) {
        const { className, label } = detection;
        specificIdentifier = label ? `${className}_${label}` : className;
    } else if (rule?.ruleType === RuleType.Audio) {
        specificIdentifier = rule.name;
    }

    if (rule?.totalSnooze) {
        return `${cameraId}_${specificIdentifier}_${priority}`;
    } else {
        return `${cameraId}_${notifierId}_${specificIdentifier}_${priority}`;
    }
}

export const getDetectionKey = (matchRule: MatchRule) => {
    const { match, rule } = matchRule;
    let key = `rule-${rule.name}`;
    if (rule.ruleType === RuleType.Detection && match) {
        const { label, className } = match;
        const classname = detectionClassesDefaultMap[className];
        key = `${key}-${classname}`;
        if (label && !isPlateClassname(className)) {
            key += `-${label}`;
        }
    }

    return key;
};
export const getB64ImageLog = (b64Image: string) => `${b64Image ? b64Image?.substring(0, 10) + '...' : 'NO_IMAGE'}`;
export const getDetectionsLog = (detections: ObjectDetectionResult[]) => uniq(detections.map(item => `${item.className}${item.label ? '-' + item.label : ''}`)).join(', ');
export const getDetectionsLogShort = (detections: ObjectDetectionResult[]) => uniq(detections.map(item => `${(item.label ?? item.className)}`)).join('_');
export const getRulesLog = (rulesToUpdate: MatchRule[]) => uniq(rulesToUpdate.map(getDetectionKey)).join(', ');

export const haSnoozeAutomationId = 'scrypted_advanced_notifier_snooze_action';
export const haSnoozeAutomation = {
    "alias": "Scrypted advanced notifier snooze action",
    "description": "Automation auto-generated by the scrypted's plugin Advanced notifier to handle snooze actions",
    "trigger": [
        {
            "platform": "event",
            "event_type": "mobile_app_notification_action"
        },
        {
            "platform": "event",
            "event_type": "ios.action_fired"
        }
    ],
    "condition": [
        {
            "condition": "template",
            "value_template": "{{ (trigger.event.data.action_name is defined and trigger.event.data.action_name is match('scrypted_an_snooze_.*')) or (trigger.event.data.action is defined and trigger.event.data.action is match('scrypted_an_snooze_.*')) }}"
        }
    ],
    "action": [
        {
            "variables": {
                "event_name": "{% if 'action' in trigger.event.data %}{{ trigger.event.data.action }}{% else %}{{ trigger.event.data.actionName }}{% endif %}",
                "suffix": "{% set prefix = 'scrypted_an_snooze_' %} {{ event_name[prefix|length:] }}",
                "parts": "{{ suffix.split('_') }}",
                "camera_id": "{{ parts[0] }}",
                "notifier_id": "{{ parts[1] }}",
                "snooze_time": "{{ parts[2] }}",
                "remaining_parts": "{{ parts[3:] }}",
                "snooze_id": "{{ remaining_parts | join('_') }}"
            }
        },
        {
            "action": "mqtt.publish",
            "data": {
                "qos": "0",
                "topic": "scrypted/scrypted-an-{{ notifier_id }}/snooze/set",
                "payload": "{\"snoozeId\":\"{{ snooze_id }}\",\"cameraId\":\"{{ camera_id }}\",\"snoozeTime\":\"{{ snooze_time}}\"}"
            }
        }
    ],
    "mode": "single"
};

export const moToB64 = async (mo: MediaObject) => {
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
    return bufferImage?.toString('base64');
}

export const b64ToMo = async (b64: string) => {
    const buffer = Buffer.from(b64, 'base64');
    return await sdk.mediaManager.createMediaObject(buffer, 'image/jpeg');
}

export const getFrigateTextKey = (label: string) => `frigate${label}Text` as TextSettingKey;

export const checkUserLogin = async (request: HttpRequest) => {
    const token = request.headers?.authorization;
    if (!token) {
        return;
    }

    const credendials = atob(token.split('Basic ')[1]);
    const [username, password] = credendials.split(':');
    const localUrl = await sdk.endpointManager.getLocalEndpoint();
    const baseUrl = new URL(localUrl).origin;

    const loginResponse = await loginScryptedClient({
        baseUrl,
        username: username,
        password: password,
        maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    if (loginResponse.error) {
        return;
    }

    return loginResponse;
}

export const getDetectionEventKey = (props: {
    eventId: string,
    detectionId: string
}) => {
    const { detectionId, eventId } = props;
    let id = `${eventId}`;
    if (detectionId) {
        id += `_${detectionId}`;
    }

    return id;
}

export const generatePrivateKey = (length = 10) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let secret = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = crypto.randomInt(0, chars.length);
        secret += chars[randomIndex];
    }
    return secret;
}

export const generatePublicKey = (props: {
    secret: string,
    hours?: number
}) => {
    const { secret, hours = 3 } = props;
    const time = moment();

    const slotHour = Math.floor(time.hour() / hours) * hours;
    const slotTime = time.clone().startOf('day').add(slotHour, 'hours');

    const slotString = slotTime.format('YYYY-MM-DDTHH');

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(slotString);
    const hash = hmac.digest('hex');

    return hash.slice(0, 10).toUpperCase();
}

export const isSecretValid = (props: {
    secret: string,
    publicKey: string,
    hours?: number,
}) => {
    const { secret, publicKey, hours = 3 } = props;
    if (secret === publicKey) {
        return true;
    }

    const expectedPublicKey = generatePublicKey({ hours, secret });
    return publicKey === expectedPublicKey;
}

export const getEmbeddingSimilarityScore = async (props: {
    deviceId: string,
    image?: MediaObject,
    imageEmbedding?: string,
    text: string,
    detId: string,
    plugin: AdvancedNotifierPlugin
}) => {
    const { plugin, image, imageEmbedding, text, deviceId, detId } = props;
    const clipDevice = sdk.systemManager.getDeviceById<TextEmbedding & ImageEmbedding>(deviceId);

    let imageEmbeddingBuffer: Buffer;
    let textEmbeddingBuffer: Buffer;
    if (imageEmbedding) {
        imageEmbeddingBuffer = Buffer.from(imageEmbedding, "base64");
    } else if (image) {
        if (detId && plugin.imageEmbeddingCache[detId]) {
            imageEmbeddingBuffer = plugin.imageEmbeddingCache[detId];
        } else {
            imageEmbeddingBuffer = await clipDevice.getImageEmbedding(image);
            plugin.imageEmbeddingCache[detId] = imageEmbeddingBuffer;
        }
    }

    if (imageEmbeddingBuffer) {
        const imageEmbedding = new Float32Array(
            imageEmbeddingBuffer.buffer,
            imageEmbeddingBuffer.byteOffset,
            imageEmbeddingBuffer.length / Float32Array.BYTES_PER_ELEMENT
        );

        if (plugin.textEmbeddingCache[text]) {
            textEmbeddingBuffer = plugin.textEmbeddingCache[text];
        } else {
            textEmbeddingBuffer = await clipDevice.getTextEmbedding(text);
            plugin.textEmbeddingCache[text] = textEmbeddingBuffer;
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

export const calculateSize = async (props: {
    currentPath: string,
    filenamePrefix?: string,
    maxSpaceInGb?: number,
}) => {
    const { currentPath, filenamePrefix, maxSpaceInGb = 0 } = props;
    let occupiedSizeInBytes = 0;

    const calculateSizeInner = async (innerPath: string) => {
        const entries = await fs.promises.readdir(innerPath, { withFileTypes: true });
        const filteredFiles = filenamePrefix ? entries.filter(entry => entry.name.includes(filenamePrefix)) : entries;

        for (const entry of filteredFiles) {
            const fullPath = path.join(innerPath, entry.name);
            if (entry.isDirectory()) {
                await calculateSizeInner(fullPath);
            } else if (entry.isFile()) {
                const stats = await fs.promises.stat(fullPath);
                occupiedSizeInBytes += stats.size;
            }
        }
    }

    await calculateSizeInner(currentPath);

    const maxSpaceInBytes = maxSpaceInGb * 1024 * 1024 * 1024;
    const freeMemoryInBytes = maxSpaceInBytes - occupiedSizeInBytes;

    return {
        occupiedSizeInBytes,
        freeMemoryInBytes,
    };
}