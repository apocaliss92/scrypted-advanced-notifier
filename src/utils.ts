import sdk, { Camera, MediaObject, NotifierOptions, ObjectDetectionResult, ScryptedDeviceBase, Settings } from "@scrypted/sdk"
import { sortBy } from "lodash";

export type DeviceInterface = Camera & ScryptedDeviceBase & Settings;

export const parseNotificationMessage = (title: string, options?: NotifierOptions) => {
    const cameraDevice = sdk.systemManager.getDeviceByName(title) as unknown as DeviceInterface;
    let messageKey: string;
    let label: string;
    let detection: ObjectDetectionResult;
    const triggerTime = options?.recordedEvent?.data.timestamp ?? new Date().getTime();
    const subtitle = options?.subtitle;

    let isOffline = false;
    let isOnline = false;
    let isBoolean = false;

    if (subtitle === 'Offline') {
        messageKey = 'offlinelText';
        isOffline = true;
    } else if (subtitle === 'Online') {
        messageKey = 'onlinelText';
        isOnline = true;
    }

    const allDetections = options?.recordedEvent?.data?.detections ?? [];

    if (!isOffline && !isOnline) {

        if (subtitle.includes('Person')) {
            messageKey = 'personDetectedText';
            detection = allDetections.find(det => det.className === 'person');
        } else if (subtitle.includes('Vehicle')) {
            detection = allDetections.find(det => det.className === 'vehicle');
            messageKey = 'vehicleDetectedText';
        } else if (subtitle.includes('Animal')) {
            detection = allDetections.find(det => det.className === 'animal');
            messageKey = 'animalDetectedText';
        } else if (subtitle.includes('Maybe: ')) {
            messageKey = 'familiarDetectedText';
            detection = allDetections.find(det => det.className === 'face');
            // label = options.recordedEvent.data.detections.find(det => !!det.label)?.label;
        } else if (subtitle.includes('Motion')) {
            messageKey = 'motionDetectedText';
            detection = allDetections.find(det => det.className === 'motion');
        } else if (subtitle.includes('Door')) {
            messageKey = 'doorWindowText';
            isBoolean = true;
        } else if (subtitle.includes('ring')) {
            messageKey = 'doorbellText';
            isBoolean = true;
        }
    }

    return {
        cameraDevice,
        messageKey,
        label,
        triggerTime,
        detection,
        allDetections,
        isOnline,
        isOffline,
        isBoolean,
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

export const getIsDetectionValid = async (device: DeviceInterface, console?: Console) => {
    const deviceSettings = await device.getSettings();

    const detectionClasses = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:detectionClasses')?.value ?? []) as string[];
    const whitelistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:whitelistedZones')?.value ?? []) as string[];
    const blacklistedZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:blacklistedZones')?.value ?? []) as string[];
    const scoreThreshold = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:scoreThreshold')?.value as number) || 0.7;
    const alwaysZones = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:alwaysZones')?.value ?? []) as string[];

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

        const isValid = zonesOk && faceOk && motionOk && scoreOk && classNameOk;

        const data: any = {
            detectionClasses,
            className,
            classNameOk,

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