import sdk, { BinarySensor, Camera, DeviceBase, EntrySensor, LockState, MediaObject, Notifier, NotifierOptions, ObjectDetectionResult, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, Point, Reboot, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, SecuritySystem, SecuritySystemMode, Settings, VideoCamera } from "@scrypted/sdk";
import { SettingsMixinDeviceBase } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDevice, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { cloneDeep, sortBy, uniq, uniqBy } from "lodash";
import moment, { Moment } from "moment";
import sharp from 'sharp';
import { name, scrypted } from '../package.json';
import { AiPlatform, defaultModel } from "./aiUtils";
import { basicDetectionClasses, classnamePrio, defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isLabelDetection } from "./detectionClasses";
import AdvancedNotifierPlugin, { PluginSettingKey } from "./main";
const { endpointManager } = sdk;

export type DeviceInterface = Camera & ScryptedDeviceBase & Notifier & Settings & ObjectDetector & VideoCamera & EntrySensor & Lock & BinarySensor & Reboot & PanTiltZoom & OnOff;
export const ADVANCED_NOTIFIER_INTERFACE = name;
export const ADVANCED_NOTIFIER_CAMERA_INTERFACE = `${ADVANCED_NOTIFIER_INTERFACE}:Camera`;
export const ADVANCED_NOTIFIER_NOTIFIER_INTERFACE = `${ADVANCED_NOTIFIER_INTERFACE}:Notifier`;
export const ADVANCED_NOTIFIER_ALARM_SYSTEM_INTERFACE = `${ADVANCED_NOTIFIER_INTERFACE}:SecuritySystem`;
export const PUSHOVER_PLUGIN_ID = '@scrypted/pushover';
export const NTFY_PLUGIN_ID = '@apocaliss92/ntfy';
export const NVR_PLUGIN_ID = '@scrypted/nvr';
export const VIDEO_ANALYSIS_PLUGIN_ID = '@scrypted/objectdetector';
export const HOMEASSISTANT_PLUGIN_ID = '@scrypted/homeassistant';
export const NVR_NOTIFIER_INTERFACE = `${NVR_PLUGIN_ID}:Notifier`;
export const SNAPSHOT_WIDTH = 1280;
export const LATEST_IMAGE_SUFFIX = '-latest';
export const NOTIFIER_NATIVE_ID = 'advancedNotifierDefaultNotifier';
export const CAMERA_NATIVE_ID = 'advancedNotifierCamera';
export const ALARM_SYSTEM_NATIVE_ID = 'advancedNotifierAlarmSystem';
export const MAX_PENDING_RESULT_PER_CAMERA = 5;
export const MAX_RPC_OBJECTS_PER_CAMERA = 50;
export const FRIGATE_BRIDGE_PLUGIN_NAME = 'Frigate bridge';
export const DECODER_FRAME_MIN_TIME = 200;

export enum ScryptedEventSource {
    RawDetection = 'RawDetection',
    NVR = 'NVR',
    Frigate = 'Frigate'
}

export interface ObserveZoneData {
    name: string;
    path: Point[]
};

export interface MatchRule { match?: ObjectDetectionResult, rule: BaseRule, dataToReport?: any }

export enum DecoderType {
    Off = 'Off',
    OnMotion = 'OnMotion',
    Always = 'Always',
}

export enum DelayType {
    DecoderFrameOnStorage = 'DecoderFrameOnStorage',
    BasicDetectionImage = 'BasicDetectionImage',
    BasicDetectionTrigger = 'BasicDetectionTrigger',
    RuleImageUpdate = 'RuleImageUpdate',
    RuleNotification = 'RuleNotification',
    OccupancyNotification = 'OccupancyNotification',
    FsImageUpdate = 'FsImageUpdate',
    PostWebhookImage = 'PostWebhookImage',
}

export enum GetImageReason {
    Sensor = 'Sensor',
    RulesRefresh = 'RulesRefresh',
    AudioTrigger = 'AudioTrigger',
    MotionUpdate = 'MotionUpdate',
    ObjectUpdate = 'ObjectUpdate',
    FromNvr = 'FromNvr',
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

export const videoclipSpeedMultiplier: Record<VideoclipSpeed, number> = {
    [VideoclipSpeed.SuperSlow]: 0.25,
    [VideoclipSpeed.Slow]: 0.5,
    [VideoclipSpeed.Realtime]: 1,
    [VideoclipSpeed.Fast]: 2,
    [VideoclipSpeed.SuperFast]: 4
}

export type IsDelayPassedProps =
    { type: DelayType.DecoderFrameOnStorage, eventSource: ScryptedEventSource, timestamp: number } |
    { type: DelayType.BasicDetectionImage, classname: string, label?: string, eventSource: ScryptedEventSource } |
    { type: DelayType.BasicDetectionTrigger, classname: string, label?: string, eventSource: ScryptedEventSource } |
    { type: DelayType.FsImageUpdate, filename: string, eventSource: ScryptedEventSource } |
    { type: DelayType.OccupancyNotification, matchRule: MatchRule, eventSource: ScryptedEventSource } |
    { type: DelayType.PostWebhookImage, classname: string, eventSource: ScryptedEventSource } |
    { type: DelayType.RuleImageUpdate, matchRule: MatchRule, eventSource: ScryptedEventSource } |
    { type: DelayType.RuleNotification, matchRule: MatchRule, eventSource: ScryptedEventSource };

export const getElegibleDevices = () => {
    const allDevices = Object.keys(sdk.systemManager.getSystemState()).map(deviceId => sdk.systemManager.getDeviceById<DeviceInterface>(deviceId));

    return allDevices.filter(device => {
        const { isSupported, isNotifier } = isDeviceSupported(device);
        return isSupported && !isNotifier && device.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE);
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


export const getWebooks = async () => {
    const lastSnapshot = 'snapshot';
    const haAction = 'haAction';
    const detectionClipDownload = 'detectionClipDownload';
    const timelapseDownload = 'timelapseDownload';
    const timelapseStream = 'timelapseStream';
    const timelapseThumbnail = 'timelapseThumbnail';
    const snoozeNotification = 'snoozeNotification';
    const postNotification = 'postNotification';
    const setAlarm = 'setAlarm';

    return {
        lastSnapshot,
        haAction,
        timelapseDownload,
        timelapseStream,
        timelapseThumbnail,
        snoozeNotification,
        postNotification,
        setAlarm,
        detectionClipDownload,
    }
}

export const isDetectionRule = (rule: BaseRule) => [
    RuleType.Audio,
    RuleType.Detection,
].includes(rule.ruleType);

export const getWebHookUrls = async (props: {
    cameraIdOrAction?: string,
    console?: Console,
    device?: ScryptedDeviceBase,
    rule?: TimelapseRule,
    clipName?: string,
    snoozes?: number[],
    snoozeId?: string,
    snoozePlaceholder?: string,
}) => {
    const {
        cameraIdOrAction,
        console,
        rule,
        device,
        clipName,
        snoozes,
        snoozeId,
        snoozePlaceholder
    } = props;

    let lastSnapshotCloudUrl: string;
    let lastSnapshotLocalUrl: string;
    let haActionUrl: string;
    let timelapseStreamUrl: string;
    let timelapseDownloadUrl: string;
    let timelapseThumbnailUrl: string;
    let postNotificationUrl: string;
    let endpoint: string;
    let detectionClipDownloadUrl: string;

    const snoozeActions: NotificationAction[] = [];

    const {
        lastSnapshot,
        haAction,
        timelapseDownload,
        timelapseStream,
        timelapseThumbnail,
        snoozeNotification,
        postNotification,
        detectionClipDownload,
    } = await getWebooks();

    try {
        const cloudEndpointRaw = await endpointManager.getCloudEndpoint(undefined, { public: true });
        const localEndpoint = await endpointManager.getPublicLocalEndpoint();
        // const cloudPushEndpoint = await sdk.endpointManager.getCloudPushEndpoint(this.nativeId);

        const [cloudEndpoint, parameters] = cloudEndpointRaw.split('?') ?? '';
        const encodedId = encodeURIComponent(cameraIdOrAction ?? device?.id);
        endpoint = cloudEndpoint;

        const paramString = parameters ? `?${parameters}` : '';

        lastSnapshotCloudUrl = `${cloudEndpoint}${lastSnapshot}/${encodedId}/{IMAGE_NAME}${paramString}`;
        lastSnapshotLocalUrl = `${localEndpoint}${lastSnapshot}/${encodedId}/{IMAGE_NAME}${paramString}`;
        haActionUrl = `${cloudEndpoint}${haAction}/${encodedId}${paramString}`;
        postNotificationUrl = `${cloudEndpoint}${postNotification}/${encodedId}${paramString}`;

        if (rule) {
            const encodedRuleName = encodeURIComponent(rule.name);

            timelapseStreamUrl = `${cloudEndpoint}${timelapseStream}/${encodedId}/${encodedRuleName}/${clipName}${paramString}`;
            timelapseDownloadUrl = `${cloudEndpoint}${timelapseDownload}/${encodedId}/${encodedRuleName}/${clipName}${paramString}`;
            timelapseThumbnailUrl = `${cloudEndpoint}${timelapseThumbnail}/${encodedId}/${encodedRuleName}/${clipName}${paramString}`;

            detectionClipDownloadUrl = `${cloudEndpoint}${detectionClipDownload}/${encodedId}/${encodedRuleName}/${clipName}${paramString}`;
        }

        if (snoozes) {
            for (const snooze of snoozes) {
                const text = snoozePlaceholder?.replaceAll('${snoozeTime}', String(snooze));

                snoozeActions.push({
                    url: `${cloudEndpoint}${snoozeNotification}/${encodedId}/${snoozeId}/${snooze}${paramString}`,
                    title: text,
                    action: `snooze${snooze}`,
                    data: snooze,
                });
            }
        }
    } catch (e) {
        console?.log('Error fetching webhookUrls. Probably Cloud plugin is not setup correctly', e.message);
    }

    return {
        lastSnapshotCloudUrl,
        lastSnapshotLocalUrl,
        haActionUrl,
        timelapseStreamUrl,
        timelapseDownloadUrl,
        timelapseThumbnailUrl,
        snoozeActions,
        postNotificationUrl,
        endpoint,
        detectionClipDownloadUrl,
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

export enum NotificationSource {
    NVR = 'NVR',
    TEST = 'TEST',
    POST_WEBHOOK = 'POST_WEBHOOK',
    DETECTION = 'DETECTION',
    TIMELAPSE = 'TIMELAPSE',
}

export const filterAndSortValidDetections = (props: {
    detections: ObjectDetectionResult[],
    logger: Console,
    consumedDetectionIdsSet: Set<string>
}) => {
    const { detections, logger, consumedDetectionIdsSet } = props;
    const sortedByPriorityAndScore = sortBy(detections,
        (detection) => [detection?.className ? classnamePrio[detection.className] : 100,
        1 - (detection.score ?? 0)]
    );
    const uniqueByClassName = uniqBy(sortedByPriorityAndScore, det => det.className);
    const candidates = uniqueByClassName.filter(det => {
        const { className, label, movement, id } = det;
        const detId = id ? `${className}-${id}` : undefined;
        if (detId && consumedDetectionIdsSet && consumedDetectionIdsSet.has(detId)) {
            return false;
        }

        if (className.startsWith('debug-')) {
            return false;
        }

        const isLabel = isLabelDetection(className);
        if (isLabel && !label) {
            logger.debug(`Label ${label} not valid`);
            return false;
        } else if (movement && !movement.moving) {
            logger.debug(`Movement data ${JSON.stringify(movement)} not valid: ${JSON.stringify(det)}`);
            return false;
        }

        detId && consumedDetectionIdsSet.add(detId);

        return true;
    });

    return { candidates };
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
            description: 'Expression used to render the snooze texts. Available arguments ${snoozeTime}',
            defaultValue: !forMixin ? 'Snooze: ${snoozeTime} minutes' : undefined,
            placeholder: !forMixin ? 'Snooze: ${snoozeTime} minutes' : undefined,
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
}

export const ruleTypeMetadataMap: Record<RuleType, { rulesKey: string, rulePrefix: string, subgroupPrefix: string }> = {
    [RuleType.Detection]: { rulePrefix: 'rule', rulesKey: 'detectionRules', subgroupPrefix: 'DET' },
    [RuleType.Occupancy]: { rulePrefix: 'occupancyRule', rulesKey: 'occupancyRules', subgroupPrefix: 'OCC' },
    [RuleType.Timelapse]: { rulePrefix: 'timelapseRule', rulesKey: 'timelapseRules', subgroupPrefix: 'TIME' },
    [RuleType.Audio]: { rulePrefix: 'audioRule', rulesKey: 'audioRules', subgroupPrefix: 'AUDIO' },
}

export const mixinRulesGroup = 'Advanced notifier rules';
export const pluginRulesGroup = 'Rules';

export type MixinBaseSettingKey =
    | 'info'
    | 'debug'
    | 'enabledToMqtt'
    | 'useNvrDetections'
    | 'detectionSource'
    | 'minDelayTime'
    | 'detectionRules'
    | 'occupancyRules'
    | 'timelapseRules'
    | 'audioRules'

export enum NotificationPriority {
    SuperLow = "SuperLow",
    Low = "Low",
    Normal = "Normal",
    High = "High",
    SuperHigh = "SuperHigh",
};

export interface NotificationAction {
    title: string;
    action: string;
    url: string;
    icon?: string;
    data?: any;
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
            debug: {
                title: 'Log debug messages',
                type: 'boolean',
                defaultValue: false,
                immediate: true,
            },
            info: {
                title: 'Log info messages',
                type: 'boolean',
                defaultValue: false,
                immediate: true,
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
            settings[ruleTypeMetadataMap[RuleType.Audio].rulesKey] = {
                title: 'Audio rules [DEPRECATED]',
                description: 'Will be removed and bound to the detection rules',
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
        console.log('Error in getBasixSettings', e);
    }
}

export const mainPluginName = scrypted.name;

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

    const isPluginEnabled = pluginStorage.getItem('pluginEnabled');
    const isMqttActive = pluginStorage.getItem('mqttEnabled');
    const isDeviceEnabledToMqtt = deviceStorage?.values.enabledToMqtt;

    const allAvailableRules = [
        ...availableDetectionRules,
        ...availableOccupancyRules,
        ...availableTimelapseRules,
        ...availableAudioRules,
    ];

    const allAllowedRules = [
        ...allowedDetectionRules,
        ...allowedOccupancyRules,
        ...allowedTimelapseRules,
        ...allowedAudioRules,
    ];

    const recordDetectionSessionFrames = allAllowedRules.some(rule => rule.generateClip);

    const shouldListenAudio = !!allowedAudioRules.length;
    const isActiveForMqttReporting = isPluginEnabled && isMqttActive && isDeviceEnabledToMqtt;
    const shouldListenDetections = !!allowedDetectionRules.length || isActiveForMqttReporting;

    return {
        availableDetectionRules,
        availableOccupancyRules,
        availableTimelapseRules,
        availableAudioRules,
        allowedDetectionRules,
        allowedOccupancyRules,
        allowedTimelapseRules,
        allowedAudioRules,
        allAvailableRules,
        allAllowedRules,
        shouldListenDetections,
        shouldListenAudio,
        isActiveForMqttReporting,
        anyAllowedNvrDetectionRule,
        shouldListenDoorbell,
        recordDetectionSessionFrames,
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
            subKey = 'audioText';
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
    const showMoreConfigurationsKey = `${prefix}:${ruleName}:showMoreConfigurations`;
    const minDelayKey = `${prefix}:${ruleName}:minDelay`;
    const minMqttPublishDelayKey = `${prefix}:${ruleName}:minMqttPublishDelay`;
    const startRuleTextKey = `${prefix}:${ruleName}:startRuleText`;
    const endRuleTextKey = `${prefix}:${ruleName}:endRuleText`;
    const generateClipKey = `${prefix}:${ruleName}:generateClip`;
    const generateClipSpeedKey = `${prefix}:${ruleName}:generateClipSpeed`;

    // Specific for detection rules
    const detectionClassesKey = `${prefix}:${ruleName}:detecionClasses`;
    const nvrEventsKey = `${prefix}:${ruleName}:nvrEvents`;
    const frigateLabelsKey = `${prefix}:${ruleName}:frigateLabels`;
    const useNvrDetectionsKey = `${prefix}:${ruleName}:useNvrDetections`;
    const detectionSourceKey = `${prefix}:${ruleName}:detectionSource`;
    const whitelistedZonesKey = `${prefix}:${ruleName}:whitelistedZones`;
    const blacklistedZonesKey = `${prefix}:${ruleName}:blacklistedZones`;
    const markDetectionsKey = `${prefix}:${ruleName}:markDetections`;
    const recordingTriggerSecondsKey = `${prefix}:${ruleName}:recordingTriggerSeconds`;
    const peopleKey = `${prefix}:${ruleName}:people`;
    const platesKey = `${prefix}:${ruleName}:plates`;
    const plateMaxDistanceKey = `${prefix}:${ruleName}:plateMaxDistance`;
    const labelScoreKey = `${prefix}:${ruleName}:labelScore`;

    // Specific for timelapse rules
    const regularSnapshotIntervalKey = `${prefix}:${ruleName}:regularSnapshotInterval`;
    const framesAcquisitionDelayKey = `${prefix}:${ruleName}:framesAcquisitionDelay`;
    const timelapseFramerateKey = `${prefix}:${ruleName}:timelapseFramerate`;
    const additionalFfmpegParametersKey = `${prefix}:${ruleName}:additionalFfmpegParameters`;
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

    // Specific for audio rules
    const decibelThresholdKey = `${prefix}:${ruleName}:decibelThreshold`;
    const audioDurationKey = `${prefix}:${ruleName}:audioDuration`;

    return {
        common: {
            activationKey,
            enabledKey,
            currentlyActiveKey,
            textKey,
            scoreThresholdKey,
            enabledSensorsKey,
            disabledSensorsKey,
            notifiersKey,
            dayKey,
            startTimeKey,
            endTimeKey,
            securitySystemModesKey,
            aiEnabledKey,
            showMoreConfigurationsKey,
            minDelayKey,
            minMqttPublishDelayKey,
            startRuleTextKey,
            endRuleTextKey,
            generateClipKey,
            generateClipSpeedKey,
        },
        detection: {
            useNvrDetectionsKey,
            detectionSourceKey,
            whitelistedZonesKey,
            blacklistedZonesKey,
            recordingTriggerSecondsKey,
            nvrEventsKey,
            frigateLabelsKey,
            devicesKey,
            detectionClassesKey,
            markDetectionsKey,
            peopleKey,
            platesKey,
            plateMaxDistanceKey,
            labelScoreKey,
        },
        timelapse: {
            regularSnapshotIntervalKey,
            framesAcquisitionDelayKey,
            timelapseFramerateKey,
            additionalFfmpegParametersKey,
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
            detectedObjectsKey
        },
        audio: {
            decibelThresholdKey,
            audioDurationKey,
        }
    }
}

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

// export const basicFilter: StorageSetting['deviceFilter'] = device => device.interfaces.includes(ADVANCED_NOTIFIER_INTERFACE)
// export const deviceFilter: StorageSetting['deviceFilter'] = device => basicFilter(device) && device.interfaces.some(int => [...sensorInterfaces, ...cameraInterfaces].includes(int as ScryptedInterface));
// export const notifierFilter: StorageSetting['deviceFilter'] = device => basicFilter(device) && device.interfaces.some(int => notifierInterfaces.includes(int as ScryptedInterface));
// export const sensorsFilter: StorageSetting['deviceFilter'] = device => basicFilter(device) && device.interfaces.some(int => sensorInterfaces.includes(int as ScryptedInterface));
// export const cameraFilter: StorageSetting['deviceFilter'] = device => basicFilter(device) && device.interfaces.some(int => cameraInterfaces.includes(int as ScryptedInterface));
export const deviceFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.some(int => ${getInterfacesString([...sensorInterfaces, ...cameraInterfaces])}.includes(int))`;
export const notifierFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.some(int => ${getInterfacesString(notifierInterfaces)}.includes(int))`;
export const sensorsFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && type !== '${ScryptedDeviceType.Doorbell}' && interfaces.some(int => ${getInterfacesString(sensorInterfaces)}.includes(int))`;
export const cameraFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && interfaces.some(int => ${getInterfacesString(cameraInterfaces)}.includes(int))`;

type GetSpecificRules = (props: { group: string, subgroup: string, ruleName: string, showMore: boolean }) => StorageSetting[];
type OnRefreshSettings = () => Promise<void>

export const getNotifierData = (props: {
    notifierId: string,
    ruleType: RuleType,
}) => {
    const { notifierId, ruleType } = props;
    const notifier = sdk.systemManager.getDeviceById(notifierId);
    const pluginId = notifier.pluginId;
    const priorityChoices: NotificationPriority[] = [];
    const isDetectionRule = ruleType === RuleType.Detection;
    const isAudioRule = ruleType === RuleType.Audio;
    const withActions = ![NTFY_PLUGIN_ID, NVR_PLUGIN_ID].includes(pluginId) && isDetectionRule;
    const snoozingDefault = pluginId !== PUSHOVER_PLUGIN_ID;
    const addCameraActionsDefault = pluginId !== PUSHOVER_PLUGIN_ID;
    const withSnoozing = isDetectionRule || isAudioRule;
    const withSound = [PUSHOVER_PLUGIN_ID, HOMEASSISTANT_PLUGIN_ID].includes(pluginId);

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
    }

    return {
        priorityChoices,
        withActions,
        snoozingDefault,
        withSnoozing,
        addCameraActionsDefault,
        withSound,
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

    return {
        actionsKey,
        priorityKey,
        addSnoozeKey,
        addCameraActionsKey,
        titleKey,
        soundKey
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
    const { actionsKey, priorityKey, addSnoozeKey, addCameraActionsKey, titleKey, soundKey } = getNotifierKeys({ notifierId, ruleName, ruleType });

    const { priorityChoices, snoozingDefault, withActions, withSnoozing, addCameraActionsDefault, withSound } = getNotifierData({ notifierId, ruleType });

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

    return settings;
};

export const getRuleSettings = (props: {
    ruleType: RuleType,
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    device: DeviceBase,
    getSpecificRules: GetSpecificRules,
    refreshSettings: OnRefreshSettings,
    logger: Console
}) => {
    const { ruleType, storage, ruleSource, getSpecificRules, refreshSettings, device } = props;
    const isPlugin = ruleSource === RuleSource.Plugin;
    const group = isPlugin ? pluginRulesGroup : mixinRulesGroup;
    const settings: StorageSetting[] = [];
    const { rulesKey, subgroupPrefix } = ruleTypeMetadataMap[ruleType];
    const isDetectionRule = ruleType === RuleType.Detection;
    const isOccupancyRule = ruleType === RuleType.Occupancy;
    const isAudioRule = ruleType === RuleType.Audio;
    const { isCamera } = !isPlugin && device ? isDeviceSupported(device) : {};

    const rules = storage.getItem(rulesKey);
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
                generateClipKey,
                generateClipSpeedKey,
            }
        } = getRuleKeys({ ruleName, ruleType });

        const currentActivation = storage.getItem(activationKey as any) as DetectionRuleActivation || DetectionRuleActivation.Always;
        const showMoreConfigurations = safeParseJson<boolean>(storage.getItem(showMoreConfigurationsKey), false);
        const generateClip = safeParseJson<boolean>(storage.getItem(generateClipKey), false);
        const notifiers = safeParseJson<string[]>(storage.getItem(notifiersKey), []);
        const advancedSecurityEnabled = ruleType === RuleType.Detection && isPlugin;
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

        if ((isCamera || isPlugin) && (isOccupancyRule || isDetectionRule)) {
            settings.push(
                {
                    key: generateClipKey,
                    title: 'Notify with a clip',
                    description: 'Currently supported only by HA notifiers',
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
                }
            );
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
                },
                {
                    key: startTimeKey,
                    title: 'Start time',
                    group,
                    subgroup,
                    type: 'time',
                },
                {
                    key: endTimeKey,
                    title: 'End time',
                    group,
                    subgroup,
                    type: 'time',
                }
            );
        }

        settings.push(...getSpecificRules({ ruleName, subgroup, group, showMore: showMoreConfigurations }));

        if (ruleType !== RuleType.Occupancy) {
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

export const getDetectionRulesSettings = async (props: {
    storage: StorageSettings<any>,
    zones?: string[],
    frigateZones?: string[],
    people?: string[],
    frigateLabels?: string[],
    ruleSource: RuleSource,
    device?: DeviceBase,
    refreshSettings: OnRefreshSettings,
    logger: Console
}) => {
    const { storage, zones, frigateZones, device, ruleSource, frigateLabels, refreshSettings, logger, people } = props;
    const isPlugin = ruleSource === RuleSource.Plugin;
    const { isCamera } = !isPlugin ? isDeviceSupported(device) : {};

    const getSpecificRules: GetSpecificRules = ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { detection, common, } = getRuleKeys({ ruleName, ruleType: RuleType.Detection });

        const { scoreThresholdKey, activationKey, minDelayKey, minMqttPublishDelayKey } = common;
        const {
            blacklistedZonesKey,
            nvrEventsKey,
            frigateLabelsKey,
            recordingTriggerSecondsKey,
            useNvrDetectionsKey,
            detectionSourceKey,
            // markDetectionsKey,
            whitelistedZonesKey,
            devicesKey,
            detectionClassesKey,
            peopleKey,
            plateMaxDistanceKey,
            platesKey,
            labelScoreKey,
        } = detection;

        const useNvrDetections = storage.getItem(useNvrDetectionsKey) as boolean ?? false;
        const detectionClasses = safeParseJson<DetectionClass[]>(storage.getItem(detectionClassesKey), []);
        const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
        const detectionSource = storage.getItem(detectionSourceKey) as ScryptedEventSource ||
            (useNvrDetections ? ScryptedEventSource.NVR : ScryptedEventSource.RawDetection);
        const showCameraSettings = isPlugin || isCamera;

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

        const isFrigate = detectionSource === ScryptedEventSource.Frigate;

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

            if (detectionSource === ScryptedEventSource.NVR && isPlugin) {
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
                    }
                );
            }

            settings.push(
                {
                    key: scoreThresholdKey,
                    title: 'Score threshold',
                    description: 'Applied after detections. Threshold defined on the object detector will still take precedence',
                    group,
                    subgroup,
                    type: 'number',
                    placeholder: '0.7',
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
                deviceFilter,
                defaultValue: []
            });
        }

        const zonesToUse = isFrigate ?
            frigateZones : zones;
        const zonesDescription = isFrigate ? 'Zones defined on the Frigate interface' :
            'Zones defined in the `Object detection` section of type `Observe`';
        if (isCamera && zonesToUse) {
            settings.push(
                {
                    key: whitelistedZonesKey,
                    title: 'Whitelisted zones',
                    description: zonesDescription,
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    choices: zonesToUse,
                    readonly: !zonesToUse.length,
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
                    choices: zones,
                    readonly: !zones.length,
                    defaultValue: []
                },
            )
        }

        if (isCamera || isPlugin) {
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
        }

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

export const getAiSettingKeys = (aiPlatform: AiPlatform) => {
    const apiKeyKey = `${aiPlatform}:aiApiKey`;
    const apiUrlKey = `${aiPlatform}:aiApiUrl`;
    const modelKey = `${aiPlatform}:aiModel`;
    const systemPromptKey = `${aiPlatform}:aiSystemPrompt`;

    return {
        apiKeyKey,
        apiUrlKey,
        modelKey,
        systemPromptKey,
    }
}

export const getAiSettings = (props: {
    aiPlatform: AiPlatform,
    logger: Console,
    onRefresh: () => Promise<void>
}) => {
    const { aiPlatform, onRefresh } = props;

    const { apiKeyKey, apiUrlKey, modelKey, systemPromptKey } = getAiSettingKeys(aiPlatform);
    const settings: StorageSetting[] = [];

    if ([AiPlatform.OpenAi].includes(aiPlatform)) {
        settings.push(
            {
                key: apiUrlKey,
                group: 'AI',
                title: 'API URL',
                description: 'The API URL of the OpenAI compatible server.',
                defaultValue: 'https://api.openai.com/v1/chat/completions',
            },
        );
    }

    if (
        [AiPlatform.OpenAi,
        AiPlatform.GoogleAi,
        AiPlatform.AnthropicClaude,
        AiPlatform.Groq,
        ].includes(aiPlatform)) {
        settings.push(
            {
                key: apiKeyKey,
                title: 'API Key',
                description: 'The API Key or token.',
                group: 'AI',
            },
            {
                key: modelKey,
                group: 'AI',
                title: 'Model',
                description: 'The model to use to generate the image description. Must be vision capable.',
                defaultValue: defaultModel[aiPlatform],
            },
            {
                key: systemPromptKey,
                group: 'AI',
                title: 'System Prompt',
                type: 'textarea',
                description: 'The system prompt used to generate the notification.',
                defaultValue: 'Create a notification suitable description of the image provided by the user. Describe the people, animals (coloring and breed), or vehicles (color and model) in the image. Do not describe scenery or static objects. Do not direct the user to click the notification. The original notification metadata may be provided and can be used to provide additional context for the new notification, but should not be used verbatim.',
            }

        );
    }

    return settings;
}

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById(NVR_PLUGIN_ID, 'motion')?.id;

export const getOccupancyRulesSettings = async (props: {
    storage: StorageSettings<any>,
    zones?: string[],
    ruleSource: RuleSource,
    refreshSettings: OnRefreshSettings,
    logger: Console,
    device: DeviceBase,
}) => {
    const { storage, zones, ruleSource, refreshSettings, logger, device } = props;

    const getSpecificRules: GetSpecificRules = ({ group, ruleName, subgroup, showMore }) => {
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
            occupiesKey,
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
            }
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

    const getSpecificRules: GetSpecificRules = ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { timelapse, common } = getRuleKeys({ ruleName, ruleType: RuleType.Timelapse });

        const { textKey, dayKey, startTimeKey, endTimeKey } = common;
        const {
            // additionalFfmpegParametersKey,
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
            // {
            //     key: additionalFfmpegParametersKey,
            //     title: 'Additional FFmpeg parameters',
            //     group: groupName,
            //     subgroup: timelapseRuleName,
            //     value: storage.getItem(additionalFfmpegParametersKey),
            //     type: 'string',
            // },
            {
                key: dayKey,
                title: 'Day',
                description: 'Leave empty to affect all days',
                group,
                subgroup,
                type: 'day',
                multiple: true,
                defaultValue: []
            },
            {
                key: startTimeKey,
                title: 'Start time',
                group,
                subgroup,
                type: 'time',
            },
            {
                key: endTimeKey,
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

    const getSpecificRules: GetSpecificRules = ({ group, ruleName, subgroup }) => {
        const settings: StorageSetting[] = [];

        const { audio, common } = getRuleKeys({ ruleName, ruleType: RuleType.Audio });

        const { textKey, minDelayKey } = common;
        const { decibelThresholdKey, audioDurationKey } = audio;

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
                placeholder: '20',
                defaultValue: 20
            },
            {
                key: audioDurationKey,
                title: 'Duration in seconds',
                description: 'How long the audio should last to trigger the rule. Set 0 for instant notifications',
                group,
                subgroup,
                type: 'number',
                placeholder: '-',
            },
            {
                key: minDelayKey,
                title: 'Minimum notification delay',
                description: 'Minimum amount of seconds to wait between notifications.',
                group,
                subgroup,
                type: 'number',
                placeholder: '-',
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
    generateClipSpeed: VideoclipSpeed;
    notifierData: Record<string, {
        actions: NotificationAction[],
        priority: NotificationPriority,
        addSnooze: boolean,
        addCameraActions: boolean,
        sound: string,
    }>;
}

export interface DetectionRule extends BaseRule {
    markDetections: boolean;
    detectionClasses?: RuleDetectionClass[];
    nvrEvents?: NvrEvent[];
    frigateLabels?: string[];
    scoreThreshold?: number;
    labelScoreThreshold?: number;
    whitelistedZones?: string[];
    blacklistedZones?: string[];
    people?: string[];
    plates?: string[];
    plateMaxDistance?: number;
    disableNvrRecordingSeconds?: number;
    detectionSource?: ScryptedEventSource;
    imageSource?: ScryptedEventSource;
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
}) => {
    const { storage, ruleType, ruleName, ruleSource, securitySystem } = props;

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
        generateClipKey,
        generateClipSpeedKey,
    } } = getRuleKeys({
        ruleType,
        ruleName,
    });

    const isEnabled = storage.getItem(enabledKey);
    const currentlyActive = storage.getItem(currentlyActiveKey);
    const useAi = storage.getItem(aiEnabledKey);
    const customText = storage.getItem(textKey);
    const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
    const generateClipSpeed = storage.getItem(generateClipSpeedKey) as VideoclipSpeed || VideoclipSpeed.Fast;
    const securitySystemModes = storage.getItem(securitySystemModesKey) as SecuritySystemMode[] ?? [];
    const notifiers = storage.getItem(notifiersKey) as string[];
    const generateClip = storage.getItem(generateClipKey) as boolean;

    const rule: BaseRule = {
        isEnabled,
        ruleType,
        useAi,
        currentlyActive,
        name: ruleName,
        notifiers,
        customText,
        activationType,
        source: ruleSource,
        securitySystemModes,
        generateClip,
        generateClipSpeed,
        notifierData: {},
    };

    for (const notifierId of notifiers) {
        const { withActions, withSnoozing, snoozingDefault, addCameraActionsDefault, withSound } = getNotifierData({ notifierId, ruleType });
        const { actionsKey, priorityKey, addSnoozeKey, addCameraActionsKey, soundKey } = getNotifierKeys({ notifierId, ruleName, ruleType });
        const actions = storage.getItem(actionsKey) as string[] ?? [];
        const priority = storage.getItem(priorityKey) as NotificationPriority;
        const addSnooze = withSnoozing ? storage.getItem(addSnoozeKey) ?? snoozingDefault : false;
        const sound = withSound ? storage.getItem(soundKey) : undefined;
        const addCameraActions = storage.getItem(addCameraActionsKey) ?? addCameraActionsDefault;
        rule.notifierData[notifierId] = {
            actions: withActions ? actions.map(action => safeParseJson(action)) : [],
            priority,
            addSnooze,
            addCameraActions,
            sound,
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
                if (sensorDevice) {
                    return true;
                }

                const metadata = binarySensorMetadataMap[sensorDevice.type]
                return metadata.isActiveFn(sensorDevice);
            });
        }
        if (!!disabledSensors.length && sensorsOk) {
            sensorsOk = enabledSensors.every(sensorId => {
                const sensorDevice = sdk.systemManager.getDeviceById<DeviceInterface>(sensorId);
                if (sensorDevice) {
                    return true;
                }

                const metadata = binarySensorMetadataMap[sensorDevice.type]
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

export const getDetectionRules = (props: {
    deviceStorage?: StorageSettings<any>,
    pluginStorage: StorageSettings<PluginSettingKey>,
    device?: DeviceBase & StorageSettingsDevice,
    console: Console,
}) => {
    const { console, pluginStorage, device, deviceStorage } = props;
    const availableRules: DetectionRule[] = [];
    const allowedRules: DetectionRule[] = [];
    let anyAllowedNvrRule = false;
    let shouldListenDoorbell = false;
    let recordFrames = false;

    const deviceId = device?.id;
    const allDevices = getElegibleDevices().map(device => device.id);

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
                    minMqttPublishDelayKey
                },
                detection: {
                    useNvrDetectionsKey,
                    detectionSourceKey,
                    markDetectionsKey,
                    detectionClassesKey,
                    whitelistedZonesKey,
                    blacklistedZonesKey,
                    devicesKey,
                    nvrEventsKey,
                    frigateLabelsKey,
                    recordingTriggerSecondsKey,
                    peopleKey,
                    plateMaxDistanceKey,
                    platesKey,
                    labelScoreKey,
                } } = getRuleKeys({
                    ruleType: RuleType.Detection,
                    ruleName: detectionRuleName,
                });

            const useNvrDetections = storage.getItem(useNvrDetectionsKey) as boolean;
            const detectionSource = storage.getItem(detectionSourceKey) as ScryptedEventSource ||
                (useNvrDetections ? ScryptedEventSource.NVR : ScryptedEventSource.RawDetection);
            const markDetections = storage.getItem(markDetectionsKey) as boolean ?? false;
            const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
            const customText = storage.getItem(textKey) as string || undefined;
            const mainDevices = storage.getItem(devicesKey) as string[] ?? [];

            const devices = !isPlugin ? [deviceId] : mainDevices.length ? mainDevices : allDevices;
            const devicesToUse = activationType === DetectionRuleActivation.OnActive ? onActiveDevices : devices;

            const detectionClasses = storage.getItem(detectionClassesKey) as RuleDetectionClass[] ?? [];
            const nvrEvents = storage.getItem(nvrEventsKey) as NvrEvent[] ?? [];
            const frigateLabels = storage.getItem(frigateLabelsKey) as string[] ?? [];
            const scoreThreshold = storage.getItem(scoreThresholdKey) as number || 0.7;
            const minDelay = storage.getItem(minDelayKey) as number;
            const minMqttPublishDelay = storage.getItem(minMqttPublishDelayKey) as number || 15;
            const disableNvrRecordingSeconds = storage.getItem(recordingTriggerSecondsKey) as number;

            const { rule, basicRuleAllowed, ...restCriterias } = initBasicRule({
                ruleName: detectionRuleName,
                ruleSource,
                ruleType: RuleType.Detection,
                storage,
                securitySystem
            });

            const detectionRule: DetectionRule = {
                ...rule,
                scoreThreshold,
                detectionClasses,
                markDetections,
                nvrEvents,
                devices: devicesToUse,
                customText,
                deviceId,
                disableNvrRecordingSeconds,
                minDelay,
                minMqttPublishDelay,
                detectionSource,
                frigateLabels,
            };

            if (!isPlugin) {
                detectionRule.whitelistedZones = storage.getItem(whitelistedZonesKey) as string[] ?? [];
                detectionRule.blacklistedZones = storage.getItem(blacklistedZonesKey) as string[] ?? [];
            }

            const hasFace = detectionClasses.includes(DetectionClass.Face);
            const hasPlate = detectionClasses.includes(DetectionClass.Plate);

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

            // if (deviceOk || isPlugin || activationType === DetectionRuleActivation.OnActive) {
            if (deviceOk || (isPlugin && activationType === DetectionRuleActivation.OnActive)) {
                availableRules.push(cloneDeep(detectionRule));
            }

            if (ruleAllowed) {
                allowedRules.push(cloneDeep(detectionRule));
                !anyAllowedNvrRule && (anyAllowedNvrRule = detectionRule.detectionSource === ScryptedEventSource.NVR);
                !shouldListenDoorbell && (shouldListenDoorbell = detectionClasses.includes(DetectionClass.Doorbell));
            }

        }
    };

    processDetectionRules(pluginStorage, RuleSource.Plugin);

    if (deviceStorage) {
        processDetectionRules(deviceStorage, RuleSource.Device);
    }

    return { availableRules, allowedRules, anyAllowedNvrRule, shouldListenDoorbell };
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
                occupiesKey
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
            securitySystem
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
    audioDuration?: number;
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
                additionalFfmpegParametersKey,
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
            securitySystem
        });

        const customText = deviceStorage.getItem(textKey) as string;
        const additionalFfmpegParameters = deviceStorage.getItem(additionalFfmpegParametersKey) as string;
        const minDelay = deviceStorage.getItem(framesAcquisitionDelayKey) as number;
        const timelapseFramerate = deviceStorage.getItem(timelapseFramerateKey) as number;
        const lastGenerated = deviceStorage.getItem(lastGeneratedKey) as number;
        const regularSnapshotInterval = deviceStorage.getItem(regularSnapshotIntervalKey) as number;

        const timelapseRule: TimelapseRule = {
            ...rule,
            customText,
            minDelay,
            timelapseFramerate,
            additionalFfmpegParameters,
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
            securitySystem
        });

        const customText = deviceStorage.getItem(textKey) as string;
        const decibelThreshold = deviceStorage.getItem(decibelThresholdKey) as number || 20;
        const audioDuration = deviceStorage.getItem(audioDurationKey) as number || 0;
        const minDelay = deviceStorage.getItem(minDelayKey) as number;

        const audioRule: AudioRule = {
            ...rule,
            customText,
            decibelThreshold,
            audioDuration,
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

    return {
        availableRules,
        allowedRules,
    };
}

export const addBoundingBoxesToImage = async (props: {
    detection: ObjectsDetected,
    bufferImage: Buffer;
    console: Console;
}) => {
    const { detection, bufferImage } = props;
    const fontSize = 20;
    const color = '#00FF00';
    const thickness = 4;

    const svgRectsAndTexts = detection.detections.map(({ boundingBox, label, className, score }) => {
        const labelText = `${label || className}: ${score.toFixed(2)}`;
        const [x, y, width, height] = boundingBox;
        const textY = y - 5 < fontSize ? y + fontSize + 5 : y - 5;
        return `
          <rect x="${x}" y="${y}" width="${width}" height="${height}"
            fill="none" stroke="${color}" stroke-width="${thickness}"/>
          <text x="${x}" y="${textY}" class="label">${labelText}</text>
        `;
    }).join('\n');

    const svgOverlay = `
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <style>
            .label {
              fill: ${color};
              font-size: ${fontSize}px;
              font-family: Arial, sans-serif;
              font-weight: bold;
            }
          </style>
          ${svgRectsAndTexts}
        </svg>
      `;

    const outputBuffer = await sharp(bufferImage)
        .composite([
            {
                input: Buffer.from(svgOverlay),
                top: 0,
                left: 0,
                blend: 'over',
            }
        ])
        .toBuffer();

    const newB64Image = outputBuffer.toString('base64');
    const newImage = await sdk.mediaManager.createMediaObject(outputBuffer, ScryptedMimeTypes.Image);

    return {
        newB64Image,
        newImage,
    };
}

// export const addBoundingToImage = async (boundingBox: number[], imageBuffer: Buffer, console: Console, label: string) => {
//     const [x, y, width, height] = boundingBox;
//     console.log(`Trying to add boundingBox ${boundingBox}`);
//     const borderWidth = 5;
//     try {
//         const createRectangle = async () => {
//             // Buffer per il rettangolo pieno
//             const fullRect = await sharp({
//                 create: {
//                     width,
//                     height,
//                     channels: 3,
//                     background: { r: 255, g: 255, b: 255, alpha: 1 }, // Bianco
//                 },
//             })
//                 .png()
//                 .toBuffer();

//             // Crea il rettangolo vuoto
//             const hollowRect = await sharp(fullRect)
//                 .extract({ // Rimuovi la parte interna
//                     left: borderWidth,
//                     top: borderWidth,
//                     width: width - borderWidth * 2,
//                     height: height - borderWidth * 2,
//                 })
//                 .toBuffer();

//             return sharp(fullRect)
//                 .composite([{
//                     input: hollowRect,
//                     blend: 'dest-out' // Rende l'interno trasparente
//                 }])
//                 .toBuffer();
//         };

//         const rectangle = await createRectangle();

//         const newImageBuffer = await sharp(imageBuffer)
//             .composite([{
//                 input: rectangle,
//                 top: y,
//                 left: x,
//             }])
//             .png()
//             .toBuffer();

//         const newB64Image = newImageBuffer.toString('base64');
//         const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);
//         console.log(`Bounding box added ${boundingBox}: ${newB64Image}`);

//         return { newImageBuffer, newImage, newB64Image };
//     } catch (e) {
//         console.log('Error adding bounding box', e);
//         return {}
//     }
// }

// export const addBoundingBoxes = async (base64Image: string, detections: ObjectDetectionResult[]) => {
//     try {

//         const imageBuffer = Buffer.from(base64Image, 'base64');
//         let image = await Jimp.read(imageBuffer);

//         const borderColor = rgbaToInt(255, 0, 0, 255); // Rosso
//         const font = await loadFont(SANS_16_WHITE);

//         detections.forEach(({ boundingBox, className }) => {
//             const text = detectionClassesDefaultMap[className];
//             const [x, y, width, height] = boundingBox;
//             // image.scan(x, y, width, height, function (dx, dy, idx) {
//             //     // Bordo rosso (RGB: 255, 0, 0)
//             //     this.bitmap.data[idx] = 255;   // Rosso
//             //     this.bitmap.data[idx + 1] = 0; // Verde
//             //     this.bitmap.data[idx + 2] = 0; // Blu
//             //     this.bitmap.data[idx + 3] = 255; // Alpha
//             // });
//             function iterator(x, y, offset) {
//                 this.bitmap.data.writeUInt32BE(0x00000088, offset, true);
//             }

//             image.scan(236, 100, 240, 1, iterator);
//             image.scan(236, 100 + 110, 240, 1, iterator);
//             image.scan(236, 100, 1, 110, iterator);
//             image.scan(236 + 240, 100, 1, 110, iterator);
//         });
//         const outputBuffer = await image.getBuffer('image/jpeg');

//         const newB64Image = outputBuffer.toString('base64');
//         const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);

//         return { newB64Image, newImage };

//     } catch (error) {
//         console.error("Errore:", error.message);
//         return null;
//     }
// }

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
        isBinarySensor ? SupportedSensorType.Binary :
            isFloodSensor ? SupportedSensorType.Flood :
                isEntrySensor ? SupportedSensorType.Entry :
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

export const getDecibelsFromRtp_PCMU8 = (rtpPacket: Buffer, logger: Console) => {
    const RTP_HEADER_SIZE = 12;
    if (rtpPacket.length <= RTP_HEADER_SIZE) return null;

    const payload = rtpPacket.slice(RTP_HEADER_SIZE);
    const sampleCount = payload.length;
    if (sampleCount === 0) return null;

    let sumSquares = 0;
    for (let i = 0; i < payload.length; i++) {
        const sample = payload[i];
        const centered = sample - 128;
        const normalized = centered / 128;
        sumSquares += normalized * normalized;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    const db = 20 * Math.log10(rms || 0.00001);

    logger.debug(`Audio detections: ${JSON.stringify({ sumSquares, rms, db })}`);

    return db;
}

export const toKebabCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();

export const toSnakeCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();

export const toTitleCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
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

    return `${cameraId}_${notifierId}_${specificIdentifier}_${priority}`;
}

export const getB64ImageLog = (b64Image: string) => `${b64Image ? b64Image?.substring(0, 10) + '...' : 'NO_IMAGE'}`;

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
            "value_template": "{{ trigger.event.data.action_name is match('scrypted_an_snooze_.*') or trigger.event.data.action is match('scrypted_an_snooze_.*') }}"
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