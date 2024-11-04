import sdk, { Camera, MediaObject, NotifierOptions, ObjectDetectionResult, ScryptedDeviceBase, ScryptedDeviceType, Setting, Settings } from "@scrypted/sdk"
import { StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { keyBy, sortBy, uniq, uniqBy } from "lodash";
const { endpointManager } = sdk;
import { scrypted } from '../package.json';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isLabelDetection } from "./detecionClasses";

export type DeviceInterface = Camera & ScryptedDeviceBase & Settings;

export enum EventType {
    ObjectDetection = 'ObjectDetection',
    Doorbell = 'Doorbell',
    Contact = 'Contact',
    Offline = 'Offline',
    Online = 'Online',
}

export const getDefaultEntityId = (name: string) => {
    const convertedName = name?.replace(/\W+/g, " ")
        .split(/ |\B(?=[A-Z])/)
        .map(word => word.toLowerCase())
        .join('_') ?? 'not_set';

    return `binary_sensor.${convertedName}_triggered`;
}

export const getWebookSpecs = async () => {
    const lastSnapshot = 'last';

    return {
        lastSnapshot,
    }
}

export const getWebookUrls = async (cameraDevice: string, console: Console) => {
    let lastSnapshotCloudUrl: string;
    let lastSnapshotLocalUrl: string;

    const { lastSnapshot } = await getWebookSpecs();

    try {
        const cloudEndpoint = await endpointManager.getPublicCloudEndpoint();
        const localEndpoint = await endpointManager.getPublicLocalEndpoint();

        lastSnapshotCloudUrl = `${cloudEndpoint}snapshots/${cameraDevice}/${lastSnapshot}`;
        lastSnapshotLocalUrl = `${localEndpoint}snapshots/${cameraDevice}/${lastSnapshot}`;
    } catch (e) {
        console.log('Error fetching webhookUrls', e);
    }

    return {
        lastSnapshotCloudUrl,
        lastSnapshotLocalUrl,
    }
}

export const parseNotificationMessage = async (cameraDevice: DeviceInterface, deviceSensors: string[], options?: NotifierOptions, console?: Console) => {
    try {
        let triggerDevice: DeviceInterface;
        let textKey: TextSettingKey;
        let detection: ObjectDetectionResult;
        const subtitle = options?.subtitle;

        let eventType: EventType;
        const allDetections: ObjectDetectionResult[] = options?.recordedEvent?.data?.detections ?? [];

        if (subtitle === 'Offline') {
            textKey = 'offlineText';
            eventType = EventType.Offline;
        } else if (subtitle === 'Online') {
            textKey = 'onlineText';
            eventType = EventType.Online;
        } else {

            if (subtitle.includes('Maybe: Vehicle')) {
                textKey = 'plateDetectedText';
                detection = allDetections.find(det => det.className === 'plate');
                eventType = EventType.ObjectDetection;
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
            } else if (subtitle.includes('Motion')) {
                textKey = 'motionDetectedText';
                detection = allDetections.find(det => det.className === 'motion');
                eventType = EventType.ObjectDetection;
            } else if (subtitle.includes('Door/Window Open')) {
                textKey = 'doorWindowText';
                eventType = EventType.Contact;
            } else if (subtitle.includes('Doorbell Ringing')) {
                textKey = 'doorbellText';
                eventType = EventType.Doorbell;
            }
        }

        if ([EventType.Contact, EventType.Doorbell].includes(eventType)) {
            const systemState = sdk.systemManager.getSystemState();

            const activeSensors = deviceSensors.filter(sensorId => !systemState[sensorId].value);
            if (activeSensors.length === 1) {
                triggerDevice = sdk.systemManager.getDeviceById(activeSensors[0]) as unknown as DeviceInterface
            } else {
                console.log(`Trigger sensor not found: ${JSON.stringify({ activeSensors, deviceSensors })}`);
            }
        }


        if (detection) {
            const allZones = uniq(allDetections.filter(innerDetection => innerDetection.className === detection.className)
                .flatMap(det => det.zones));
            detection.zones = allZones;
        }

        return {
            triggerDevice,
            cameraDevice,
            textKey,
            detection,
            allDetections,
            eventType,
            classname: detection ? detectionClassesDefaultMap[detection.className] : undefined
        }
    } catch (e) {
        console.log(`Error parsing notification: ${JSON.stringify({ device: cameraDevice.name, options })}`, e);
        return {};
    }
}

export enum NotificationSource {
    NVR = 'NVR',
    TEST = 'TEST',
    DETECTION = 'DETECTION'
}

export interface NotifyCameraProps {
    cameraDevice?: DeviceInterface,
    triggerDevice: DeviceInterface,
    notifierId: string,
    time: number,
    image?: MediaObject,
    detection?: ObjectDetectionResult
    textKey: string,
    source?: NotificationSource,
    keepImage?: boolean,
    notifierSettings: Setting[],
    logger: Console,
}

export interface GetNotificationTextProps {
    device: DeviceInterface,
    detectionTime: number,
    detection?: ObjectDetectionResult,
    notifierId: string,
    externalUrl: string,
    textKey: string,
    notifierSettings: Setting[],
}

export interface ExecuteReportProps {
    currentTime: number,
    deviceName: string,
    detections: ObjectDetectionResult[],
    device: DeviceInterface
    b64Image?: string,
    logger: Console
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

export const filterAndSortValidDetections = (detections: ObjectDetectionResult[], logger: Console) => {
    const sortedByPriorityAndScore = sortBy(detections,
        (detection) => [detection?.className ? classnamePrio[detection.className] : 100,
        1 - (detection.score ?? 0)]
    );
    const uniqueByClassName = uniqBy(sortedByPriorityAndScore, det => det.className);
    const filteredByValidity = uniqueByClassName.filter(det => {
        const { className, label, movement } = det;
        if (isLabelDetection(className) && !label) {
            logger.debug(`Label ${label} not valid`);
            return false;
        } else if (movement && !movement.moving) {
            logger.debug(`Movement data ${movement} not valid`);
            return false;
        }

        return true;
    });

    return filteredByValidity;
}

export const getIsDetectionValid = async (device: DeviceInterface, notifier: DeviceInterface, console?: Console) => {
    const deviceSettings = await device.getSettings();
    const notifierSettings = await notifier?.getSettings();

    const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value ?? []) as string[];
    const whitelistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:whitelistedZones')?.value ?? []) as string[];
    const blacklistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:blacklistedZones')?.value ?? []) as string[];
    const scoreThreshold = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:scoreThreshold')?.value as number) || 0.7;
    const alwaysZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value ?? []) as string[];
    const notifierAlwaysClassnames = (notifierSettings?.find(setting => setting.key === 'homeassistantNotifierMetadata:alwaysClassnames')?.value ?? []) as string[];

    return (detection: ObjectDetectionResult) => {
        if (!detection) {
            return {};
        }
        const { className, label, zones = [], score } = detection;

        const scoreToUse = deviceSettings.find(setting => setting.key === `homeassistantMetadata:${detection.className}:scoreThreshold`)?.value as number
            || scoreThreshold;


        const isAlwaysIncluded = alwaysZones.length ? zones.some(zone => alwaysZones.includes(zone)) : false;
        const isIncluded = whitelistedZones.length ? zones.some(zone => whitelistedZones.includes(zone)) : true;
        const isExcluded = blacklistedZones.length ? zones.some(zone => blacklistedZones.includes(zone)) : false;

        const zonesOk = isAlwaysIncluded || (isIncluded && !isExcluded);
        const faceOk = className === 'face' ? !!label : true;
        const motionOk = detectionClasses.length === 1 && detectionClasses[0] === 'motion' ? className === 'motion' : true;
        const scoreOk = score >= scoreToUse;
        const classNameOk = detectionClasses.includes(className);

        let isValid = false;
        if (notifierAlwaysClassnames?.length && notifierAlwaysClassnames.includes(className)) {
            isValid = faceOk && scoreOk && classNameOk;
        } else {
            isValid = zonesOk && faceOk && motionOk && scoreOk && classNameOk;
        }

        const data: any = {
            detectionClasses,
            className,
            classNameOk,
            notifierAlwaysClassnames,

            label,
            faceOk,
            motionOk,

            zones,
            whitelistedZones,
            blacklistedZones,
            alwaysZones,
            isAlwaysIncluded,
            isIncluded,
            isExcluded,
            zonesOk,

            score,
            scoreOk,
        }

        if (isValid && console) {
            console.log(`Valid detection found: ${JSON.stringify(data)}`)
        }

        return { isValid, data };
    }
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
    | 'onlineText'
    | 'offlineText';

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
            description: 'Expression used to render the text when a device comes back onlin. Available arguments $[time}',
            defaultValue: !forMixin ? 'Back online at ${time}' : undefined,
            placeholder: !forMixin ? 'Back online at ${time}' : undefined
        },
        offlineText: {
            [groupKey]: 'Texts',
            title: 'Online device text',
            type: 'string',
            description: 'Expression used to render the text when a device goes onlin. Available arguments $[time}',
            defaultValue: !forMixin ? 'Went offline at ${time}' : undefined,
            placeholder: !forMixin ? 'Went offline at ${time}' : undefined
        }
    }

    return settings;
}

export type MixinBaseSettingKey =
    | 'debug'
    | 'room'
    | 'entityId'
    | 'haDeviceClass'
    | 'useNvrDetections'
    | 'useNvrImages'
    | 'triggerAlwaysNotification'
    | 'haActions'
    | 'disabledNotifiers'

export const getMixinBaseSettings = (name: string, type: ScryptedDeviceType) => {
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
        triggerAlwaysNotification: {
            title: 'Always enabled',
            description: 'Enable to always check this entity for notifications, regardles of it\'s activation',
            subgroup: 'Notifier',
            type: 'boolean',
            defaultValue: false,
        },
        haActions: {
            title: 'HA actions',
            description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
            subgroup: 'Notifier',
            type: 'string',
            multiple: true
        },
        disabledNotifiers: {
            subgroup: 'Notifier',
            title: 'Disabled notifiers',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: `(type === '${ScryptedDeviceType.Notifier}')`,
        },
    };

    return settings;
}

export const mainPluginName = scrypted.name;

export const isDeviceEnabled = async (deviceName: string) => {
    const mainPluginDevice = sdk.systemManager.getDeviceByName(mainPluginName) as unknown as Settings;
    const mainSettings = await mainPluginDevice.getSettings();
    const mainSettingsDic = keyBy(mainSettings, 'key');

    const isPluginEnabled = mainSettingsDic.pluginEnabled.value as boolean;
    const isMqttActive = mainSettingsDic.mqttEnabled.value as boolean;
    const isActiveForNotifications = (mainSettingsDic.activeDevicesForNotifications?.value as string || []).includes(deviceName);
    const isActiveForMqttReporting = isMqttActive && (mainSettingsDic.activeDevicesForReporting?.value as string || []).includes(deviceName);

    return {
        isPluginEnabled,
        isActiveForNotifications,
        isActiveForMqttReporting,
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
}

export const getDetectionRuleKeys = (detectionRuleName: string) => {
    const enabledKey = `rule:${detectionRuleName}:enabled`;
    const activationKey = `rule:${detectionRuleName}:activation`;
    const detecionClassesKey = `rule:${detectionRuleName}:detecionClasses`;
    const scoreThresholdKey = `rule:${detectionRuleName}:scoreThreshold`;
    const zonesKey = `rule:${detectionRuleName}:zones`;
    const devicesKey = `rule:${detectionRuleName}:devices`;
    const notifiersKey = `rule:${detectionRuleName}:notifiers`;

    return {
        enabledKey,
        activationKey,
        detecionClassesKey,
        scoreThresholdKey,
        zonesKey,
        devicesKey,
        notifiersKey,
    }
}