import sdk, { Camera, MediaObject, NotifierOptions, ObjectDetectionResult, ScryptedDeviceBase, ScryptedDeviceType, Setting, Settings } from "@scrypted/sdk"
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { keyBy, sortBy, uniq, uniqBy } from "lodash";
const { endpointManager } = sdk;
import { scrypted, name } from '../package.json';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isLabelDetection } from "./detecionClasses";

export type DeviceInterface = Camera & ScryptedDeviceBase & Settings;
export const ADVANCED_NOTIFIER_INTERFACE = name;
export const snapshotWidth = 1280;
export const snapshotHeight = 720;

export const getElegibleDevices = () => {
    const pluginDevice = sdk.systemManager.getDeviceByName(scrypted.name);

    const notifiers: DeviceInterface[] = [];
    const devices: DeviceInterface[] = [];

    Object.entries(sdk.systemManager.getSystemState()).filter(([deviceId]) => {
        const { mixins, type } = sdk.systemManager.getDeviceById(deviceId) as unknown as (DeviceInterface);

        return mixins?.includes(pluginDevice.id);
    }).map(([deviceId]) => sdk.systemManager.getDeviceById(deviceId) as unknown as (DeviceInterface))
        .forEach(device => {
            if (device.type == ScryptedDeviceType.Notifier) {
                notifiers.push(device);
            } else {
                devices.push(device);
            }
        });

    return { notifiers, devices };
}

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
            placeholder: !forMixin ? 'Back online at ${time}' : undefined,
            hide: true
        },
        offlineText: {
            [groupKey]: 'Texts',
            title: 'Online device text',
            type: 'string',
            description: 'Expression used to render the text when a device goes onlin. Available arguments $[time}',
            defaultValue: !forMixin ? 'Went offline at ${time}' : undefined,
            placeholder: !forMixin ? 'Went offline at ${time}' : undefined,
            hide: true
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

export type MixinBaseSettingKey =
    | 'debug'
    | 'room'
    | 'entityId'
    | 'haDeviceClass'
    | 'useNvrDetections'
    | 'useNvrImages'
    | 'haActions'
    | typeof detectionRulesKey

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
        haActions: {
            title: 'HA actions',
            description: 'Actions to show on the notification, i.e. {"action":"open_door","title":"Open door","icon":"sfsymbols:door"}',
            subgroup: 'Notifier',
            type: 'string',
            multiple: true
        },
        [detectionRulesKey]: {
            title: 'Rules',
            group: 'Advanced notifier detection rules',
            type: 'string',
            multiple: true,
            combobox: true,
            defaultValue: [],
            choices: [],
        }
    };

    return settings;
}

export const mainPluginName = scrypted.name;

export const isDeviceEnabled = async (deviceId: string, deviceSettings: Setting[]) => {
    const mainPluginDevice = sdk.systemManager.getDeviceByName(mainPluginName) as unknown as Settings;
    const mainSettings = await mainPluginDevice.getSettings();
    const mainSettingsByKey = keyBy(mainSettings, 'key');


    const deviceSettingsByKey = keyBy(deviceSettings, 'key');
    const { detectionRules, skippedRules } = getDeviceRules(deviceId, deviceSettingsByKey, mainSettingsByKey);

    const isPluginEnabled = mainSettingsByKey.pluginEnabled.value as boolean;
    const isMqttActive = mainSettingsByKey.mqttEnabled.value as boolean;
    const isActiveForNotifications = isPluginEnabled && !!detectionRules.length;
    const isActiveForMqttReporting = isPluginEnabled && isMqttActive && (mainSettingsByKey.activeDevicesForReporting?.value as string || []).includes(deviceId);

    return {
        isPluginEnabled,
        isActiveForNotifications,
        isActiveForMqttReporting,
        detectionRules,
        skippedRules,
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

export const detectionRulesKey = 'detectionRules';
export const getDetectionRuleKeys = (detectionRuleName: string) => {
    const enabledKey = `rule:${detectionRuleName}:enabled`;
    const activationKey = `rule:${detectionRuleName}:activation`;
    const textKey = `rule:${detectionRuleName}:text`;
    const detecionClassesKey = `rule:${detectionRuleName}:detecionClasses`;
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

    return {
        enabledKey,
        activationKey,
        textKey,
        detecionClassesKey,
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
    }
}

// export const deviceFilter = `(interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}') && (type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}' || type === '${ScryptedDeviceType.Sensor}'))`;
// export const notifierFilter = `(type === '${ScryptedDeviceType.Notifier}' && interfaces.includes('${ADVANCED_NOTIFIER_INTERFACE}'))`;
export const deviceFilter = `(type === '${ScryptedDeviceType.Camera}' || type === '${ScryptedDeviceType.Doorbell}' || type === '${ScryptedDeviceType.Sensor}')`;
export const notifierFilter = `(type === '${ScryptedDeviceType.Notifier}')`;

export const getDetectionRulesSettings = async (props: {
    groupName: string,
    storage: StorageSettings<any>,
    zones?: string[],
    withDevices?: boolean;
    withDetection?: boolean;
}) => {
    const { storage, zones, groupName, withDevices, withDetection } = props;
    const settings: Setting[] = [];

    const currentDetectionRules = storage.getItem(detectionRulesKey);
    for (const detectionRuleName of currentDetectionRules) {
        const {
            enabledKey,
            activationKey,
            textKey,
            notifiersKey,
            detecionClassesKey,
            scoreThresholdKey,
            whitelistedZonesKey,
            blacklistedZonesKey,
            devicesKey,
            dayKey,
            endTimeKey,
            startTimeKey,
            enabledSensorsKey,
            disabledSensorsKey,
        } = getDetectionRuleKeys(detectionRuleName);

        const currentActivation = storage.getItem(activationKey as any) as DetectionRuleActivation;

        settings.push(
            {
                key: enabledKey,
                title: 'Enabled',
                type: 'boolean',
                group: groupName,
                subgroup: detectionRuleName,
                value: storage.getItem(enabledKey as any) as boolean ?? true,
                immediate: true
            },
            {
                key: activationKey,
                title: 'Activation',
                group: groupName,
                subgroup: detectionRuleName,
                combobox: true,
                choices: [DetectionRuleActivation.Always, DetectionRuleActivation.OnActive, DetectionRuleActivation.Schedule],
                value: currentActivation,
                immediate: true
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
        );

        if (withDevices && currentActivation !== DetectionRuleActivation.OnActive) {
            // const elegibleDevice = getElegibleDevices();

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
                // choices: elegibleDevice.devices.map(device => device.id)
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

export enum DetectionRuleSource {
    Plugin = 'Plugin',
    Device = 'Device',
}

export interface DetectionRule {
    name: string
    activationType: DetectionRuleActivation;
    notifiers: string[];
    devices: string[];
    detectionClasses?: DetectionClass[];
    scoreThreshold?: number;
    whitelistedZones?: string[];
    blacklistedZones?: string[];
    source: DetectionRuleSource;
    customText?: string;
}

export const getDeviceRules = (
    deviceId: string,
    deviceStorage: Record<string, StorageSetting>,
    mainPluginStorage: Record<string, StorageSetting>,
) => {
    const detectionRules: DetectionRule[] = [];
    const skippedRules: DetectionRule[] = [];

    const allDeviceIds = mainPluginStorage['activeDevicesForNotifications']?.value as string[] ?? [];
    const activeNotifiers = mainPluginStorage['notifiers']?.value as string[] ?? [];
    const onActiveDevices = mainPluginStorage['activeDevicesForNotifications']?.value as string[] ?? [];

    const processRules = (storage: Record<string, StorageSetting>, source: DetectionRuleSource) => {
        const detectionRuleNames = storage[detectionRulesKey]?.value as string[] ?? [];
        for (const detectionRuleName of detectionRuleNames) {
            const {
                enabledKey,
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
            } = getDetectionRuleKeys(detectionRuleName);

            const isEnabled = JSON.parse(storage[enabledKey]?.value as string ?? 'false');

            const notifiers = storage[notifiersKey]?.value as string[] ?? [];
            const notifiersTouse = notifiers.filter(notifierId => activeNotifiers.includes(notifierId));

            const activationType = storage[activationKey]?.value as DetectionRuleActivation;
            const customText = storage[textKey]?.value as string || undefined;
            const mainDevices = storage[devicesKey]?.value as string[] ?? [];
            const devices = source === DetectionRuleSource.Device ? [deviceId] : mainDevices.length ? mainDevices : allDeviceIds;
            const devicesToUse = activationType === DetectionRuleActivation.OnActive ? onActiveDevices : devices;

            const detectionClasses = storage[detecionClassesKey]?.value as DetectionClass[] ?? [];
            const scoreThreshold = Number(storage[scoreThresholdKey]?.value || 0.7);

            const detectionRule: DetectionRule = {
                source,
                name: detectionRuleName,
                activationType,
                notifiers: notifiersTouse,
                scoreThreshold,
                detectionClasses,
                devices: devicesToUse,
                customText,
            }

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
                    const parseDate = (time: number) => {
                        const timeDate = new Date(time);

                        const newTimeDate = new Date();
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
                    const { newTimeDate: endTimeParsed, newDate: a2 } = parseDate(endTime);

                    const currentTime = currentDate.getTime();
                    timeAllowed = currentTime > startTimeParsed && currentTime < endTimeParsed;
                }
            }

            let sensorsOk = true;
            const enabledSensors = storage[enabledSensorsKey]?.value as string[] ?? [];
            const disabledSensors = storage[enabledSensorsKey]?.value as string[] ?? [];

            if (!!enabledSensors.length || !!disabledSensors.length) {
                const systemState = sdk.systemManager.getSystemState();
                if (!!enabledSensors.length) {
                    sensorsOk = enabledSensors.every(sensorId => systemState[sensorId]?.binarySensor?.value === true);
                }
                if(!!disabledSensors.length && sensorsOk) {
                    sensorsOk = disabledSensors.every(sensorId => systemState[sensorId]?.binarySensor?.value === false);
                }
            }

            const ruleAllowed =
                isEnabled &&
                !!devicesToUse.length &&
                devicesToUse.includes(deviceId) &&
                !!notifiersTouse.length &&
                timeAllowed &&
                sensorsOk;

            if (!ruleAllowed) {
                skippedRules.push(detectionRule);
            } else {
                detectionRules.push(detectionRule)
            }

        }
    };

    processRules(mainPluginStorage, DetectionRuleSource.Plugin);
    processRules(deviceStorage, DetectionRuleSource.Device);

    return { detectionRules, skippedRules };
}