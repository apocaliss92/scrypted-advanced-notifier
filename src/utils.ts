import sdk, { BinarySensor, Camera, DeviceBase, EntrySensor, LockState, MediaObject, NotifierOptions, ObjectDetectionResult, ObjectDetector, PanTiltZoom, Point, Reboot, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, SecuritySystem, SecuritySystemMode, Settings, VideoCamera } from "@scrypted/sdk";
import { SettingsMixinDeviceBase } from "@scrypted/sdk/settings-mixin";
import { StorageSetting, StorageSettings, StorageSettingsDevice, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import fs from 'fs';
import { Jimp, loadFont, rgbaToInt } from "jimp";
import { SANS_16_WHITE } from "jimp/fonts";
import { cloneDeep, sortBy, uniq, uniqBy } from "lodash";
import moment, { Moment } from "moment";
import path from 'path';
import sharp from 'sharp';
import { name, scrypted } from '../package.json';
import { AiPlatform, defaultModel } from "./aiUtils";
import { classnamePrio, defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isLabelDetection } from "./detecionClasses";
import AdvancedNotifierPlugin from "./main";
const { endpointManager } = sdk;

export type DeviceInterface = Camera & ScryptedDeviceBase & Settings & ObjectDetector & VideoCamera & EntrySensor & Lock & BinarySensor & Reboot & PanTiltZoom;
export const ADVANCED_NOTIFIER_INTERFACE = name;
export const PUSHOVER_PLUGIN_ID = '@scrypted/pushover';
export const HOMEASSISTANT_PLUGIN_ID = '@scrypted/homeassistant';
export const SNAPSHOT_WIDTH = 1280;

export interface ObserveZoneData {
    name: string;
    path: Point[]
};

export type StoreImageFn = (props: {
    device: ScryptedDeviceBase,
    name: string,
    timestamp: number,
    imageMo?: MediaObject,
    b64Image?: string,
}) => Promise<void>

export const getElegibleDevices = () => {
    const allDevices = Object.keys(sdk.systemManager.getSystemState()).map(deviceId => sdk.systemManager.getDeviceById(deviceId) as unknown as DeviceInterface);

    return allDevices.filter(device => {
        return eval(
            `(function() { var interfaces = ${JSON.stringify(
                device.interfaces
            )}; var type='${device.type}'; var id = '${device.id}'; return ${deviceFilter} })`
        )()
    })
}

export enum EventType {
    ObjectDetection = 'ObjectDetection',
    Package = 'Package',
    Doorbell = 'Doorbell',
    Contact = 'Contact',
    Doorlock = 'Doorlock',
}

export const getDefaultEntityId = (name: string) => {
    const convertedName = name?.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_') ?? 'not_set';

    return `binary_sensor.${convertedName}_notification_triggered`;
}

export const getWebooks = async () => {
    const lastSnapshot = 'lastSnapshot';
    const haAction = 'haAction';
    const timelapseDownload = 'timelapseDownload';
    const timelapseStream = 'timelapseStream';
    const timelapseThumbnail = 'timelapseThumbnail';

    return {
        lastSnapshot,
        haAction,
        timelapseDownload,
        timelapseStream,
        timelapseThumbnail,
    }
}

export const getFolderPaths = async (deviceId: string) => {
    const basePath = process.env.SCRYPTED_PLUGIN_VOLUME;
    const snapshotsFolder = path.join(basePath, 'snapshots', deviceId);

    try {
        await fs.promises.access(snapshotsFolder);
    } catch {
        await fs.promises.mkdir(snapshotsFolder, { recursive: true });
    }

    return { snapshotsFolder };
}

export const isDetectionRule = (rule: BaseRule) => [
    RuleType.Audio,
    RuleType.Detection,
].includes(rule.ruleType);

export const storeWebhookImage = async (props: {
    deviceId: string,
    image: MediaObject,
    logger: Console,
    webhook: string,
}) => {
    const { deviceId, image, logger, webhook } = props;
    const { snapshotsFolder } = await getFolderPaths(deviceId);
    const lastSnapshotFilePath = path.join(snapshotsFolder, `${webhook}.jpg`);
    const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpg');
    logger.debug(`Storing image for webhook ${webhook}, size is ${jpeg.byteLength}`);
    await fs.promises.writeFile(lastSnapshotFilePath, jpeg).catch(e => logger.log(`Error saving webhook ${webhook} image`, e));
}

export const getWebookUrls = async (cameraDeviceOrAction: string | undefined, console: Console) => {
    let lastSnapshotCloudUrl: string;
    let lastSnapshotLocalUrl: string;
    let haActionUrl: string;

    const { lastSnapshot, haAction } = await getWebooks();

    try {
        const cloudEndpoint = await endpointManager.getPublicCloudEndpoint();
        const localEndpoint = await endpointManager.getPublicLocalEndpoint();

        lastSnapshotCloudUrl = `${cloudEndpoint}${lastSnapshot}/${cameraDeviceOrAction}`;
        lastSnapshotLocalUrl = `${localEndpoint}${lastSnapshot}/${cameraDeviceOrAction}`;
        haActionUrl = `${cloudEndpoint}${haAction}/${cameraDeviceOrAction}`;
    } catch (e) {
        console.log('Error fetching webhookUrls', e);
    }

    return {
        lastSnapshotCloudUrl,
        lastSnapshotLocalUrl,
        haActionUrl,
    }
}

export interface ParseNotificationMessageResult {
    triggerDevice: DeviceInterface,
    textKey: TextSettingKey,
    detection: ObjectDetectionResult,
    allDetections: ObjectDetectionResult[],
    eventType: EventType | NvrEvent,
    classname: DetectionClass,
    label: string,
}

export const parseNvrNotificationMessage = async (cameraDevice: DeviceInterface, deviceSensors: string[], options?: NotifierOptions, console?: Console): Promise<ParseNotificationMessageResult> => {
    try {
        let triggerDevice: DeviceInterface = cameraDevice;
        let textKey: TextSettingKey;
        let detection: ObjectDetectionResult
        let label: string;
        const subtitle = options?.subtitle;

        let eventType: EventType | NvrEvent;
        let allDetections: ObjectDetectionResult[] = options?.recordedEvent?.data?.detections ?? [];

        if (subtitle === 'Offline') {
            textKey = 'offlineText';
            eventType = NvrEvent.Offline;
        } else if (subtitle === 'Online') {
            textKey = 'onlineText';
            eventType = NvrEvent.Online;
        } else if (subtitle === 'Recording Interrupted') {
            textKey = 'streamInterruptedText';
            eventType = NvrEvent.RecordingInterrupted;
            const regex = new RegExp('The (.*) has been offline for an extended period.');
            label = regex.exec(options.body)[1];
            console.log(`Recording Interrupted received: ${JSON.stringify({ options, label, eventType, textKey })}`);
        } else {
            if (subtitle.includes('Maybe: Vehicle')) {
                textKey = 'plateDetectedText';
                detection = allDetections.find(det => det.className === 'plate');
                eventType = EventType.ObjectDetection;
                label = detection.label;
            } else if (subtitle.includes('Person')) {
                textKey = 'personDetectedText';
                detection = allDetections.find(det => det.className === 'person');
                eventType = EventType.ObjectDetection;
            } else if (subtitle.includes('Vehicle')) {
                detection = allDetections.find(det => det.className === 'vehicle');
                eventType = EventType.ObjectDetection;
                textKey = 'vehicleDetectedText';
            } else if (subtitle.includes('Animal')) {
                detection = allDetections.find(det => det.className === 'animal');
                eventType = EventType.ObjectDetection;
                textKey = 'animalDetectedText';
            } else if (subtitle.includes('Maybe: ')) {
                textKey = 'familiarDetectedText';
                detection = allDetections.find(det => det.className === 'face');
                eventType = EventType.ObjectDetection;
                label = detection.label;
            } else if (subtitle.includes('Motion')) {
                textKey = 'motionDetectedText';
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
                eventType = EventType.ObjectDetection;
            } else if (subtitle.includes('Door/Window Open')) {
                textKey = 'doorWindowText';
                eventType = EventType.Contact;
            } else if (subtitle.includes('Doorbell Ringing')) {
                textKey = 'doorbellText';
                eventType = EventType.Doorbell;
            } else if (subtitle.includes('Door Unlocked')) {
                textKey = 'doorlockText';
                eventType = EventType.Doorlock;
            } else if (subtitle.includes('Package Detected')) {
                textKey = 'packageText';
                eventType = EventType.Package;
                detection = allDetections.find(det => det.className === 'package');
                console.log(`Package detection received: ${JSON.stringify(options)}`);
            }
        }

        // Remove this when nvr will provide trigger IDs
        if ([EventType.Contact, EventType.Doorlock, EventType.Doorbell].includes(eventType as EventType)) {
            const systemState = sdk.systemManager.getSystemState();

            const foundSensor = deviceSensors.find(deviceId => {
                const device = sdk.systemManager.getDeviceById(deviceId);
                if (device) {
                    if (device.type === ScryptedDeviceType.Lock) {
                        return systemState[deviceId].lockState?.value === LockState.Unlocked;
                    } else {
                        return systemState[deviceId].binaryState?.value === true;
                    }
                }
            })

            if (foundSensor) {
                triggerDevice = sdk.systemManager.getDeviceById(foundSensor) as unknown as DeviceInterface
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
            textKey,
            detection,
            allDetections,
            eventType,
            classname: detection ? detectionClassesDefaultMap[detection.className] : undefined,
            label,
        }
    } catch (e) {
        console.log(`Error parsing notification: ${JSON.stringify({ device: cameraDevice.name, options, deviceSensors })}`, e);
        return {} as ParseNotificationMessageResult;
    }
}

export enum NotificationSource {
    NVR = 'NVR',
    TEST = 'TEST',
    DETECTION = 'DETECTION',
    TIMELAPSE = 'TIMELAPSE',
}

const getDetectionId = (detection: ObjectDetectionResult) => detection.id ? `${detectionClassesDefaultMap[detection.className]}-${detection.id}` : undefined;

export const filterAndSortValidDetections = (props: {
    detections: ObjectDetectionResult[],
    logger: Console,
    processedIds: Record<string, boolean>
}) => {
    const { detections, logger, processedIds } = props;
    const filteredByProcessdIds = detections.filter(det => {
        const id = getDetectionId(det);

        return !id || !processedIds[id];
    });
    const sortedByPriorityAndScore = sortBy(filteredByProcessdIds,
        (detection) => [detection?.className ? classnamePrio[detection.className] : 100,
        1 - (detection.score ?? 0)]
    );
    // const sortedByPriorityAndScore = sortBy(detections,
    //     (detection) => [detection?.className ? classnamePrio[detection.className] : 100,
    //     1 - (detection.score ?? 0)]
    // );
    let hasLabel = false;
    const uniqueByClassName = uniqBy(sortedByPriorityAndScore, det => det.className);
    const candidates = uniqueByClassName.filter(det => {
        const { className, label, movement } = det;
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
        if (hasLabel) {
            hasLabel = isLabel;
        }

        const id = getDetectionId(det);

        id && (processedIds[id] = true);

        return true;
    });

    return { candidates, hasLabel, processedIds };
}

export type TextSettingKey =
    | 'detectionTimeText'
    | 'motionDetectedText'
    | 'personDetectedText'
    | 'familiarDetectedText'
    | 'plateDetectedText'
    | 'animalDetectedText'
    | 'vehicleDetectedText'
    | 'doorWindowText'
    | 'doorbellText'
    | 'packageText'
    | 'personText'
    | 'vehicleText'
    | 'animalText'
    | 'onlineText'
    | 'doorlockText'
    | 'offlineText'
    | 'streamInterruptedText';

export const getTextSettings = (forMixin: boolean) => {
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
        motionDetectedText: {
            [groupKey]: 'Texts',
            title: 'Motion',
            type: 'string',
            description: 'Expression used to render the text when a motion is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Motion detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Motion detected in ${room}' : undefined
        },
        personDetectedText: {
            [groupKey]: 'Texts',
            title: 'Person detected text',
            type: 'string',
            description: 'Expression used to render the text when a person is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Person detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Person detected in ${room}' : undefined
        },
        familiarDetectedText: {
            [groupKey]: 'Texts',
            title: 'Familiar detected text',
            type: 'string',
            description: 'Expression used to render the text when a familiar is detected. Available arguments ${room} ${time} ${person} ${nvrLink}',
            defaultValue: !forMixin ? '${person} detected in ${room}' : undefined,
            placeholder: !forMixin ? '${person} detected in ${room}' : undefined
        },
        plateDetectedText: {
            [groupKey]: 'Texts',
            title: 'Plate detected text',
            type: 'string',
            description: 'Expression used to render the text when a plate is detected. Available arguments ${room} ${time} ${plate} ${nvrLink}',
            defaultValue: !forMixin ? '${plate} detected in ${room}' : undefined,
            placeholder: !forMixin ? '${plate} detected in ${room}' : undefined
        },
        animalDetectedText: {
            [groupKey]: 'Texts',
            title: 'Animal detected text',
            type: 'string',
            description: 'Expression used to render the text when an animal is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Animal detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Animal detected in ${room}' : undefined
        },
        vehicleDetectedText: {
            [groupKey]: 'Texts',
            title: 'Vehicle detected text',
            type: 'string',
            description: 'Expression used to render the text when a vehicle is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Vehicle detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Vehicle detected in ${room}' : undefined
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
        packageText: {
            [groupKey]: 'Texts',
            title: 'Package text',
            type: 'string',
            description: 'Expression used to render the text when a package is detected. Available arguments ${room} ${time} ${nvrLink}',
            defaultValue: !forMixin ? 'Package detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Package detected in ${room}' : undefined
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
        personText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Person text',
            type: 'string',
            defaultValue: 'Person',
            placeholder: 'Person',
            hide: forMixin
        },
        animalText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Animal text',
            type: 'string',
            defaultValue: 'Animal',
            placeholder: 'Animal',
            hide: forMixin
        },
        vehicleText: {
            group: 'Texts',
            subgroup: 'Detection classes',
            title: 'Vehicle text',
            type: 'string',
            defaultValue: 'Vehicle',
            placeholder: 'Vehicle',
            hide: forMixin
        }
    }

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
export const rulesKey = 'advancedNotifierRules';

export type MixinBaseSettingKey =
    | 'info'
    | 'debug'
    | 'entityId'
    | 'haDeviceClass'
    | 'useNvrDetections'
    | 'haActions'
    | typeof rulesKey;

export enum NotificationPriority {
    VeryLow = "VeryLow",
    Low = "Low",
    Normal = "Normal",
    High = "High"
}

export const getMixinBaseSettings = (props: {
    mixin: SettingsMixinDeviceBase<any>,
    plugin: AdvancedNotifierPlugin,
    isCamera: boolean,
    refreshSettings: () => Promise<void>
}) => {
    try {
        const { mixin, isCamera, refreshSettings } = props;
        const device = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(mixin.id);
        const defaultEntityId = !isCamera ? device.nativeId.split(':')[1] : getDefaultEntityId(device.name);

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
            entityId: {
                title: 'EntityID',
                type: 'string',
                defaultValue: defaultEntityId,
                immediate: true,
            },
            haDeviceClass: {
                title: 'Device class',
                type: 'string'
            },
            // DETECTION
            useNvrDetections: {
                title: 'Use NVR detections',
                description: 'If enabled, the NVR notifications will be used. Make sure to extend the notifiers with this extension',
                type: 'boolean',
                subgroup: 'Detection',
                immediate: true,
                hide: true,
            },
            // NOTIFIER
            haActions: {
                title: 'Homeassistant Actions',
                description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
                subgroup: 'Notifier',
                type: 'string',
                multiple: true
            },
            [ruleTypeMetadataMap[RuleType.Detection].rulesKey]: {
                title: 'Detection rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
                defaultValue: [],
                choices: [],
                onPut: async () => await refreshSettings()
            },
        } as StorageSettingsDict<MixinBaseSettingKey>;

        if (isCamera) {
            settings[ruleTypeMetadataMap[RuleType.Occupancy].rulesKey] = {
                title: 'Occupancy rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
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
                defaultValue: [],
                choices: [],
                onPut: async () => {
                    console.log('put')
                    await refreshSettings()
                }
            };
            settings[ruleTypeMetadataMap[RuleType.Audio].rulesKey] = {
                title: 'Audio rules',
                group: mixinRulesGroup,
                type: 'string',
                multiple: true,
                combobox: true,
                defaultValue: [],
                choices: [],
                onPut: async () => {
                    console.log('put')
                    await refreshSettings()
                }
            };
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
        anyAllowedNvrRule: anyAllowedNvrDetectionRule
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

    const activeDevicesForReporting = pluginStorage.getItem('activeDevicesForReporting');
    const isPluginEnabled = pluginStorage.getItem('pluginEnabled');
    const isMqttActive = pluginStorage.getItem('mqttEnabled');

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

    const shouldListenAudio = !!allowedAudioRules.length;
    const isActiveForMqttReporting = isPluginEnabled && isMqttActive && activeDevicesForReporting.includes(device.id);
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
        anyAllowedNvrDetectionRule
    }
}

const textKeyClassnameMap: Record<DetectionClass, TextSettingKey> = {
    [DetectionClass.Person]: 'personDetectedText',
    [DetectionClass.Face]: 'familiarDetectedText',
    [DetectionClass.Plate]: 'plateDetectedText',
    [DetectionClass.Vehicle]: 'vehicleDetectedText',
    [DetectionClass.Animal]: 'animalDetectedText',
    [DetectionClass.Motion]: 'motionDetectedText',
    [DetectionClass.Package]: 'packageText',
    [DetectionClass.DoorLock]: 'doorlockText',
    [DetectionClass.DoorSensor]: 'doorWindowText',
}

export const getTextKey = (props: { classname?: string, eventType: EventType }) => {
    const { classname, eventType } = props;

    let key: TextSettingKey;

    switch (eventType) {
        case EventType.Contact:
            key = 'doorWindowText';
            break;
        case EventType.Doorbell:
            key = 'doorbellText';
            break;
        case EventType.Doorlock:
            key = 'doorlockText';
            break;
        case EventType.ObjectDetection: {
            key = textKeyClassnameMap[detectionClassesDefaultMap[classname]];
        }
    }

    return key;
}

export enum DetectionRuleActivation {
    Always = 'Always',
    OnActive = 'OnActive',
    Schedule = 'Schedule',
    AlarmSystem = 'AlarmSystem',
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
    const actionsKey = `${prefix}:${ruleName}:haActions`;
    const priorityKey = `${prefix}:${ruleName}:priority`;
    const securitySystemModesKey = `${prefix}:${ruleName}:securitySystemModes`;
    const aiEnabledKey = `${prefix}:${ruleName}:aiEnabled`;
    const showMoreConfigurationsKey = `${prefix}:${ruleName}:showMoreConfigurations`;
    const minDelayKey = `${prefix}:${ruleName}:minDelay`;
    const minMqttPublishDelayKey = `${prefix}:${ruleName}:minMqttPublishDelay`;

    // Specific for detection rules
    const detectionClassesKey = `${prefix}:${ruleName}:detecionClasses`;
    const nvrEventsKey = `${prefix}:${ruleName}:nvrEvents`;
    const useNvrDetectionsKey = `${prefix}:${ruleName}:useNvrDetections`;
    const whitelistedZonesKey = `${prefix}:${ruleName}:whitelistedZones`;
    const blacklistedZonesKey = `${prefix}:${ruleName}:blacklistedZones`;
    const markDetectionsKey = `${prefix}:${ruleName}:markDetections`;
    // Deprecated, use events-recorder-plugin
    const recordingTriggerSecondsKey = `${prefix}:${ruleName}:recordingTriggerSeconds`;

    // Specific for timelapse rules
    const regularSnapshotIntervalKey = `${prefix}:${ruleName}:regularSnapshotInterval`;
    const framesAcquisitionDelayKey = `${prefix}:${ruleName}:framesAcquisitionDelay`;
    const timelapseFramerateKey = `${prefix}:${ruleName}:timelapseFramerate`;
    const additionalFfmpegParametersKey = `${prefix}:${ruleName}:additionalFfmpegParameters`;
    const generateKey = `${prefix}:${ruleName}:generate`;
    const cleanDataKey = `${prefix}:${ruleName}:clenup`;

    // Specific for occupancy rules
    const detectionClassKey = `${prefix}:${ruleName}:detecionClassKey`;
    const objectDetectorKey = `${prefix}:${ruleName}:objectDetector`;
    const captureZoneKey = `${prefix}:${ruleName}:captureZone`;
    const zoneKey = `${prefix}:${ruleName}:zone`;
    const zoneMatchTypeKey = `${prefix}:${ruleName}:zoneMatchType`;
    const zoneOccupiedTextKey = `${prefix}:${ruleName}:zoneOccupiedText`;
    const zoneNotOccupiedTextKey = `${prefix}:${ruleName}:zoneNotOccupiedText`;
    const changeStateConfirmKey = `${prefix}:${ruleName}:changeStateConfirm`;
    const maxObjectsKey = `${prefix}:${ruleName}:maxObjects`;
    const forceUpdateKey = `${prefix}:${ruleName}:forceUpdate`;

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
            actionsKey,
            priorityKey,
            securitySystemModesKey,
            aiEnabledKey,
            showMoreConfigurationsKey,
            minDelayKey,
            minMqttPublishDelayKey,
        },
        detection: {
            useNvrDetectionsKey,
            whitelistedZonesKey,
            blacklistedZonesKey,
            recordingTriggerSecondsKey,
            nvrEventsKey,
            devicesKey,
            detectionClassesKey,
            markDetectionsKey,
        },
        timelapse: {
            regularSnapshotIntervalKey,
            framesAcquisitionDelayKey,
            timelapseFramerateKey,
            additionalFfmpegParametersKey,
            generateKey,
            cleanDataKey,
        },
        occupancy: {
            objectDetectorKey,
            captureZoneKey,
            zoneKey,
            zoneMatchTypeKey,
            zoneOccupiedTextKey,
            zoneNotOccupiedTextKey,
            changeStateConfirmKey,
            maxObjectsKey,
            forceUpdateKey,
            detectionClassKey,
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

export const deviceFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && ['${ScryptedDeviceType.Camera}', '${ScryptedDeviceType.Doorbell}', '${ScryptedDeviceType.Sensor}', '${ScryptedDeviceType.Lock}', '${ScryptedDeviceType.Entry}'].includes(type)`;
export const notifierFilter: StorageSetting['deviceFilter'] = `interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && ['${ScryptedDeviceType.Notifier}'].includes(type)`;
export const sensorsFilter: StorageSetting['deviceFilter'] = `['${ScryptedDeviceType.Sensor}', '${ScryptedDeviceType.Entry}', '${ScryptedDeviceType.Lock}'].includes(type)`;

type GetSpecificRules = (props: { group: string, subgroup: string, ruleName: string, showMore: boolean }) => StorageSetting[];
type OnRuleToggle = (ruleName: string, enabled: boolean) => Promise<void>
type OnShowMore = (showMore: boolean) => Promise<void>

export const getRuleSettings = (props: {
    ruleType: RuleType,
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    getSpecificRules: GetSpecificRules,
    onRuleToggle?: OnRuleToggle,
    onShowMore: OnShowMore,
    logger: Console
}) => {
    const { ruleType, storage, ruleSource, getSpecificRules, onRuleToggle, onShowMore } = props;
    const group = ruleSource === RuleSource.Device ? mixinRulesGroup : pluginRulesGroup;
    const settings: StorageSetting[] = [];
    const { rulesKey, subgroupPrefix } = ruleTypeMetadataMap[ruleType];

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
                actionsKey,
                priorityKey,
                dayKey,
                startTimeKey,
                endTimeKey,
                enabledSensorsKey,
                disabledSensorsKey,
                securitySystemModesKey,
                aiEnabledKey,
            }
        } = getRuleKeys({ ruleName, ruleType });

        let currentActivation = storage.getItem(activationKey as any) as DetectionRuleActivation;
        if (currentActivation === DetectionRuleActivation.AlarmSystem) {
            currentActivation = DetectionRuleActivation.Always;
        }
        const showMoreConfigurationsRaw = storage.getItem(showMoreConfigurationsKey) as boolean;
        const showMoreConfigurations = typeof showMoreConfigurationsRaw === 'string' ? JSON.parse(showMoreConfigurationsRaw) : showMoreConfigurationsRaw;
        const aiEnabledRaw = storage.getItem(aiEnabledKey) as boolean;
        const aiEnabled = typeof aiEnabledRaw === 'string' ? JSON.parse(aiEnabledRaw) : aiEnabledRaw;

        settings.push(
            {
                key: enabledKey,
                title: 'Enabled',
                type: 'boolean',
                group,
                subgroup,
                immediate: true,
                onPut: onRuleToggle ? async (_, active) => {
                    await onRuleToggle(ruleName, active)
                } : undefined,
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
                onPut: async (_, showMore) => {
                    await onShowMore(showMore)
                },
            },
        );

        if (ruleType === RuleType.Detection) {
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
                choices: [
                    DetectionRuleActivation.Always,
                    DetectionRuleActivation.OnActive,
                    DetectionRuleActivation.Schedule,
                ],
                placeholder: DetectionRuleActivation.Always,
                immediate: true,
                combobox: true
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
                defaultValue: []
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

        const isAudioRule = ruleType === RuleType.Audio;
        if (ruleType !== RuleType.Occupancy) {
            settings.push({
                key: textKey,
                title: isAudioRule ? 'Notification text' : 'Custom text',
                description: isAudioRule ?
                    'Available arguments ${duration} ${decibels}' :
                    'Available arguments ${room} ${time} ${nvrLink} ${zone} ${class} ${label}',
                group,
                subgroup,
                type: 'string',
                defaultValue: isAudioRule ? 'Audio detected: ${decibels} dB for ${duration} seconds' : undefined,
                hide: ruleType === RuleType.Detection && !showMoreConfigurations
            });
        }

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
            },
            {
                key: priorityKey,
                type: 'string',
                title: 'Pushover priority',
                group,
                subgroup,
                choices: [NotificationPriority.VeryLow, NotificationPriority.Low, NotificationPriority.Normal, NotificationPriority.High],
                immediate: true,
                combobox: true,
                hide: !showMoreConfigurations,
                defaultValue: NotificationPriority.Normal
            },
            {
                key: actionsKey,
                title: 'Homeassistant Actions',
                description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
                type: 'string',
                multiple: true,
                group,
                subgroup,
                hide: !showMoreConfigurations
            },
        );
    }

    return settings;
}

export const getDetectionRulesSettings = async (props: {
    storage: StorageSettings<any>,
    zones?: string[],
    ruleSource: RuleSource,
    isCamera?: boolean,
    onRuleToggle?: OnRuleToggle,
    onShowMore: OnShowMore,
    logger: Console
}) => {
    const { storage, zones, isCamera, ruleSource, onRuleToggle, onShowMore, logger } = props;
    const isPlugin = ruleSource === RuleSource.Plugin;

    const getSpecificRules: GetSpecificRules = ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { detection, common, } = getRuleKeys({ ruleName, ruleType: RuleType.Detection });

        const { scoreThresholdKey, activationKey, minDelayKey, minMqttPublishDelayKey } = common;
        const {
            blacklistedZonesKey,
            nvrEventsKey,
            recordingTriggerSecondsKey,
            useNvrDetectionsKey,
            // markDetectionsKey,
            whitelistedZonesKey,
            devicesKey,
            detectionClassesKey,
        } = detection;

        const useNvrDetections = storage.getItem(useNvrDetectionsKey) as boolean ?? false;
        // const devicesRaw = storage.getItem(devicesKey) ?? [];
        // const devices = typeof devicesRaw === 'string' ? JSON.parse(storage.getItem(devicesKey) ?? '[]') : devicesRaw;
        const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
        // const anyCameraDevice = (isPlugin && devices
        //     .some(deviceId => [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(sdk.systemManager.getDeviceById(deviceId)?.type))
        // ) || isCamera || activationType === DetectionRuleActivation.OnActive;

        settings.push(
            {
                key: useNvrDetectionsKey,
                title: 'Use NVR detections',
                type: 'boolean',
                group,
                subgroup,
                immediate: true
            }
        );

        // if (anyCameraDevice) {
        settings.push(
            {
                key: detectionClassesKey,
                title: 'Detection classes',
                group,
                subgroup,
                multiple: true,
                combobox: true,
                choices: defaultDetectionClasses,
                defaultValue: []
            },
            {
                key: scoreThresholdKey,
                title: 'Score threshold',
                group,
                subgroup,
                type: 'number',
                placeholder: '0.7',
                hide: !showMore
            },
        );
        // }

        if (useNvrDetections && isPlugin) {
            settings.push(
                {
                    key: nvrEventsKey,
                    title: 'NVR events',
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    choices: Object.values(NvrEvent),
                    defaultValue: []
                }
            );
        }

        // if (!useNvrDetections) {
        //     settings.push(
        //         {
        //             key: markDetectionsKey,
        //             title: 'Mark detections',
        //             description: 'Add a coloured box around the detections',
        //             group,
        //             subgroup,
        //             type: 'boolean',
        //             immediate: true
        //         }
        //     );
        // }

        if (isPlugin && activationType !== DetectionRuleActivation.OnActive) {
            settings.push({
                key: devicesKey,
                title: 'Devices',
                group,
                subgroup,
                type: 'device',
                multiple: true,
                combobox: true,
                deviceFilter,
                defaultValue: []
            });
        }

        if (isCamera && zones) {
            settings.push(
                {
                    key: whitelistedZonesKey,
                    title: 'Whitelisted zones',
                    group,
                    subgroup,
                    multiple: true,
                    combobox: true,
                    choices: zones,
                    readonly: !zones.length,
                    defaultValue: []
                },
                {
                    key: blacklistedZonesKey,
                    title: 'Blacklisted zones',
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
                    description: '[DEPRECATED] Set a value here in seconds to enable the camera recording when the rule is triggered. After the seconds specified, recording will be disabled',
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
        onRuleToggle,
        onShowMore,
        logger,
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

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;

export const getOccupancyRulesSettings = async (props: {
    storage: StorageSettings<any>,
    zones?: string[],
    ruleSource: RuleSource,
    onRuleToggle: OnRuleToggle,
    onShowMore: OnShowMore,
    logger: Console
}) => {
    const { storage, zones, ruleSource, onRuleToggle, onShowMore, logger } = props;

    const getSpecificRules: GetSpecificRules = ({ group, ruleName, subgroup, showMore }) => {
        const settings: StorageSetting[] = [];

        const { occupancy, common } = getRuleKeys({ ruleName, ruleType: RuleType.Occupancy });

        const { scoreThresholdKey } = common;
        const {
            captureZoneKey,
            changeStateConfirmKey,
            forceUpdateKey,
            maxObjectsKey,
            objectDetectorKey,
            zoneKey,
            zoneMatchTypeKey,
            zoneNotOccupiedTextKey,
            zoneOccupiedTextKey,
            detectionClassKey,
        } = occupancy;

        settings.push(
            {
                key: detectionClassKey,
                title: 'Detection class',
                group,
                subgroup,
                choices: defaultDetectionClasses,
            },
            {
                key: zoneKey,
                title: 'Observe zone',
                group,
                subgroup,
                choices: zones,
                readonly: !zones.length
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
                defaultValue: ZoneMatchType.Intersect
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
                key: objectDetectorKey,
                title: 'Object Detector',
                description: 'Select the object detection plugin to use for detecting objects. (overrides the configuration in plugin)',
                type: 'device',
                group,
                subgroup,
                deviceFilter: `interfaces.includes('${ScryptedInterface.ObjectDetectionPreview}') && id !== '${nvrAcceleratedMotionSensorId}'`,
                immediate: true,
                hide: !showMore
            },
        );

        return settings;
    };

    return getRuleSettings({
        getSpecificRules,
        ruleSource,
        ruleType: RuleType.Occupancy,
        storage,
        onRuleToggle,
        onShowMore,
        logger
    });
}

export const getTimelapseRulesSettings = async (props: {
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    onGenerateTimelapse: (ruleName: string) => Promise<void>,
    onCleanDataTimelapse: (ruleName: string) => Promise<void>,
    onRuleToggle: OnRuleToggle,
    onShowMore: OnShowMore,
    logger: Console
}) => {
    const { storage, ruleSource, onCleanDataTimelapse, onGenerateTimelapse, onRuleToggle, onShowMore, logger } = props;

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
                placeholder: '5',
                defaultValue: 5,
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
        onRuleToggle,
        onShowMore,
        logger
    });
}

export const getAudioRulesSettings = async (props: {
    storage: StorageSettings<any>,
    ruleSource: RuleSource,
    onRuleToggle: OnRuleToggle,
    onShowMore: OnShowMore,
    logger: Console
}) => {
    const { storage, ruleSource, onRuleToggle, onShowMore, logger } = props;

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
        onRuleToggle,
        onShowMore,
        logger
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
    isNvr?: boolean;
    ruleType: RuleType;
    name: string;
    deviceId?: string;
    notifiers: string[];
    customText?: string;
    priority: NotificationPriority;
    actions?: string[];
    securitySystemModes?: SecuritySystemMode[];
    minDelay?: number;
    minMqttPublishDelay?: number;
    devices?: string[];
}

export interface DetectionRule extends BaseRule {
    markDetections: boolean;
    detectionClasses?: DetectionClass[];
    nvrEvents?: NvrEvent[];
    scoreThreshold?: number;
    whitelistedZones?: string[];
    blacklistedZones?: string[];
    disableNvrRecordingSeconds?: number;
}

const initBasicRule = (props: {
    ruleType: RuleType,
    storage?: StorageSettings<string>,
    ruleName: string,
    ruleSource: RuleSource,
    activeNotifiers: string[],
    securitySystem?: ScryptedDeviceBase,
}) => {
    const { storage, ruleType, ruleName, ruleSource, activeNotifiers, securitySystem } = props;

    const { common: {
        currentlyActiveKey,
        activationKey,
        dayKey,
        startTimeKey,
        endTimeKey,
        enabledSensorsKey,
        disabledSensorsKey,
        securitySystemModesKey,
        actionsKey,
        enabledKey,
        notifiersKey,
        priorityKey,
        textKey,
        aiEnabledKey
    } } = getRuleKeys({
        ruleType,
        ruleName,
    });

    const isEnabled = storage.getItem(enabledKey);
    const currentlyActive = storage.getItem(currentlyActiveKey);
    const useAi = storage.getItem(aiEnabledKey);
    const priority = storage.getItem(priorityKey) as NotificationPriority;
    const actions = storage.getItem(actionsKey) as string[];
    const customText = storage.getItem(textKey);
    let activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
    if (activationType === DetectionRuleActivation.AlarmSystem) {
        activationType = DetectionRuleActivation.Always;
    }
    const securitySystemModes = storage.getItem(securitySystemModesKey) as SecuritySystemMode[] ?? [];
    const notifiers = storage.getItem(notifiersKey) as string[];

    const notifiersTouse = notifiers?.filter?.(notifierId => activeNotifiers?.includes(notifierId));

    const rule: BaseRule = {
        isEnabled,
        ruleType,
        useAi,
        currentlyActive,
        name: ruleName,
        notifiers: notifiersTouse,
        priority,
        actions,
        customText,
        activationType,
        source: ruleSource,
        securitySystemModes,
    };

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
            const referenceStart = moment(Number(startTime));
            const referenceEnd = moment(Number(endTime));
            const now = moment();

            const getMinutes = (date: Moment) => date.minutes() + (date.hours() * 60);
            const startMinutes = getMinutes(referenceStart);
            const nowMinutes = getMinutes(now);
            const endMinutes = getMinutes(referenceEnd);

            if (startMinutes > endMinutes) {
                // Interval crosses midnight
                if (nowMinutes < startMinutes) {
                    // current time crosses midnight
                    timeAllowed = nowMinutes <= endMinutes;
                } else {
                    timeAllowed = nowMinutes >= startMinutes;
                }
            } else {
                timeAllowed = nowMinutes >= startMinutes && nowMinutes <= endMinutes;
            }
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

    let isSecuritySystemEnabled = true;
    let securitySyetemState;
    const securitySystemDeviceId = securitySystem?.id;
    if (securitySystemDeviceId && securitySystemModes?.length) {
        const securitySystemDevice = sdk.systemManager.getDeviceById<SecuritySystem>(securitySystemDeviceId);
        if (securitySystemDevice) {
            securitySyetemState = securitySystemDevice.securitySystemState;
            const currentMode = securitySyetemState?.mode;
            isSecuritySystemEnabled = currentMode ? securitySystemModes.includes(currentMode) : false;
        }
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
    pluginStorage: StorageSettings<any>,
    device?: DeviceBase & StorageSettingsDevice,
    console: Console,
}) => {
    const { console, pluginStorage, device, deviceStorage } = props;
    const availableRules: DetectionRule[] = [];
    const allowedRules: DetectionRule[] = [];
    let anyAllowedNvrRule = false;

    const deviceId = device?.id;
    const deviceType = device?.type;

    const { notifiers: activeNotifiers, activeDevicesForNotifications: onActiveDevices, securitySystem } = pluginStorage.values;

    const { rulesKey } = ruleTypeMetadataMap[RuleType.Detection];

    const processDetectionRules = (storage: StorageSettings<any>, ruleSource: RuleSource) => {
        const detectionRuleNames = storage.getItem(rulesKey) ?? [];

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
                    markDetectionsKey,
                    detectionClassesKey,
                    whitelistedZonesKey,
                    blacklistedZonesKey,
                    devicesKey,
                    nvrEventsKey,
                    recordingTriggerSecondsKey
                } } = getRuleKeys({
                    ruleType: RuleType.Detection,
                    ruleName: detectionRuleName,
                });

            const useNvrDetections = storage.getItem(useNvrDetectionsKey) as boolean;
            const markDetections = storage.getItem(markDetectionsKey) as boolean ?? false;
            const activationType = storage.getItem(activationKey) as DetectionRuleActivation || DetectionRuleActivation.Always;
            const customText = storage.getItem(textKey) as string || undefined;
            const mainDevices = storage.getItem(devicesKey) as string[] ?? [];

            const devices = ruleSource === RuleSource.Device ? [deviceId] : mainDevices;
            const devicesToUse = activationType === DetectionRuleActivation.OnActive ? onActiveDevices : devices;

            const detectionClasses = storage.getItem(detectionClassesKey) as DetectionClass[] ?? [];
            const nvrEvents = storage.getItem(nvrEventsKey) as NvrEvent[] ?? [];
            const scoreThreshold = storage.getItem(scoreThresholdKey) as number || 0.7;
            const minDelay = storage.getItem(minDelayKey) as number;
            const minMqttPublishDelay = storage.getItem(minMqttPublishDelayKey) as number || 15;
            const disableNvrRecordingSeconds = storage.getItem(recordingTriggerSecondsKey) as number;

            const { rule, basicRuleAllowed, ...restCriterias } = initBasicRule({
                activeNotifiers,
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
                isNvr: useNvrDetections
            };

            if (ruleSource === RuleSource.Device) {
                detectionRule.whitelistedZones = storage.getItem(whitelistedZonesKey) as string[] ?? [];
                detectionRule.blacklistedZones = storage.getItem(blacklistedZonesKey) as string[] ?? [];
            }

            let isSensorEnabled = true;
            if (
                ruleSource === RuleSource.Plugin &&
                deviceType &&
                [ScryptedDeviceType.Lock, ScryptedDeviceType.Sensor].includes(deviceType) &&
                !mainDevices.length
            ) {
                if (deviceType === ScryptedDeviceType.Lock) {
                    isSensorEnabled = detectionClasses.includes(DetectionClass.DoorLock);
                } else if (deviceType === ScryptedDeviceType.Sensor) {
                    isSensorEnabled = detectionClasses.includes(DetectionClass.DoorSensor);
                }
            }

            const deviceOk = !!devicesToUse?.length && (deviceId ? devicesToUse.includes(deviceId) : true);
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

            // if (deviceOk || (activationType === DetectionRuleActivation.OnActive && (device ? onActiveDevices.includes(deviceId) : true))) {
            if (deviceOk || activationType === DetectionRuleActivation.OnActive) {
                availableRules.push(cloneDeep(detectionRule));
            }

            if (ruleAllowed) {
                allowedRules.push(cloneDeep(detectionRule));
                !anyAllowedNvrRule && (anyAllowedNvrRule = rule.isNvr);
            }

        }
    };

    processDetectionRules(pluginStorage, RuleSource.Plugin);

    if (deviceStorage) {
        processDetectionRules(deviceStorage, RuleSource.Device);
    }

    return { availableRules, allowedRules, anyAllowedNvrRule };
}

export interface OccupancyRule extends BaseRule {
    objectDetector: string;
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

    const { notifiers: activeNotifiers, securitySystem } = pluginStorage.values;
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
                objectDetectorKey,
                zoneKey,
                zoneMatchTypeKey,
                zoneNotOccupiedTextKey,
                zoneOccupiedTextKey,
            }
        } = getRuleKeys({
            ruleType: RuleType.Occupancy,
            ruleName: occupancyRuleName,
        });

        const { rule, basicRuleAllowed } = initBasicRule({
            activeNotifiers,
            ruleName: occupancyRuleName,
            ruleSource: RuleSource.Device,
            ruleType: RuleType.Occupancy,
            storage: deviceStorage,
            securitySystem
        });

        const zoneOccupiedText = deviceStorage.getItem(zoneOccupiedTextKey) as string;
        const zoneNotOccupiedText = deviceStorage.getItem(zoneNotOccupiedTextKey) as string;
        const objectDetector = deviceStorage.getItem(objectDetectorKey) as ScryptedDevice;
        const detectionClass = deviceStorage.getItem(detectionClassKey) as DetectionClass;
        const scoreThreshold = deviceStorage.getItem(scoreThresholdKey) as number || 0.5;
        const changeStateConfirm = deviceStorage.getItem(changeStateConfirmKey) as number || 30;
        const forceUpdate = deviceStorage.getItem(forceUpdateKey) as number || 30;
        const maxObjects = deviceStorage.getItem(maxObjectsKey) as number || 1;
        const observeZone = deviceStorage.getItem(zoneKey) as string;
        const zoneMatchType = deviceStorage.getItem(zoneMatchTypeKey) as ZoneMatchType;
        const captureZone = deviceStorage.getItem(captureZoneKey) as Point[]

        const occupancyRule: OccupancyRule = {
            ...rule,
            objectDetector: objectDetector?.id,
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

    const { notifiers: activeNotifiers, securitySystem } = pluginStorage.values;
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
            }
        } = getRuleKeys({
            ruleType: RuleType.Timelapse,
            ruleName: timelapseRuleName,
        });

        const { rule, basicRuleAllowed } = initBasicRule({
            activeNotifiers,
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
        const regularSnapshotInterval = deviceStorage.getItem(regularSnapshotIntervalKey) as number;

        const timelapseRule: TimelapseRule = {
            ...rule,
            customText,
            minDelay,
            timelapseFramerate,
            additionalFfmpegParameters,
            regularSnapshotInterval,
            deviceId: device.id
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

    const { notifiers: activeNotifiers, securitySystem } = pluginStorage.values;
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
            activeNotifiers,
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

export const addBoundingToImage = async (boundingBox: number[], imageBuffer: Buffer, console: Console, label: string) => {
    const [x, y, width, height] = boundingBox;
    console.log(`Trying to add boundingBox ${boundingBox}`);
    const borderWidth = 5;
    try {
        const createRectangle = async () => {
            // Buffer per il rettangolo pieno
            const fullRect = await sharp({
                create: {
                    width,
                    height,
                    channels: 3,
                    background: { r: 255, g: 255, b: 255, alpha: 1 }, // Bianco
                },
            })
                .png()
                .toBuffer();

            // Crea il rettangolo vuoto
            const hollowRect = await sharp(fullRect)
                .extract({ // Rimuovi la parte interna
                    left: borderWidth,
                    top: borderWidth,
                    width: width - borderWidth * 2,
                    height: height - borderWidth * 2,
                })
                .toBuffer();

            return sharp(fullRect)
                .composite([{
                    input: hollowRect,
                    blend: 'dest-out' // Rende l'interno trasparente
                }])
                .toBuffer();
        };

        const rectangle = await createRectangle();

        const newImageBuffer = await sharp(imageBuffer)
            .composite([{
                input: rectangle,
                top: y,
                left: x,
            }])
            .png()
            .toBuffer();

        const newB64Image = newImageBuffer.toString('base64');
        const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);
        console.log(`Bounding box added ${boundingBox}: ${newB64Image}`);

        return { newImageBuffer, newImage, newB64Image };
    } catch (e) {
        console.log('Error adding bounding box', e);
        return {}
    }
}

export const addBoundingBoxes = async (base64Image: string, detections: ObjectDetectionResult[]) => {
    try {

        const imageBuffer = Buffer.from(base64Image, 'base64');
        let image = await Jimp.read(imageBuffer);

        const borderColor = rgbaToInt(255, 0, 0, 255); // Rosso
        const font = await loadFont(SANS_16_WHITE);

        detections.forEach(({ boundingBox, className }) => {
            const text = detectionClassesDefaultMap[className];
            const [x, y, width, height] = boundingBox;
            // image.scan(x, y, width, height, function (dx, dy, idx) {
            //     // Bordo rosso (RGB: 255, 0, 0)
            //     this.bitmap.data[idx] = 255;   // Rosso
            //     this.bitmap.data[idx + 1] = 0; // Verde
            //     this.bitmap.data[idx + 2] = 0; // Blu
            //     this.bitmap.data[idx + 3] = 255; // Alpha
            // });
            function iterator(x, y, offset) {
                this.bitmap.data.writeUInt32BE(0x00000088, offset, true);
            }

            image.scan(236, 100, 240, 1, iterator);
            image.scan(236, 100 + 110, 240, 1, iterator);
            image.scan(236, 100, 1, 110, iterator);
            image.scan(236 + 240, 100, 1, 110, iterator);
        });
        const outputBuffer = await image.getBuffer('image/jpeg');

        const newB64Image = outputBuffer.toString('base64');
        const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);

        return { newB64Image, newImage };

    } catch (error) {
        console.error("Errore:", error.message);
        return null;
    }
}

export const getPushoverPriority = (priority: NotificationPriority) => priority === NotificationPriority.High ? 1 :
    (!priority || priority === NotificationPriority.Normal) ? 0 :
        priority === NotificationPriority.Low ? -1 :
            -2;


export const getNowFriendlyDate = () => {
    const now = new Date();
    return `${now.getDate()}-${now.getMonth()}-${now.getFullYear()}_${now.getTime()}`;
}

export function getAllDevices() {
    return Object.keys(sdk.systemManager.getSystemState()).map(id => sdk.systemManager.getDeviceById(id));
}

export const convertSettingsToStorageSettings = async (props: {
    device: StorageSettingsDevice,
    dynamicSettings: StorageSetting[],
    initStorage: StorageSettingsDict<string>
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

export const getFrameGenerator = () => {
    const pipelines = Object.keys(sdk.systemManager.getSystemState())
        .map(id => sdk.systemManager.getDeviceById(id))
        .filter(d => d.interfaces.includes(ScryptedInterface.VideoFrameGenerator));
    const webassembly = sdk.systemManager.getDeviceById('@scrypted/nvr', 'decoder') || undefined;
    const gstreamer = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'gstreamer') || undefined;
    const libav = sdk.systemManager.getDeviceById('@scrypted/python-codecs', 'libav') || undefined;
    const ffmpeg = sdk.systemManager.getDeviceById('@scrypted/objectdetector', 'ffmpeg') || undefined;
    const use = pipelines.find(p => p.name === 'Default') || webassembly || gstreamer || libav || ffmpeg;
    return use.id;
}

export const supportedSensors: ScryptedDeviceType[] = [
    ScryptedDeviceType.Sensor,
    ScryptedDeviceType.Lock,
    ScryptedDeviceType.Entry,
];

export type SupportedSensor = typeof supportedSensors[number];

export interface BinarySensorMetadata {
    isActiveFn: (device: ScryptedDeviceBase, value?: any) => boolean,
    interface: ScryptedInterface
};

export const binarySensorMetadataMap: Partial<Record<SupportedSensor, BinarySensorMetadata>> = {
    [ScryptedDeviceType.Sensor]: {
        interface: ScryptedInterface.BinarySensor,
        isActiveFn: (device, value) => !!(device?.binaryState ?? value),
    },
    [ScryptedDeviceType.Lock]: {
        interface: ScryptedInterface.Lock,
        isActiveFn: (device, value) => (device?.lockState ?? value) === LockState.Unlocked
    },
    [ScryptedDeviceType.Entry]: {
        interface: ScryptedInterface.EntrySensor,
        isActiveFn: (device, value) => !!(device?.entryOpen ?? value),
    }
}

export const supportedCameraInterfaces: ScryptedInterface[] = [ScryptedInterface.Camera, ScryptedInterface.VideoCamera];
export const supportedSensorInterfaces: ScryptedInterface[] = Object.values(binarySensorMetadataMap).flatMap(item => item.interface);
export const supportedInterfaces = [
    ...supportedCameraInterfaces,
    ...supportedSensorInterfaces,
    ScryptedInterface.Notifier
];

export const pcmU8ToDb = (payload: Uint8Array): number => {
    let sum = 0;
    const count = payload.length;

    if (count === 0) return 0;

    for (let i = 0; i < count; i++) {
        const sample = payload[i] - 128;
        sum += sample * sample;
    }

    const rms = Math.sqrt(sum / count);
    const minRMS = 1.0;

    if (rms < minRMS) return 0;

    const db = 20 * Math.log10(rms / minRMS);
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