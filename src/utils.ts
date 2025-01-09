import sdk, { Camera, LockState, MediaObject, NotifierOptions, ObjectDetectionResult, ObjectsDetected, Point, ScryptedDeviceBase, ScryptedDeviceType, ScryptedMimeTypes, SecuritySystem, SecuritySystemMode, Setting, Settings } from "@scrypted/sdk"
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { cloneDeep, keyBy, sortBy, uniq, uniqBy } from "lodash";
const { endpointManager } = sdk;
import { scrypted, name } from '../package.json';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isLabelDetection } from "./detecionClasses";
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import AdvancedNotifierPlugin from "./main";

export type DeviceInterface = Camera & ScryptedDeviceBase & Settings;
export const ADVANCED_NOTIFIER_INTERFACE = name;
export const detectRuleEnabledRegex = new RegExp('rule:(.*):enabled');
export const occupancyRuleEnabledRegex = new RegExp('occupancyRule:(.*):enabled');

export interface ObserveZoneData {
    name: string;
    path: Point[]
};
export type ObserveZoneClasses = Record<string, Partial<Record<DetectionClass, number>>>;
export type OccupancyRuleData = {
    rule: OccupancyRule;
    occupies: boolean;
    detectedResult: ObjectsDetected
};

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

    return `binary_sensor.${convertedName}_triggered`;
}

export const getWebooks = async () => {
    const lastSnapshot = 'lastSnapshot';
    const haAction = 'haAction';

    return {
        lastSnapshot,
        haAction,
    }
}

export const getFolderPaths = async (deviceId: string) => {
    const basePath = process.env.SCRYPTED_PLUGIN_VOLUME;
    const snapshotsFolder = path.join(basePath, 'snapshots', deviceId);

    if (!fs.existsSync(snapshotsFolder)) {
        fs.mkdirSync(snapshotsFolder, { recursive: true });
    }

    return { snapshotsFolder };
}

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
    logger.debug(`Storing image, size is ${jpeg.byteLength}`);
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
                if (device.type === ScryptedDeviceType.Lock) {
                    return systemState[deviceId].lockState?.value === LockState.Unlocked;
                } else {
                    return systemState[deviceId].binaryState?.value === true;
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
        console.log(`Error parsing notification: ${JSON.stringify({ device: cameraDevice.name, options })}`, e);
        return {} as ParseNotificationMessageResult;
    }
}

export enum NotificationSource {
    NVR = 'NVR',
    TEST = 'TEST',
    DETECTION = 'DETECTION'
}

const classnamePrio = {
    face: 1,
    plate: 2,
    person: 3,
    vehicle: 4,
    animal: 5,
    package: 6,
    motion: 7,
}

const initZoneDetections = Object.keys(DetectionClass).reduce((tot, curr) => ({
    ...tot,
    [curr]: false,
}), {});

export const filterAndSortValidDetections = (detections: ObjectDetectionResult[], logger: Console) => {
    const sortedByPriorityAndScore = sortBy(detections,
        (detection) => [detection?.className ? classnamePrio[detection.className] : 100,
        1 - (detection.score ?? 0)]
    );
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

        return true;
    });

    return { candidates, hasLabel };
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
            description: 'Expression used to render the text when a vehicle is detected. Available arguments ${room} $[time}',
            defaultValue: !forMixin ? 'Someone at the door' : undefined,
            placeholder: !forMixin ? 'Someone at the door' : undefined
        },
        doorWindowText: {
            [groupKey]: 'Texts',
            title: 'Door/Window open text',
            type: 'string',
            description: 'Expression used to render the text when a binary sensor opens. Available arguments ${room} $[time} ${nvrLink}',
            defaultValue: !forMixin ? 'Door/window opened in ${room}' : undefined,
            placeholder: !forMixin ? 'Door/window opened in ${room}' : undefined
        },
        doorlockText: {
            [groupKey]: 'Texts',
            title: 'Doorlock sensor open text',
            type: 'string',
            description: 'Expression used to render the text when a lock sensor opens. Available arguments ${room} $[time} ${nvrLink}',
            defaultValue: !forMixin ? 'Door unlocked in ${room}' : undefined,
            placeholder: !forMixin ? 'Door unlocked in ${room}' : undefined
        },
        packageText: {
            [groupKey]: 'Texts',
            title: 'Package text',
            type: 'string',
            description: 'Expression used to render the text when a package is detected. Available arguments ${room} $[time} ${nvrLink}',
            defaultValue: !forMixin ? 'Package detected in ${room}' : undefined,
            placeholder: !forMixin ? 'Package detected in ${room}' : undefined
        },
        onlineText: {
            [groupKey]: 'Texts',
            title: 'Online device text',
            type: 'string',
            description: 'Expression used to render the text when a device comes back online. Available arguments $[time}',
            defaultValue: !forMixin ? 'Back online at ${time}' : undefined,
            placeholder: !forMixin ? 'Back online at ${time}' : undefined,
        },
        offlineText: {
            [groupKey]: 'Texts',
            title: 'Online device text',
            type: 'string',
            description: 'Expression used to render the text when a device goes offline. Available arguments $[time}',
            defaultValue: !forMixin ? 'Went offline at ${time}' : undefined,
            placeholder: !forMixin ? 'Went offline at ${time}' : undefined,
        },
        streamInterruptedText: {
            [groupKey]: 'Texts',
            title: 'Stream interrupted text',
            type: 'string',
            description: 'Expression used to render the text when a streams gets interrupted. Available arguments $[time} ${streamName}',
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

export const detectionRulesGroup = 'Advanced notifier detection rules';
export const occupancyRulesGroup = 'Advanced notifier occupancy rules';

export type MixinBaseSettingKey =
    | 'debug'
    | 'room'
    | 'entityId'
    | 'haDeviceClass'
    | 'useNvrDetections'
    | 'useNvrImages'
    | 'haActions'
    | typeof detectionRulesKey
    | typeof occupancyRulesKey

export enum NotificationPriority {
    VeryLow = "VeryLow",
    Low = "Low",
    Normal = "Normal",
    High = "High"
}

export const getMixinBaseSettings = (name: string, withOccupancy: boolean) => {
    const settings: StorageSettingsDict<MixinBaseSettingKey> = {
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        room: {
            title: 'Room',
            type: 'string',
            immediate: true,
        },
        entityId: {
            title: 'EntityID',
            type: 'string',
            defaultValue: getDefaultEntityId(name),
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
        useNvrImages: {
            title: 'Use NVR images',
            description: 'If enabled, the NVR images coming from NVR will be used, otherwise the one defined in the plugin',
            type: 'boolean',
            subgroup: 'Detection',
            defaultValue: true,
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
        [detectionRulesKey]: {
            title: 'Rules',
            group: detectionRulesGroup,
            type: 'string',
            multiple: true,
            combobox: true,
            defaultValue: [],
            choices: [],
        },
    } as StorageSettingsDict<MixinBaseSettingKey>;

    if (withOccupancy) {
        settings[occupancyRulesKey] = {
            title: 'Rules',
            group: occupancyRulesGroup,
            type: 'string',
            multiple: true,
            combobox: true,
            defaultValue: [],
            choices: [],
        };
    }

    return settings;
}

export const mainPluginName = scrypted.name;

export const isDeviceEnabled = async (deviceId: string, deviceSettings: Setting[], plugin: AdvancedNotifierPlugin, deviceType?: ScryptedDeviceType) => {
    const mainSettings = await plugin.getSettings();
    const mainSettingsByKey = keyBy(mainSettings, 'key');

    const deviceSettingsByKey = keyBy(deviceSettings, 'key');
    const { detectionRules, skippedRules, nvrRules, allDeviceRules, } = getDeviceRules({
        deviceId,
        deviceType,
        deviceStorage: deviceSettingsByKey,
        mainPluginStorage: mainSettingsByKey,
    });

    const { occupancyRules, skippedOccupancyRules, allOccupancyRules } = getDeviceOccupancyRules({
        deviceStorage: deviceSettingsByKey,
        mainPluginStorage: mainSettingsByKey,
    });

    const isPluginEnabled = mainSettingsByKey.pluginEnabled.value as boolean;
    const isMqttActive = mainSettingsByKey.mqttEnabled.value as boolean;
    const isActiveForNotifications = isPluginEnabled && (!!occupancyRules.length || !!detectionRules.length);
    const isActiveForNvrNotifications = isPluginEnabled && !!nvrRules.length;
    const isActiveForMqttReporting = isPluginEnabled && isMqttActive && (mainSettingsByKey.activeDevicesForReporting?.value as string || []).includes(deviceId);

    return {
        isPluginEnabled,
        isActiveForNotifications,
        isActiveForNvrNotifications,
        isActiveForMqttReporting,
        detectionRules,
        skippedRules,
        nvrRules,
        allDeviceRules,
        skippedOccupancyRules,
        occupancyRules,
        allOccupancyRules,
    }
}

const textKeyClassnameMap: Record<DetectionClass, TextSettingKey> = {
    [DetectionClass.Person]: 'personDetectedText',
    [DetectionClass.Face]: 'familiarDetectedText',
    [DetectionClass.Plate]: 'plateDetectedText',
    [DetectionClass.Vehicle]: 'vehicleDetectedText',
    [DetectionClass.Animal]: 'animalDetectedText',
    [DetectionClass.Motion]: 'motionDetectedText',
    [DetectionClass.Package]: 'motionDetectedText',
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

export const firstUpperCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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

export const detectionRulesKey = 'detectionRules';

export const getDetectionRuleKeys = (detectionRuleName: string) => {
    const enabledKey = `rule:${detectionRuleName}:enabled`;
    const useNvrDetectionsKey = `rule:${detectionRuleName}:useNvrDetections`;
    const activationKey = `rule:${detectionRuleName}:activation`;
    const textKey = `rule:${detectionRuleName}:text`;
    const detecionClassesKey = `rule:${detectionRuleName}:detecionClasses`;
    const nvrEventsKey = `rule:${detectionRuleName}:nvrEvents`;
    const scoreThresholdKey = `rule:${detectionRuleName}:scoreThreshold`;
    const whitelistedZonesKey = `rule:${detectionRuleName}:whitelistedZones`;
    const blacklistedZonesKey = `rule:${detectionRuleName}:blacklistedZones`;
    const enabledSensorsKey = `rule:${detectionRuleName}:enabledSensors`;
    const disabledSensorsKey = `rule:${detectionRuleName}:disabledSensors`;
    const devicesKey = `rule:${detectionRuleName}:devices`;
    const notifiersKey = `rule:${detectionRuleName}:notifiers`;
    const dayKey = `rule:${detectionRuleName}:day`;
    const startTimeKey = `rule:${detectionRuleName}:startTime`;
    const endTimeKey = `rule:${detectionRuleName}:endTime`;
    const actionsKey = `rule:${detectionRuleName}:haActions`;
    const priorityKey = `rule:${detectionRuleName}:priority`;
    const securitySystemModesKey = `rule:${detectionRuleName}:securitySystemModes`;

    return {
        enabledKey,
        useNvrDetectionsKey,
        activationKey,
        textKey,
        detecionClassesKey,
        nvrEventsKey,
        scoreThresholdKey,
        whitelistedZonesKey,
        blacklistedZonesKey,
        enabledSensorsKey,
        disabledSensorsKey,
        devicesKey,
        notifiersKey,
        dayKey,
        startTimeKey,
        endTimeKey,
        priorityKey,
        actionsKey,
        securitySystemModesKey,
    }
}

export const occupancyRulesKey = 'occupancyRules';

export const getOccupancyRuleKeys = (detectionRuleName: string) => {
    const enabledKey = `occupancyRule:${detectionRuleName}:enabled`;
    const objectDetectorKey = `occupancyRule:${detectionRuleName}:objectDetector`;
    const captureZoneKey = `occupancyRule:${detectionRuleName}:captureZone`;
    const detecionClassKey = `occupancyRule:${detectionRuleName}:detecionClassKey`;
    const scoreThresholdKey = `occupancyRule:${detectionRuleName}:scoreThreshold`;
    const zoneKey = `occupancyRule:${detectionRuleName}:zone`;
    const zoneMatchTypeKey = `occupancyRule:${detectionRuleName}:zoneMatchType`;
    const zoneOccupiedTextKey = `occupancyRule:${detectionRuleName}:zoneOccupiedText`;
    const zoneNotOccupiedTextKey = `occupancyRule:${detectionRuleName}:zoneNotOccupiedText`;
    const notifiersKey = `occupancyRule:${detectionRuleName}:notifiers`;
    const changeStateConfirmKey = `occupancyRule:${detectionRuleName}:changeStateConfirm`;
    const actionsKey = `occupancyRule:${detectionRuleName}:haActions`;
    const priorityKey = `occupancyRule:${detectionRuleName}:priority`;
    const maxObjectsKey = `occupancyRule:${detectionRuleName}:maxObjects`;
    const forceUpdateKey = `occupancyRule:${detectionRuleName}:forceUpdate`;

    return {
        enabledKey,
        objectDetectorKey,
        detecionClassKey,
        scoreThresholdKey,
        zoneKey,
        zoneOccupiedTextKey,
        zoneNotOccupiedTextKey,
        notifiersKey,
        zoneMatchTypeKey,
        changeStateConfirmKey,
        actionsKey,
        priorityKey,
        maxObjectsKey,
        forceUpdateKey,
        captureZoneKey,
    }
}

export enum ZoneMatchType {
    Intersect = 'Intersect',
    Contain = 'Contain',
}

export const deviceFilter = `(interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && (type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}' || type === '${ScryptedDeviceType.Sensor}' || type === '${ScryptedDeviceType.Lock}'))`;
export const notifierFilter = `(type === '${ScryptedDeviceType.Notifier}' && interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}'))`;

export const getDetectionRulesSettings = async (props: {
    groupName: string,
    storage: StorageSettings<any>,
    zones?: string[],
    withDevices?: boolean;
    withDetection?: boolean;
    withNvrEvents?: boolean;
}) => {
    const { storage, zones, groupName, withDevices, withDetection, withNvrEvents } = props;
    const settings: Setting[] = [];

    const currentDetectionRules = storage.getItem(detectionRulesKey) ?? [];
    for (const detectionRuleName of currentDetectionRules) {
        const {
            enabledKey,
            useNvrDetectionsKey,
            activationKey,
            textKey,
            notifiersKey,
            detecionClassesKey,
            nvrEventsKey,
            scoreThresholdKey,
            whitelistedZonesKey,
            blacklistedZonesKey,
            devicesKey,
            dayKey,
            endTimeKey,
            startTimeKey,
            enabledSensorsKey,
            disabledSensorsKey,
            priorityKey,
            actionsKey,
            securitySystemModesKey,
        } = getDetectionRuleKeys(detectionRuleName);

        const currentActivation = storage.getItem(activationKey as any) as DetectionRuleActivation;
        const useNvrDetections = storage.getItem(useNvrDetectionsKey as any) as boolean ?? false;

        settings.push(
            {
                key: enabledKey,
                title: 'Enabled',
                type: 'boolean',
                group: groupName,
                subgroup: detectionRuleName,
                value: storage.getItem(enabledKey as any) as boolean ?? true,
                immediate: true,
            },
            {
                key: useNvrDetectionsKey,
                title: 'Use NVR detections',
                type: 'boolean',
                group: groupName,
                subgroup: detectionRuleName,
                value: useNvrDetections,
                immediate: true
            },
            {
                key: activationKey,
                title: 'Activation',
                group: groupName,
                subgroup: detectionRuleName,
                choices: [
                    DetectionRuleActivation.Always,
                    DetectionRuleActivation.OnActive,
                    DetectionRuleActivation.Schedule,
                    DetectionRuleActivation.AlarmSystem,
                ],
                value: currentActivation,
                immediate: true,
                combobox: true
            },
            {
                key: textKey,
                title: 'Custom text',
                description: 'Available arguments ${room} $[time} ${nvrLink} ${zone} ${class} ${label}',
                group: groupName,
                subgroup: detectionRuleName,
                value: storage.getItem(textKey),
                type: 'string',
            },
            {
                key: detecionClassesKey,
                title: 'Detection classes',
                group: groupName,
                subgroup: detectionRuleName,
                multiple: true,
                combobox: true,
                choices: defaultDetectionClasses,
                value: JSON.parse(storage.getItem(detecionClassesKey as any) as string ?? '[]')
            }
        );

        if (currentActivation === DetectionRuleActivation.AlarmSystem) {
            settings.push({
                key: securitySystemModesKey,
                title: 'Alarm modes',
                description: 'Modes of the selected security system to trigger this rule',
                group: groupName,
                subgroup: detectionRuleName,
                multiple: true,
                combobox: true,
                type: 'string',
                choices: [
                    SecuritySystemMode.Disarmed,
                    SecuritySystemMode.HomeArmed,
                    SecuritySystemMode.NightArmed,
                    SecuritySystemMode.AwayArmed,
                ],
                value: JSON.parse(storage.getItem(securitySystemModesKey as any) as string ?? '[]'),
            })
        }

        if (useNvrDetections && withNvrEvents) {
            settings.push(
                {
                    key: nvrEventsKey,
                    title: 'NVR events',
                    group: groupName,
                    subgroup: detectionRuleName,
                    multiple: true,
                    combobox: true,
                    choices: Object.values(NvrEvent),
                    value: JSON.parse(storage.getItem(nvrEventsKey as any) as string ?? '[]')
                }
            );
        }

        if (withDetection) {
            settings.push(
                {
                    key: scoreThresholdKey,
                    title: 'Score threshold',
                    group: groupName,
                    subgroup: detectionRuleName,
                    type: 'number',
                    placeholder: '0.7',
                    value: storage.getItem(scoreThresholdKey as any) as string
                }
            );
        }

        settings.push(
            {
                key: notifiersKey,
                title: 'Notifiers',
                group: groupName,
                subgroup: detectionRuleName,
                type: 'device',
                multiple: true,
                combobox: true,
                deviceFilter: notifierFilter,
                value: JSON.parse(storage.getItem(notifiersKey as any) as string ?? '[]')
            });

        if (zones) {
            settings.push(
                {
                    key: whitelistedZonesKey,
                    title: 'Whitelisted zones',
                    group: groupName,
                    subgroup: detectionRuleName,
                    multiple: true,
                    combobox: true,
                    choices: zones,
                    value: JSON.parse(storage.getItem(whitelistedZonesKey as any) as string ?? '[]'),
                    readonly: !zones.length
                },
                {
                    key: blacklistedZonesKey,
                    title: 'Blacklisted zones',
                    group: groupName,
                    subgroup: detectionRuleName,
                    multiple: true,
                    combobox: true,
                    choices: zones,
                    value: JSON.parse(storage.getItem(blacklistedZonesKey as any) as string ?? '[]'),
                    readonly: !zones.length
                },
            )
        }
        settings.push(
            {
                key: enabledSensorsKey,
                title: 'Open sensors',
                description: 'Sensors that must be enabled to trigger this rule',
                group: groupName,
                subgroup: detectionRuleName,
                multiple: true,
                combobox: true,
                type: 'device',
                deviceFilter: `(type === '${ScryptedDeviceType.Sensor}')`,
                value: JSON.parse(storage.getItem(enabledSensorsKey as any) as string ?? '[]'),
            },
            {
                key: disabledSensorsKey,
                title: 'Closed sensors',
                description: 'Sensors that must be disabled to trigger this rule',
                group: groupName,
                subgroup: detectionRuleName,
                multiple: true,
                combobox: true,
                type: 'device',
                deviceFilter: `(type === '${ScryptedDeviceType.Sensor}')`,
                value: JSON.parse(storage.getItem(disabledSensorsKey as any) as string ?? '[]'),
            },
            {
                key: priorityKey,
                type: 'string',
                title: 'Pushover priority',
                group: groupName,
                subgroup: detectionRuleName,
                choices: [NotificationPriority.VeryLow, NotificationPriority.Low, NotificationPriority.Normal, NotificationPriority.High],
                value: storage.getItem(priorityKey as any) as DetectionRuleActivation ?? NotificationPriority.Normal,
                immediate: true,
                combobox: true
            },
            {
                key: actionsKey,
                title: 'Homeassistant Actions',
                description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
                type: 'string',
                multiple: true,
                group: groupName,
                subgroup: detectionRuleName,
                value: JSON.parse(storage.getItem(actionsKey as any) as string ?? '[]'),
            },
        );

        if (withDevices && currentActivation !== DetectionRuleActivation.OnActive) {
            settings.push({
                key: devicesKey,
                title: 'Devices',
                description: 'Leave empty to affect all devices',
                group: groupName,
                subgroup: detectionRuleName,
                type: 'device',
                multiple: true,
                combobox: true,
                value: JSON.parse(storage.getItem(devicesKey) as string ?? '[]'),
                deviceFilter
            });
        }

        if (currentActivation === DetectionRuleActivation.Schedule) {
            settings.push({
                key: dayKey,
                title: 'Day',
                description: 'Leave empty to affect all days',
                group: groupName,
                subgroup: detectionRuleName,
                type: 'day',
                multiple: true,
                value: JSON.parse(storage.getItem(dayKey as any) as string ?? '[]'),
            });
            settings.push({
                key: startTimeKey,
                title: 'Start time',
                group: groupName,
                subgroup: detectionRuleName,
                type: 'time',
                multiple: true,
                value: storage.getItem(startTimeKey),
            });
            settings.push({
                key: endTimeKey,
                title: 'End time',
                group: groupName,
                subgroup: detectionRuleName,
                type: 'time',
                multiple: true,
                value: storage.getItem(endTimeKey),
            });
        }
    };

    return settings;
}

export const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;

export const getOccupancyRulesSettings = async (props: {
    groupName: string,
    storage: StorageSettings<any>,
    zones?: string[],
    isNvrEnabled: boolean
}) => {
    const { storage, zones, groupName } = props;
    const settings: Setting[] = [];

    const currentOccupancyRules = storage.getItem(occupancyRulesKey) ?? [];
    for (const occupancyRuleName of currentOccupancyRules) {
        const {
            enabledKey,
            objectDetectorKey,
            captureZoneKey,
            scoreThresholdKey,
            zoneKey,
            detecionClassKey,
            notifiersKey,
            zoneNotOccupiedTextKey,
            zoneOccupiedTextKey,
            zoneMatchTypeKey,
            changeStateConfirmKey,
            actionsKey,
            priorityKey,
            maxObjectsKey,
            forceUpdateKey,
        } = getOccupancyRuleKeys(occupancyRuleName);

        settings.push(
            {
                key: enabledKey,
                title: 'Enabled',
                type: 'boolean',
                group: groupName,
                subgroup: occupancyRuleName,
                value: storage.getItem(enabledKey as any) as boolean ?? true,
                immediate: true,
            },
            ...[],
            {
                key: detecionClassKey,
                title: 'Detection class',
                group: groupName,
                subgroup: occupancyRuleName,
                choices: defaultDetectionClasses,
                value: storage.getItem(detecionClassKey),
            },
            {
                key: zoneKey,
                title: 'Observe zone',
                group: groupName,
                subgroup: occupancyRuleName,
                choices: zones,
                value: storage.getItem(zoneKey),
                readonly: !zones.length
            },
            {
                key: captureZoneKey,
                title: 'Capture zone',
                group: groupName,
                subgroup: occupancyRuleName,
                value: storage.getItem(captureZoneKey),
                type: 'clippath'
            },
            {
                key: zoneMatchTypeKey,
                title: 'Zone type',
                group: groupName,
                subgroup: occupancyRuleName,
                choices: Object.values(ZoneMatchType),
                value: storage.getItem(zoneMatchTypeKey) ?? ZoneMatchType.Intersect,
            },
            {
                key: scoreThresholdKey,
                title: 'Score threshold',
                group: groupName,
                subgroup: occupancyRuleName,
                type: 'number',
                placeholder: '0.5',
                value: storage.getItem(scoreThresholdKey as any) as string
            },
            {
                key: changeStateConfirmKey,
                title: 'Occupancy confirmation',
                description: 'Seconds to wait until an occupancy state change gets confirmed',
                group: groupName,
                subgroup: occupancyRuleName,
                type: 'number',
                placeholder: '30',
                value: storage.getItem(changeStateConfirmKey as any) as number
            },
            {
                key: forceUpdateKey,
                title: 'Force update in seconds',
                description: 'Seconds to wait until a force update should happen',
                group: groupName,
                subgroup: occupancyRuleName,
                type: 'number',
                placeholder: '30',
                value: storage.getItem(forceUpdateKey as any) as number
            },
            {
                key: maxObjectsKey,
                title: 'Max objects',
                description: 'Amount of objects that can fit the zone (if set to 2 and only 1 is detected, zone will be considered free)',
                group: groupName,
                subgroup: occupancyRuleName,
                type: 'number',
                placeholder: '1',
                value: storage.getItem(maxObjectsKey as any) as number
            },
            {
                key: zoneOccupiedTextKey,
                title: 'Zone occupied text',
                description: 'Text to use for the notification when the rule gets activated (zone occupied). Available arguments ${detectedObjects} ${maxObjects}',
                group: groupName,
                subgroup: occupancyRuleName,
                value: storage.getItem(zoneOccupiedTextKey),
                type: 'string',
            },
            {
                key: zoneNotOccupiedTextKey,
                title: 'Zone not occupied text',
                description: 'Text to use for the notification when the rule gets deactivated (zone not occupied). Available arguments ${detectedObjects} ${maxObjects}',
                group: groupName,
                subgroup: occupancyRuleName,
                value: storage.getItem(zoneNotOccupiedTextKey),
                type: 'string',
            },
            {
                key: notifiersKey,
                title: 'Notifiers',
                group: groupName,
                subgroup: occupancyRuleName,
                type: 'device',
                multiple: true,
                combobox: true,
                deviceFilter: notifierFilter,
                value: JSON.parse(storage.getItem(notifiersKey as any) as string ?? '[]')
            },
            {
                key: priorityKey,
                type: 'string',
                title: 'Pushover priority',
                group: groupName,
                subgroup: occupancyRuleName,
                choices: [NotificationPriority.VeryLow, NotificationPriority.Low, NotificationPriority.Normal, NotificationPriority.High],
                value: storage.getItem(priorityKey as any) as DetectionRuleActivation ?? NotificationPriority.Normal,
                immediate: true,
                combobox: true
            },
            {
                key: actionsKey,
                title: 'Homeassistant Actions',
                description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
                type: 'string',
                multiple: true,
                group: groupName,
                subgroup: occupancyRuleName,
                value: JSON.parse(storage.getItem(actionsKey as any) as string ?? '[]'),
            },
            {
                key: objectDetectorKey,
                title: 'Object Detector',
                description: 'Select the object detection plugin to use for detecting objects. (overrides the configuration in plugin)',
                type: 'device',
                group: groupName,
                subgroup: occupancyRuleName,
                deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}'`,
                immediate: true,
            },
        );
    };

    return settings;
}

export enum DetectionRuleSource {
    Plugin = 'Plugin',
    Device = 'Device',
}

export interface Action {
    aciton: string;
    title: string;
    icon: string;
}

export interface DetectionRule {
    name: string
    activationType: DetectionRuleActivation;
    notifiers: string[];
    devices: string[];
    detectionClasses?: DetectionClass[];
    nvrEvents?: NvrEvent[];
    scoreThreshold?: number;
    whitelistedZones?: string[];
    blacklistedZones?: string[];
    source: DetectionRuleSource;
    deviceId?: string;
    customText?: string;
    priority: NotificationPriority;
    actions?: string[];
}

export const getDeviceRules = (
    props: {
        deviceStorage?: Record<string, StorageSetting>,
        mainPluginStorage: Record<string, StorageSetting>,
        deviceId?: string,
        deviceType?: ScryptedDeviceType
    }
) => {
    const { deviceId, deviceStorage, mainPluginStorage, deviceType } = props;
    const detectionRules: DetectionRule[] = [];
    const nvrRules: DetectionRule[] = [];
    const skippedRules: DetectionRule[] = [];
    const allPluginRules: DetectionRule[] = [];
    const allDeviceRules: DetectionRule[] = [];

    const allDeviceIds = getElegibleDevices().map(device => device.id);
    const activeNotifiers = mainPluginStorage['notifiers']?.value as string[] ?? [];
    const onActiveDevices = mainPluginStorage['activeDevicesForNotifications']?.value as string[] ?? [];

    const processRules = (storage: Record<string, StorageSetting>, source: DetectionRuleSource) => {
        const detectionRuleNames = storage[detectionRulesKey]?.value as string[] ??
            storage[`homeassistantMetadata:${detectionRulesKey}`]?.value as string[] ??
            [];
        for (const detectionRuleName of detectionRuleNames) {
            const {
                enabledKey,
                useNvrDetectionsKey,
                activationKey,
                notifiersKey,
                detecionClassesKey,
                scoreThresholdKey,
                whitelistedZonesKey,
                blacklistedZonesKey,
                devicesKey,
                dayKey,
                endTimeKey,
                startTimeKey,
                textKey,
                enabledSensorsKey,
                disabledSensorsKey,
                priorityKey,
                actionsKey,
                nvrEventsKey,
                securitySystemModesKey
            } = getDetectionRuleKeys(detectionRuleName);

            const isEnabled = JSON.parse(storage[enabledKey]?.value as string ?? 'false');
            const useNvrDetections = JSON.parse(storage[useNvrDetectionsKey]?.value as string ?? 'false');

            const notifiers = storage[notifiersKey]?.value as string[] ?? [];
            const notifiersTouse = notifiers.filter(notifierId => activeNotifiers.includes(notifierId));

            const activationType = storage[activationKey]?.value as DetectionRuleActivation;
            const priority = storage[priorityKey]?.value as NotificationPriority;
            const actions = storage[actionsKey]?.value as string[];
            const customText = storage[textKey]?.value as string || undefined;
            const mainDevices = storage[devicesKey]?.value as string[] ?? [];
            const securitySystemModes = storage[securitySystemModesKey]?.value as SecuritySystemMode[] ?? [];
            const devices = source === DetectionRuleSource.Device ? [deviceId] : mainDevices.length ? mainDevices : allDeviceIds;
            const devicesToUse = activationType === DetectionRuleActivation.OnActive ? onActiveDevices : devices;

            const detectionClasses = storage[detecionClassesKey]?.value as DetectionClass[] ?? [];
            const nvrEvents = storage[nvrEventsKey]?.value as NvrEvent[] ?? [];
            const scoreThreshold = Number(storage[scoreThresholdKey]?.value || 0.7);

            const detectionRule: DetectionRule = {
                source,
                name: detectionRuleName,
                activationType,
                notifiers: notifiersTouse,
                scoreThreshold,
                detectionClasses,
                nvrEvents,
                devices: devicesToUse,
                customText,
                priority,
                actions,
                deviceId
            };

            if (source === DetectionRuleSource.Device) {
                const whitelistedZones = storage[whitelistedZonesKey]?.value as string[] ?? [];
                const blacklistedZones = storage[blacklistedZonesKey]?.value as string[] ?? [];

                detectionRule.whitelistedZones = whitelistedZones;
                detectionRule.blacklistedZones = blacklistedZones;
            }

            let timeAllowed = true;

            if (activationType === DetectionRuleActivation.Schedule) {
                const days = storage[dayKey]?.value as number[] ?? [];
                const startTime = Number(storage[startTimeKey]?.value);
                const endTime = Number(storage[endTimeKey]?.value);

                const currentDate = new Date();
                const currentDay = currentDate.getDay();

                const dayOk = !days.length || days.includes(currentDay);
                if (!dayOk) {
                    timeAllowed = false;
                } else {
                    const parseDate = (time: number, add1Day?: boolean) => {
                        const timeDate = new Date(time);

                        const newTimeDate = new Date();
                        if (add1Day) {
                            newTimeDate.setDate(newTimeDate.getDate() + 1);
                        }
                        newTimeDate.setHours(timeDate.getHours());
                        newTimeDate.setMinutes(timeDate.getMinutes());
                        newTimeDate.setSeconds(0);
                        newTimeDate.setMilliseconds(0);

                        return {
                            newDate: newTimeDate,
                            newTimeDate: newTimeDate.getTime()
                        }
                    }

                    const { newTimeDate: startTimeParsed, newDate: a1 } = parseDate(startTime);
                    const { newTimeDate: endTimeParsed, newDate: a2 } = parseDate(endTime, endTime < startTime);

                    const currentTime = currentDate.getTime();
                    timeAllowed = currentTime > startTimeParsed && currentTime < endTimeParsed;
                }
            }

            let sensorsOk = true;
            const enabledSensors = storage[enabledSensorsKey]?.value as string[] ?? [];
            const disabledSensors = storage[disabledSensorsKey]?.value as string[] ?? [];

            if (!!enabledSensors.length || !!disabledSensors.length) {
                const systemState = sdk.systemManager.getSystemState();
                if (!!enabledSensors.length) {
                    sensorsOk = enabledSensors.every(sensorId => systemState[sensorId]?.binarySensor?.value === true);
                }
                if (!!disabledSensors.length && sensorsOk) {
                    sensorsOk = disabledSensors.every(sensorId => systemState[sensorId]?.binarySensor?.value === false);
                }
            }

            let isSensorEnabled = true;
            if (
                source === DetectionRuleSource.Plugin &&
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

            let isSecuritySystemEnabled = true;
            if (
                activationType === DetectionRuleActivation.AlarmSystem
            ) {
                const securitySystemDeviceId = mainPluginStorage['securitySystem']?.value as string;
                if (securitySystemDeviceId) {
                    const securitySystemDevice = sdk.systemManager.getDeviceById<SecuritySystem>(securitySystemDeviceId);
                    const currentMode = securitySystemDevice.securitySystemState?.mode;
                    isSecuritySystemEnabled = currentMode ? securitySystemModes.includes(currentMode) : false;
                }
            }

            const ruleAllowed =
                isEnabled &&
                !!devicesToUse.length &&
                (deviceId ? devicesToUse.includes(deviceId) : true) &&
                !!notifiersTouse.length &&
                timeAllowed &&
                isSensorEnabled &&
                sensorsOk &&
                isSecuritySystemEnabled;

            if (source === DetectionRuleSource.Plugin) {
                allPluginRules.push(cloneDeep(detectionRule));
            } else if (source === DetectionRuleSource.Device) {
                allDeviceRules.push(cloneDeep(detectionRule));
            }

            if (!ruleAllowed) {
                skippedRules.push(detectionRule);
            } else {
                if (useNvrDetections) {
                    nvrRules.push(detectionRule);
                } else {
                    detectionRules.push(detectionRule);
                }
            }

        }
    };

    processRules(mainPluginStorage, DetectionRuleSource.Plugin);

    if (deviceStorage) {
        processRules(deviceStorage, DetectionRuleSource.Device);
    }

    return { detectionRules, skippedRules, nvrRules, allPluginRules, allDeviceRules };
}

export interface OccupancyRule {
    name: string
    notifiers: string[];
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
    priority: NotificationPriority;
    actions?: string[];
    captureZone?: Point[];
}

export const getDeviceOccupancyRules = (
    props: {
        mainPluginStorage?: Record<string, StorageSetting>,
        deviceStorage?: Record<string, StorageSetting>,
    }
) => {
    const { deviceStorage, mainPluginStorage } = props;
    const allOccupancyRules: OccupancyRule[] = [];
    const occupancyRules: OccupancyRule[] = [];
    const skippedOccupancyRules: OccupancyRule[] = [];

    const activeNotifiers = mainPluginStorage['notifiers']?.value as string[] ?? [];

    const occupancyRuleNames = deviceStorage[occupancyRulesKey]?.value as string[] ??
        deviceStorage[`homeassistantMetadata:${occupancyRulesKey}`]?.value as string[] ??
        [];

    for (const occupancyRuleName of occupancyRuleNames) {
        const {
            detecionClassKey,
            enabledKey,
            notifiersKey,
            zoneKey,
            objectDetectorKey,
            scoreThresholdKey,
            zoneNotOccupiedTextKey,
            zoneOccupiedTextKey,
            zoneMatchTypeKey,
            changeStateConfirmKey,
            actionsKey,
            priorityKey,
            maxObjectsKey,
            forceUpdateKey,
            captureZoneKey,
        } = getOccupancyRuleKeys(occupancyRuleName);

        const isEnabled = JSON.parse(deviceStorage[enabledKey]?.value as string ?? 'false');

        const notifiers = deviceStorage[notifiersKey]?.value as string[] ?? [];
        const notifiersTouse = notifiers.filter(notifierId => activeNotifiers.includes(notifierId));

        const zoneOccupiedText = deviceStorage[zoneOccupiedTextKey]?.value as string || undefined;
        const zoneNotOccupiedText = deviceStorage[zoneNotOccupiedTextKey]?.value as string || undefined;
        const objectDetector = deviceStorage[objectDetectorKey]?.value as string;
        const detectionClass = deviceStorage[detecionClassKey]?.value as DetectionClass;
        const scoreThreshold = Number(deviceStorage[scoreThresholdKey]?.value || 0.5);
        const changeStateConfirm = Number(deviceStorage[changeStateConfirmKey]?.value || 30) || 30;
        const forceUpdate = Number(deviceStorage[forceUpdateKey]?.value || 30) || 30;
        const maxObjects = Number(deviceStorage[maxObjectsKey]?.value || 1);
        const observeZone = deviceStorage[zoneKey]?.value as string;
        const zoneMatchType = deviceStorage[zoneMatchTypeKey]?.value as ZoneMatchType ?? ZoneMatchType.Intersect;
        const priority = deviceStorage[priorityKey]?.value as NotificationPriority;
        const actions = deviceStorage[actionsKey]?.value as string[];
        const captureZone = JSON.parse(deviceStorage[captureZoneKey]?.value as string ?? '[]') as Point[];

        const occupancyRule: OccupancyRule = {
            name: occupancyRuleName,
            notifiers: notifiersTouse,
            objectDetector,
            zoneNotOccupiedText,
            zoneOccupiedText,
            detectionClass,
            observeZone,
            scoreThreshold,
            changeStateConfirm,
            forceUpdate,
            zoneType: zoneMatchType,
            priority,
            actions,
            maxObjects,
            captureZone
        };

        const ruleAllowed = isEnabled && !!detectionClass && !!observeZone;

        allOccupancyRules.push(occupancyRule);
        if (!ruleAllowed) {
            skippedOccupancyRules.push(occupancyRule);
        } else {
            occupancyRules.push(occupancyRule);
        }

    }

    return { occupancyRules, skippedOccupancyRules, allOccupancyRules };
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
                    channels: 4,
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

        const b64Image = newImageBuffer.toString('base64');
        const newImage = await sdk.mediaManager.createMediaObject(imageBuffer, ScryptedMimeTypes.Image);
        console.log(`Bounding box added ${boundingBox}: ${b64Image}`);

        return { newImageBuffer, newImage, b64Image };
    } catch (e) {
        console.log('Error adding bounding box', e);
        return {}
    }
}

export const getPushoverPriority = (priority: NotificationPriority) => priority === NotificationPriority.High ? 1 :
    priority === NotificationPriority.Normal ? 0 :
        priority === NotificationPriority.Low ? -1 :
            -2;

export const normalizeBoxToClipPath = (boundingBox: [number, number, number, number], inputDimensions: [number, number]): [Point, Point, Point, Point] => {
    let [x, y, width, height] = boundingBox;
    let x2 = x + width;
    let y2 = y + height;
    // the zones are point paths in percentage format
    x = x / inputDimensions[0];
    y = y / inputDimensions[1];
    x2 = x2 / inputDimensions[0];
    y2 = y2 / inputDimensions[1];
    return [[x, y], [x2, y], [x2, y2], [x, y2]];
}