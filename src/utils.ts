import sdk, { Camera, MediaObject, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDeviceBase, Settings } from "@scrypted/sdk"
import { sortBy, uniq } from "lodash";
const { endpointManager } = sdk;

export type DeviceInterface = Camera & ScryptedDeviceBase & Settings;

export const defaultDetectionClasses = [
    'motion',
    'person',
    'vehicle',
    'animal',
    'package',
    'face',
    'plate'
]

export const detectionClassesToPublish = [
    'motion',
    'person',
    'vehicle',
    'animal',
]

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

        lastSnapshotCloudUrl = `${localEndpoint}snapshots/${cameraDevice}/${lastSnapshot}`;
        lastSnapshotLocalUrl = `${cloudEndpoint}snapshots/${cameraDevice}/${lastSnapshot}`;
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
        let messageKey: string;
        let detection: ObjectDetectionResult;
        const subtitle = options?.subtitle;

        let isOffline = false;
        let isOnline = false;
        let isBoolean = false;
        let isDoorbell = false;
        let isDetection = false;

        if (subtitle === 'Offline') {
            messageKey = 'offlinelText';
            isOffline = true;
        } else if (subtitle === 'Online') {
            messageKey = 'onlinelText';
            isOnline = true;
        }

        // TODO: Find the source device of the notification in case of door/window/doorbell

        const allDetections: ObjectDetectionResult[] = options?.recordedEvent?.data?.detections ?? [];

        if (!isOffline && !isOnline) {
            if (subtitle.includes('Maybe: Vehicle')) {
                messageKey = 'plateDetectedText';
                detection = allDetections.find(det => det.className === 'plate');
                isDetection = true;
            } else if (subtitle.includes('Person')) {
                messageKey = 'personDetectedText';
                detection = allDetections.find(det => det.className === 'person');
                isDetection = true;
            } else if (subtitle.includes('Vehicle')) {
                detection = allDetections.find(det => det.className === 'vehicle');
                isDetection = true;
                messageKey = 'vehicleDetectedText';
            } else if (subtitle.includes('Animal')) {
                detection = allDetections.find(det => det.className === 'animal');
                isDetection = true;
                messageKey = 'animalDetectedText';
            } else if (subtitle.includes('Maybe: ')) {
                messageKey = 'familiarDetectedText';
                detection = allDetections.find(det => det.className === 'face');
                isDetection = true;
            } else if (subtitle.includes('Motion')) {
                messageKey = 'motionDetectedText';
                detection = allDetections.find(det => det.className === 'motion');
                isDetection = true;
            } else if (subtitle.includes('Door/Window Open')) {
                messageKey = 'doorWindowText';
                isBoolean = true;
            } else if (subtitle.includes('Doorbell Ringing')) {
                messageKey = 'doorbellText';
                isDoorbell = true;
            }
        }

        if (isDoorbell || isBoolean) {
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
            messageKey,
            detection,
            allDetections,
            isOnline,
            isOffline,
            isBoolean,
            isDoorbell,
            isDetection
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
    device: DeviceInterface,
    notifierId: string,
    time: number,
    image?: MediaObject,
    detection?: ObjectDetectionResult
    forceMessageKey?: string,
    source?: NotificationSource,
    keepImage?: boolean,
}

export interface GetNotificationTextProps {
    device: DeviceInterface,
    detectionTime: number,
    detection?: ObjectDetectionResult,
    notifierId: string,
    externalUrl: string,
    forceKey?: string,
}

export interface ExecuteReportProps {
    currentTime: number,
    deviceName: string,
    detections: ObjectDetectionResult[],
    device: DeviceInterface
    b64Image?: string
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

export const sortDetectionsByPriority = (detections: ObjectDetectionResult[]) => {
    return sortBy(detections, (detection) => detection?.className ? classnamePrio[detection.className] : 100);

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

export const getTextSettings = (forMixin: boolean) => {
    const groupKey = forMixin ? 'subgroup' : 'group';

    return {
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
}