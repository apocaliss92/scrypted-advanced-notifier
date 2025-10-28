import { MediaObject, MediaStreamDestination, ObjectsDetected } from "@scrypted/sdk";
import { Deferred } from "../../scrypted/common/src/deferred";
import { AudioRule, BaseRule, DetectionRule, MatchRule, ObserveZoneData, OccupancyRule, ScryptedEventSource, TimelapseRule } from "./utils";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";

export interface CurrentOccupancyState {
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

export const getInitOccupancyState = (rule: OccupancyRule): CurrentOccupancyState => {
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

export interface AccumulatedDetection { detect: ObjectsDetected, eventId: string, eventSource: ScryptedEventSource };

export class CameraMixinState {
    storageSettings;
    mqttClient: MqttClient;
    lastFsCleanup: number;
    logger: Console;
    lastDelaySet: Record<string, number> = {};
    mqttDetectionMotionTimeout: NodeJS.Timeout;
    initializingMqtt: boolean;
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
    lastClipGenerationTimestamps: Record<string, number> = {};

    accumulatedDetections: AccumulatedDetection[] = [];
    accumulatedRules: MatchRule[] = [];
    clientId: string;

    snoozeUntilDic: Record<string, number> = {};

    lastMotionEnd: number;
    currentSnapshotTimeout = 4000;

    clipGenerationTimeout: Record<string, NodeJS.Timeout> = {};
    detectionIdEventIdMap: Record<string, string> = {};
    objectIdLastReport: Record<string, number> = {};

    decoderEnablementLogged = false;

    constructor(props: { clientId: string, cameraMixin: AdvancedNotifierCameraMixin }) {
        const { clientId, cameraMixin } = props;
        this.clientId = clientId;
        this.storageSettings = new StorageSettings(cameraMixin, cameraMixin.initStorage);

        // this.snoozeUntilDic = JSON.parse(this.storageSettings.getItem('snoozedData') ?? '{}');
        // this.lastDelaySet = JSON.parse(this.storageSettings.getItem('delayPassedData') ?? '{}');
    }
}
