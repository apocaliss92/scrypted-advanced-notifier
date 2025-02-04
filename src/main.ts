import sdk, { DeviceBase, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { isEqual, keyBy, sortBy } from 'lodash';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DeviceInterface, NotificationSource, getWebooks, getTextSettings, getTextKey, EventType, detectionRulesKey, getDetectionRulesSettings, DetectionRule, getElegibleDevices, deviceFilter, notifierFilter, ADVANCED_NOTIFIER_INTERFACE, parseNvrNotificationMessage, NotificationPriority, getFolderPaths, getDeviceRules, NvrEvent, ParseNotificationMessageResult, getPushoverPriority, getDetectionRuleKeys, detectRuleEnabledRegex, OccupancyRule, occupancyRuleEnabledRegex, nvrAcceleratedMotionSensorId, StoreImageFn, TimelapseRule, RuleType, getNowFriendlyDate, DetectionRuleActivation, getTimelapseRuleKeys } from "./utils";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { DetectionClass, detectionClassesDefaultMap } from "./detecionClasses";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getMqttTopics, getOccupancyRuleStrings, getRuleStrings, setupPluginAutodiscovery, subscribeToMainMqttTopics } from "./mqtt-utils";
import path from 'path';
import { AdvancedNotifierNotifier } from "./notifier";
// import { version } from '../package.json';
import fs from 'fs';
import child_process from 'child_process';
import { once } from "events";

const { systemManager, mediaManager } = sdk;
const defaultNotifierNativeId = 'advancedNotifierDefaultNotifier';

interface NotifyCameraProps {
    cameraDevice?: DeviceInterface,
    triggerDevice: DeviceInterface,
    notifierId: string,
    time: number,
    image?: MediaObject,
    detection?: ObjectDetectionResult
    textKey: string,
    rule?: DetectionRule,
    source?: NotificationSource,
    notifierSettings: Setting[],
    logger: Console,
    skipImage?: boolean,
}

export default class AdvancedNotifierPlugin extends BasePlugin implements MixinProvider, HttpRequestHandler, DeviceProvider {
    private deviceHaEntityMap: Record<string, string> = {};
    private haEntityDeviceMap: Record<string, string> = {};
    private deviceVideocameraMap: Record<string, string> = {};
    private videocameraDevicesMap: Record<string, string[]> = {};
    public deviceRoomMap: Record<string, string> = {}
    private doorbellDevices: string[] = [];
    public currentMixinsMap: Record<string, AdvancedNotifierCameraMixin | AdvancedNotifierSensorMixin> = {};
    public haNotifiersProviderId: string;
    public haDevicesProviderId: string;
    private pushoverProviderId: string;
    private refreshDeviceLinksInterval: NodeJS.Timeout;
    defaultNotifier: AdvancedNotifierNotifier;
    nvrRules: DetectionRule[] = [];
    allPluginRules: DetectionRule[] = [];
    lastNotExistingNotifier: number;
    private checkExistingDevicesInterval: NodeJS.Timeout;

    storageSettings = new StorageSettings(this, {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => this.startStop(enabled),
            hideHa: false,
        }),
        pluginEnabled: {
            title: 'Plugin enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        mqttEnabled: {
            title: 'MQTT enabled',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        serverId: {
            title: 'Server identifier',
            type: 'string',
            hide: true,
        },
        localIp: {
            title: 'Server local ip',
            type: 'string',
            hide: true,
        },
        scryptedToken: {
            title: 'Scrypted token',
            type: 'string',
        },
        nvrUrl: {
            title: 'NVR url',
            description: 'Url pointing to the NVR instance, useful to generate direct links to timeline',
            type: 'string',
            defaultValue: 'https://nvr.scrypted.app/',
            placeholder: 'https://nvr.scrypted.app/',
        },
        imagesPath: {
            title: 'Storage path',
            description: 'Disk path where to save images. Leave blank if you do not want any image to be stored',
            type: 'string',
        },
        imagesRegex: {
            title: 'Images name',
            description: 'Filename for the images. Possible values to be used are: ${name} ${timestamp}. Using only ${name} will ensure to have only 1 image per file',
            type: 'string',
            defaultValue: '${name}',
            placeholder: '${name}',
        },
        domains: {
            group: 'Base',
            subgroup: 'Homeassistant',
            title: 'Entity regex patterns',
            description: 'Regex to filter out entities fetched',
            type: 'string',
            multiple: true,
            defaultValue: ['binary_sensor.(.*)_triggered']
        },
        fetchHaEntities: {
            group: 'Base',
            subgroup: 'Homeassistant',
            title: 'Fetch entities from HA',
            type: 'button',
            onPut: async () => await this.fetchHomeassistantData()
        },
        mqttActiveEntitiesTopic: {
            title: 'Active entities topic',
            group: 'MQTT',
            description: 'Topic containing the active entities, will trigger the related devices activation for notifications',
            onPut: async () => {
                await this.setupMqttEntities();
            },
        },
        activeDevicesForReporting: {
            group: 'MQTT',
            title: 'Active devices for MQTT reporting',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: deviceFilter,
        },
        useNvrDetectionsForMqtt: {
            group: 'MQTT',
            title: 'Use NVR detections',
            description: 'Use NVR detection to publish MQTT state messages',
            type: 'boolean',
        },
        fetchedEntities: {
            group: 'Metadata',
            title: '',
            subgroup: 'Entities',
            multiple: true,
            defaultValue: [],
            choices: [],
            combobox: true,
        },
        fetchedRooms: {
            group: 'Metadata',
            title: '',
            subgroup: 'Rooms',
            multiple: true,
            defaultValue: [],
            choices: [],
            combobox: true,
        },
        notifiers: {
            group: 'Notifier',
            title: 'Active notifiers',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: notifierFilter,
        },
        ...getTextSettings(false),
        [detectionRulesKey]: {
            title: 'Rules',
            group: 'Detection rules',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: [],
            defaultValue: [],
        },
        activeDevicesForNotifications: {
            title: '"OnActive" devices',
            group: 'Detection rules',
            type: 'device',
            multiple: true,
            combobox: true,
            deviceFilter: deviceFilter,
        },
        objectDetectionDevice: {
            title: 'Object Detector',
            group: 'Detection rules',
            description: 'Select the object detection plugin to use for detecting objects.',
            type: 'device',
            deviceFilter: `interfaces.includes('ObjectDetectionPreview') && id !== '${nvrAcceleratedMotionSensorId}'`,
            immediate: true,
        },
        securitySystem: {
            title: 'Security system',
            group: 'Detection rules',
            description: 'Select the security system device that will be used to enable rules.',
            type: 'device',
            deviceFilter: `type === '${ScryptedDeviceType.SecuritySystem}'`,
            immediate: true,
        },
        testDevice: {
            title: 'Device',
            group: 'Test',
            immediate: true,
            type: 'device',
            deviceFilter: deviceFilter,
        },
        testNotifier: {
            group: 'Test',
            title: 'Notiier',
            type: 'device',
            deviceFilter: notifierFilter,
            immediate: true,
        },
        testMessage: {
            group: 'Test',
            title: 'Message key',
            type: 'string',
            immediate: true,
        },
        testPriority: {
            group: 'Test',
            title: 'Pushover priority',
            type: 'string',
            immediate: true,
            choices: [NotificationPriority.VeryLow, NotificationPriority.Low, NotificationPriority.Normal, NotificationPriority.High],
            defaultValue: NotificationPriority.Normal
        },
        testButton: {
            group: 'Test',
            title: 'Send notification',
            type: 'button',
            onPut: async () => {
                await this.executeNotificationTest();
            },
        },
        checkConfigurations: {
            group: 'Test',
            title: 'Check configurations',
            type: 'button',
            onPut: async () => {
                await this.checkPluginConfigurations(true);
            },
        },
    });


    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Advanced notifier'
        });

        // if (version === '1.5.1') {
        //     this.log.a('In version 1.5.1 there have been many changes/fixes on the MQTT devices declaration. Please clear all the devices on Homeassistant with prefix "Scrypted AN" to have fresh sensors');
        // }

        (async () => {
            await sdk.deviceManager.onDeviceDiscovered(
                {
                    name: 'Advanced notifier NVR notifier',
                    nativeId: defaultNotifierNativeId,
                    interfaces: [ScryptedInterface.Notifier],
                    type: ScryptedDeviceType.Notifier,
                },
            );

            if (this.storageSettings.values.haEnabled) {
                await this.fetchHomeassistantData();
            }
        })();

        this.start().then().catch(this.getLogger().log);
    }

    async getDevice(nativeId: string) {
        if (nativeId === defaultNotifierNativeId)
            return this.defaultNotifier ||= new AdvancedNotifierNotifier(defaultNotifierNativeId, this);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async stop() {
        this.refreshDeviceLinksInterval && clearInterval(this.refreshDeviceLinksInterval);
        this.checkExistingDevicesInterval && clearInterval(this.checkExistingDevicesInterval);
        await this.mqttClient?.disconnect();
    }

    async start() {
        try {
            await this.initPluginSettings();
            await this.refreshDevicesLinks();
            await this.setupMqttEntities();

            this.refreshDeviceLinksInterval = setInterval(async () => {
                await this.refreshDevicesLinks();
            }, 10000);
            this.checkExistingDevicesInterval = setInterval(async () => await this.checkPluginConfigurations(false), 60 * 60 * 1000);
        } catch (e) {
            this.getLogger().log(`Error in initFLow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const logger = this.getLogger();
        const url = new URL(`http://localhost${request.url}`);
        const [_, __, ___, ____, _____, webhook, ...rest] = url.pathname.split('/');
        const [deviceNameOrActionRaw, ruleName, timelapseName] = rest
        const deviceNameOrAction = decodeURIComponent(deviceNameOrActionRaw);
        logger.log(`Webhook request: ${JSON.stringify({
            url: request.url,
            webhook,
            deviceNameOrActionRaw,
            deviceNameOrAction,
            ruleName,
            timelapseName
        })}`);

        try {
            const { lastSnapshot, haAction, timelapseDownload, timelapseStream } = await getWebooks();
            if (webhook === haAction) {
                const { url, accessToken } = await this.getHaApiUrl();

                await axios.post(`${url}/api/events/mobile_app_notification_action`,
                    { "action": deviceNameOrAction },
                    {
                        headers: {
                            'Authorization': 'Bearer ' + accessToken,
                        }
                    });

                response.send(`Action ${deviceNameOrAction} executed`, {
                    code: 200,
                });
                return;
            } else if (webhook === lastSnapshot) {
                const device = this.currentMixinsMap[deviceNameOrAction] as AdvancedNotifierCameraMixin;
                const isWebhookEnabled = device?.storageSettings.getItem('lastSnapshotWebhook');
                logger.log(`lastSnapshotWebhook: ${isWebhookEnabled}`);

                if (isWebhookEnabled) {
                    const { snapshotsFolder } = await getFolderPaths(device.id);

                    const lastSnapshotFilePath = path.join(snapshotsFolder, `${webhook}.jpg`);

                    if (lastSnapshotFilePath) {
                        const mo = await sdk.mediaManager.createFFmpegMediaObject({
                            inputArguments: [
                                '-i', lastSnapshotFilePath,
                            ]
                        });
                        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
                        response.send(jpeg, {
                            headers: {
                                'Content-Type': 'image/jpeg',
                            }
                        });
                        return;
                    } else {
                        response.send(`Last snapshot not found for device ${deviceNameOrAction}`, {
                            code: 404,
                        });
                        return;
                    }
                }
            } else if (webhook === timelapseDownload) {
                const decodedTimelapseName = decodeURIComponent(timelapseName);
                const decodedRuleName = decodeURIComponent(ruleName);
                const { generatedPath } = this.getTimelapseFolder({
                    ruleName: decodedRuleName
                });

                const timelapsePath = path.join(generatedPath, decodedTimelapseName);
                logger.log(`Requesting timelapse ${decodedRuleName} for download: ${JSON.stringify({
                    generatedPath,
                    timelapseName,
                    decodedTimelapseName,
                    ruleName,
                    decodedRuleName,
                    timelapsePath,
                })}`)


                response.sendFile(timelapsePath);
                return;
            } else if (webhook === timelapseStream) {
                // const device = this.currentMixinsMap[deviceNameOrAction] as AdvancedNotifierCameraMixin;
            }
        } catch (e) {
            response.send(`${JSON.stringify(e)}, ${e.message}`, {
                code: 400,
            });

            return;
        }

        response.send(`Webhook not found`, {
            code: 404,
        });

        return;
    }

    private async sendAutoDiscovery() {
        const mqttClient = await this.getMqttClient();
        const logger = this.getLogger();
        const objDetectionPlugin = systemManager.getDeviceByName('Scrypted NVR Object Detection') as unknown as Settings;
        const settings = await objDetectionPlugin.getSettings();
        const knownPeople = settings?.find(setting => setting.key === 'knownPeople')?.choices
            ?.filter(choice => !!choice)
            .map(person => person.trim());

        const mainSettings = await this.getSettings();
        const mainSettingsByKey = keyBy(mainSettings, 'key');
        const { allPluginRules } = getDeviceRules({ mainPluginStorage: mainSettingsByKey, console: logger });

        await setupPluginAutodiscovery({
            mqttClient,
            people: knownPeople,
            console: logger,
            detectionRules: allPluginRules,
        });

        return { allPluginRules };
    }

    async putSetting(key: string, value: SettingValue, skipMqtt?: boolean): Promise<void> {
        if (!skipMqtt) {
            const enabledResultDetected = detectRuleEnabledRegex.exec(key);
            if (enabledResultDetected) {
                const ruleName = enabledResultDetected[1];
                this.updateDetectionRuleOnMqtt({ active: value as boolean, ruleName, logger: this.getLogger() });
            }
        }

        return this.storageSettings.putSetting(key, value);
    }

    async updateDetectionRuleOnMqtt(props: { deviceId?: string, active: boolean, ruleName: string, logger: Console }) {
        const { active, ruleName, deviceId, logger } = props;
        const mqttClient = await this.getMqttClient();
        const { entityId, ruleDeviceId } = getRuleStrings({ name: ruleName, deviceId } as DetectionRule);

        const { getEntityTopic } = getMqttTopics(ruleDeviceId);
        const stateTopic = getEntityTopic(entityId);
        logger.log(`Setting detection rule ${ruleName} to ${active} for device ${deviceId}`);
        await mqttClient.publish(stateTopic, active ? 'ON' : 'OFF');
    }

    async updateOccupancyRuleOnMqtt(props: { deviceId?: string, active: boolean, ruleName: string, logger: Console }) {
        const { active, ruleName, deviceId, logger } = props;
        const mqttClient = await this.getMqttClient();
        const { entityId, ruleDeviceId } = getOccupancyRuleStrings({ name: ruleName } as OccupancyRule);

        const { getEntityTopic } = getMqttTopics(ruleDeviceId);
        const stateTopic = getEntityTopic(entityId);
        logger.log(`Setting occupancy rule ${ruleName} to ${active} for device ${deviceId}`);
        await mqttClient.publish(stateTopic, active ? 'ON' : 'OFF');
    }

    private async setupMqttEntities() {
        const { mqttEnabled, mqttActiveEntitiesTopic } = this.storageSettings.values;
        if (mqttEnabled) {
            try {
                const mqttClient = await this.getMqttClient();
                const { allPluginRules } = await this.sendAutoDiscovery();
                const logger = this.getLogger();

                this.getLogger().log(`Subscribing to mqtt topics`);
                await subscribeToMainMqttTopics({
                    entitiesActiveTopic: mqttActiveEntitiesTopic,
                    mqttClient,
                    detectionRules: allPluginRules,
                    activeEntitiesCb: async (message) => {
                        logger.log(`Received update for ${mqttActiveEntitiesTopic} topic: ${JSON.stringify(message)}`);
                        await this.syncHaEntityIds(message);
                    },
                    ruleCb: async ({ active, ruleName }) => {
                        const { enabledKey } = getDetectionRuleKeys(ruleName);
                        logger.log(`Setting rule ${ruleName} to ${active}`);
                        await this.putSetting(enabledKey, active, true);
                    },
                });
            } catch (e) {
                this.getLogger().log('Error setting up MQTT client', e);
            }
        }
    }

    private async syncHaEntityIds(devices: string[]) {
        const deviceIds: string[] = [];
        for (const device of devices) {
            const deviceNameFromEntity = this.haEntityDeviceMap[device];
            const entityFromDeviceName = this.deviceHaEntityMap[device];

            if (deviceNameFromEntity) {
                deviceIds.push(deviceNameFromEntity);
            } else if (entityFromDeviceName) {
                deviceIds.push(device);
            }
        }

        this.getLogger().log(`SyncHaEntityIds: ${JSON.stringify({
            devices,
            deviceIds,
            stored: this.storageSettings.values.activeDevicesForNotifications ?? [],
            isEqual: isEqual(sortBy(deviceIds), sortBy(this.storageSettings.values.activeDevicesForNotifications ?? []))
        })}`);

        if (isEqual(sortBy(deviceIds), sortBy(this.storageSettings.values.activeDevicesForNotifications ?? []))) {
            this.getLogger().log('Devices did not change');
        } else {
            this.putSetting('activeDevicesForNotifications', deviceIds);
        }
    }

    private async initPluginSettings() {
        const logger = this.getLogger();
        const cloudPlugin = systemManager.getDeviceByName('Scrypted Cloud') as unknown as Settings;
        if (cloudPlugin) {
            const oauthUrl = await (cloudPlugin as any).getOauthUrl();
            const url = new URL(oauthUrl);
            const serverId = url.searchParams.get('server_id');
            this.putSetting('serverId', serverId);
            logger.log(`Server id found: ${serverId}`);
        } else {
            logger.log(`Cloud plugin not found`);
        }

        const localIp = (await sdk.endpointManager.getLocalAddresses())?.[0];
        this.putSetting('localIp', localIp);
        logger.log(`Local IP found: ${localIp}`);

        const haNotifiersPlugin = systemManager.getDeviceByName('Notify Service') as unknown as ScryptedDeviceBase;
        this.haNotifiersProviderId = haNotifiersPlugin?.id

        const haDevicesPlugin = systemManager.getDeviceByName('Homeassistant devices') as unknown as ScryptedDeviceBase;
        this.haDevicesProviderId = haDevicesPlugin?.id

        const pushoverPlugin = systemManager.getDeviceByName('Pushover Plugin') as unknown as ScryptedDeviceBase;
        this.pushoverProviderId = pushoverPlugin?.id

        logger.log(`HA providerIds: ${this.haNotifiersProviderId},${this.haDevicesProviderId} and Pushover providerId: ${this.pushoverProviderId}`);

        if (this.storageSettings.values.haEnabled) {
            await this.fetchHomeassistantData();
        }
    }

    private async refreshDevicesLinks() {
        const logger = this.getLogger();
        try {
            const doorbellDevices: string[] = [];
            const haEntities: string[] = [];
            const deviceHaEntityMap: Record<string, string> = {};
            const haEntityDeviceMap: Record<string, string> = {};
            const deviceVideocameraMap: Record<string, string> = {};
            const videocameraDevicesMap: Record<string, string[]> = {};
            const deviceRoomMap: Record<string, string> = {};

            const allDevices = getElegibleDevices();
            for (const device of allDevices) {
                const deviceId = device.id;
                const deviceType = device.type;
                try {
                    const settings = await device.getSettings();
                    const haEntityId = settings.find(setting => setting.key === 'homeassistantMetadata:entityId')?.value as string;
                    // const room = settings.find(setting => setting.key === 'homeassistantMetadata:room')?.value as string;
                    const room = device.room;
                    const linkedCamera = settings.find(setting => setting.key === 'homeassistantMetadata:linkedCamera')?.value as string;
                    const nearbySensors = (settings.find(setting => setting.key === 'recording:nearbySensors')?.value as string[]) ?? [];
                    const nearbyLocks = (settings.find(setting => setting.key === 'recording:nearbyLocks')?.value as string[]) ?? [];

                    deviceRoomMap[deviceId] = room;
                    if (haEntityId) {
                        haEntities.push(haEntityId);

                        deviceHaEntityMap[deviceId] = haEntityId;
                        haEntityDeviceMap[haEntityId] = deviceId;
                    }

                    if (deviceType === ScryptedDeviceType.Doorbell) {
                        const doorbellButtonId = settings.find(setting => setting.key === 'replaceBinarySensor:replaceBinarySensor')?.value as string;
                        if (doorbellButtonId) {
                            doorbellDevices.push(doorbellButtonId);
                            deviceVideocameraMap[doorbellButtonId] = deviceId;
                        }
                    }

                    if (linkedCamera) {
                        const cameraDevice = systemManager.getDeviceById(linkedCamera);
                        if (cameraDevice) {
                            const cameraId = cameraDevice.id;
                            deviceVideocameraMap[deviceId] = cameraId;
                            if (!videocameraDevicesMap[cameraId]) {
                                videocameraDevicesMap[cameraId] = [];
                            }
                            !videocameraDevicesMap[cameraId].includes(deviceId) && videocameraDevicesMap[cameraId].push(deviceId);
                        } else {
                            logger.log(`Device ${device.name} is linked to the cameraId ${linkedCamera}, not available anymore`);
                        }
                    }

                    if ([ScryptedDeviceType.Doorbell, ScryptedDeviceType.Camera].includes(deviceType)) {
                        const allLinkedSensorIds = [...nearbySensors, ...nearbyLocks];

                        for (const linkedSensorId of allLinkedSensorIds) {
                            deviceVideocameraMap[linkedSensorId] = deviceId;
                            if (!videocameraDevicesMap[deviceId]) {
                                videocameraDevicesMap[deviceId] = [];
                            }
                            !videocameraDevicesMap[deviceId].includes(linkedSensorId) && videocameraDevicesMap[deviceId].push(linkedSensorId);
                        }
                    }
                } catch (e) {
                    logger.log(`Error in refreshDevicesLinks-${device}`, e);
                }
            }

            const mainSettings = await this.getSettings();
            const mainSettingsByKey = keyBy(mainSettings, 'key');
            const { nvrRules, pluginActiveRules } = getDeviceRules({ mainPluginStorage: mainSettingsByKey, console: logger });
            this.nvrRules = nvrRules || [];
            this.allPluginRules = pluginActiveRules || [];

            this.deviceHaEntityMap = deviceHaEntityMap;
            this.haEntityDeviceMap = haEntityDeviceMap;
            this.deviceVideocameraMap = deviceVideocameraMap;
            this.videocameraDevicesMap = videocameraDevicesMap;
            this.deviceRoomMap = deviceRoomMap;
            this.doorbellDevices = doorbellDevices;

            if (this.storageSettings.values.mqttEnabled) {
                await this.sendAutoDiscovery();
            }
        } catch (e) {
            logger.log('Error in refreshDevicesLinks', e);
        }
    }

    private async checkPluginConfigurations(manual: boolean) {
        const logger = this.getLogger();
        try {
            const notifiersRegex = new RegExp('(rule|occupancyRule|timelapseRule):(.*):notifiers');
            const devicesRegex = new RegExp('(rule|occupancyRule|timelapseRule):(.*):devices');
            const activationTypeRegex = new RegExp('rule:(.*):activation');
            const allDevices = getElegibleDevices();

            const missingNotifiersOfDeviceRules: { deviceName: string, ruleName: string, notifierIds: string[] }[] = [];
            const missingNotifiersOfPluginRules: { ruleName: string, notifierIds: string[] }[] = [];
            const missingDevicesOfPluginRules: { ruleName: string, deviceIds: string[] }[] = [];
            const devicesWithoutRoom: string[] = [];

            for (const device of allDevices) {
                const settings = await this.currentMixinsMap[device.name].getMixinSettings();
                const relevantRules = settings.filter(setting => setting.key?.match(notifiersRegex));
                if (!device.room) {
                    devicesWithoutRoom.push(device.name);
                }

                for (const rule of relevantRules) {
                    const [_, type, name] = rule.key.match(notifiersRegex);
                    const missingNotifiers = (rule.value as string[])?.filter(notifierId => !sdk.systemManager.getDeviceById(notifierId));
                    if (missingNotifiers.length) {
                        missingNotifiersOfDeviceRules.push({ deviceName: device.name, notifierIds: missingNotifiers, ruleName: `${type}_${name}` });
                    }
                }
            }

            const settings = await this.getSettings();
            const relevantNotifierRules = settings.filter(setting => setting.key?.match(notifiersRegex));

            for (const rule of relevantNotifierRules) {
                const [_, type, name] = rule.key.match(notifiersRegex);
                const missingNotifiers = (rule.value as string[])?.filter(notifierId => !sdk.systemManager.getDeviceById(notifierId));
                if (missingNotifiers.length) {
                    missingNotifiersOfPluginRules.push({ notifierIds: missingNotifiers, ruleName: `${type}_${name}` });
                }
            }
            const relevantdeviceRules = settings.filter(setting => setting.key?.match(devicesRegex));

            for (const rule of relevantdeviceRules) {
                const [_, type, name] = rule.key.match(devicesRegex);
                const missingDevices = (rule.value as string[])?.filter(notifierId => !sdk.systemManager.getDeviceById(notifierId));
                if (missingDevices.length) {
                    missingDevicesOfPluginRules.push({ deviceIds: missingDevices, ruleName: `${type}_${name}` });
                }
            }
            const anyActiveOnRules = settings.filter(setting => setting.key?.match(activationTypeRegex))
                .filter(setting => setting.value === DetectionRuleActivation.OnActive);

            const sensorsNotLinkedToAnyCamera = allDevices.filter(
                device => device.type === ScryptedDeviceType.Sensor && !this.deviceVideocameraMap[device.id]
            ).map(sensor => sensor.name);

            const entitiesWithWrongEntityId = allDevices.filter(
                device => !this.deviceHaEntityMap[device.id] || !this.storageSettings.values.fetchedEntities.includes(this.deviceHaEntityMap[device.id])
            ).map(sensor => sensor.name);

            const {
                devNotifier,
                imagesPath,
                activeDevicesForReporting,
                scryptedToken,
                nvrUrl,
                objectDetectionDevice,
                haEnabled,
            } = this.storageSettings.values;
            let storagePathError;

            try {
                await fs.promises.access(imagesPath);
            } catch (e) {
                storagePathError = e;
            }

            const alertHaIssues = haEnabled && anyActiveOnRules;

            const body = JSON.stringify({
                missingNotifiersOfDeviceRules: missingNotifiersOfDeviceRules.length ? missingNotifiersOfDeviceRules : undefined,
                missingNotifiersOfPluginRules: missingNotifiersOfPluginRules.length ? missingNotifiersOfPluginRules : undefined,
                missingDevicesOfPluginRules: missingDevicesOfPluginRules.length ? missingDevicesOfPluginRules : undefined,
                sensorsNotLinkedToAnyCamera: sensorsNotLinkedToAnyCamera.length ? sensorsNotLinkedToAnyCamera : undefined,
                entitiesWithWrongEntityId: entitiesWithWrongEntityId.length ? entitiesWithWrongEntityId : undefined,
                devicesWithoutRoom: devicesWithoutRoom.length ? devicesWithoutRoom : undefined,
                storagePathError: storagePathError ?? 'No error',
                activeDevicesForReporting: `${activeDevicesForReporting.length} devices`,
                scryptedToken: scryptedToken ? 'Set' : 'Not set',
                nvrUrl: nvrUrl ? 'Set' : 'Not set',
                objectDetectionDevice: objectDetectionDevice ? objectDetectionDevice.name : 'Not set',
            });

            if (manual) {
                logger.log(`checkPluginConfigurations results: ${body}`);
            } else {
                logger.debug(`Results: ${body}`);

                if (
                    missingNotifiersOfDeviceRules.length ||
                    missingNotifiersOfPluginRules.length ||
                    missingDevicesOfPluginRules.length ||
                    sensorsNotLinkedToAnyCamera.length ||
                    (alertHaIssues && devicesWithoutRoom.length) ||
                    (alertHaIssues && entitiesWithWrongEntityId.length) ||
                    !!storagePathError
                ) {
                    (devNotifier as Notifier).sendNotification('Advanced notifier not correctly configured', {
                        body
                    });
                }
            }
        } catch (e) {
            logger.log('Error in checkExistingDevices', e);
        }
    }

    async getSettings() {
        try {
            const { haEnabled } = this.storageSettings.values;
            this.storageSettings.settings.domains.hide = !haEnabled;
            this.storageSettings.settings.fetchHaEntities.hide = !haEnabled;

            this.storageSettings.settings.testMessage.choices = Object.keys(getTextSettings(false)).map(key => key);

            const settings: Setting[] = await super.getSettings();

            const detectionRulesSettings = await getDetectionRulesSettings({
                storage: this.storageSettings,
                groupName: 'Detection rules',
                withDevices: true,
                withDetection: true,
                withNvrEvents: true,
                enabledRules: [...this.allPluginRules, ...this.nvrRules]
            });
            settings.push(...detectionRulesSettings);

            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }

    fetchHomeassistantData = async () => {
        const { domains } = this.storageSettings.values;
        const logger = this.getLogger();

        let rooms: string[] = [];
        let entityIds: string[] = [];

        try {
            logger.debug(`Fetching homeasisstant data`);
            const haApi = await this.getHaApi();
            const roomsResponse = await haApi.getTemplateData("{{ areas() }}");

            const getRoomName = async (areaId: string) => {
                return await haApi.getTemplateData(`{{ area_name('${areaId}') }}`);
            }

            const entitiesResponse = await haApi.getStatesData();
            const roomIds = sortBy(JSON.parse(roomsResponse.data.replace(new RegExp('\'', 'g'), '"')), elem => elem);

            for (const roomId of roomIds) {
                const roomName = await getRoomName(roomId);
                rooms.push(roomName.data);
            }

            entityIds = sortBy(
                entitiesResponse.data
                    .filter(entityStatus => domains.length > 0 ? domains.some(domain => new RegExp(domain).test(entityStatus.entity_id)) : true),
                elem => elem.entity_id)
                .map(entityStatus => entityStatus.entity_id);
        } catch (e) {
            logger.log(e);
        } finally {
            logger.debug(`Entities found: ${JSON.stringify(entityIds)}`);
            logger.debug(`Rooms found: ${JSON.stringify(rooms)}`);
            await this.putSetting('fetchedEntities', entityIds);
            await this.putSetting('fetchedRooms', rooms);
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if (
            [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.BinarySensor,
                ScryptedInterface.Lock,
                ScryptedInterface.Notifier,
            ].some(int => interfaces.includes(int))
        ) {
            return [ScryptedInterface.Settings, ADVANCED_NOTIFIER_INTERFACE]
        }

        return undefined;
    }

    async notifyOccupancyEvent(props: {
        cameraDevice: DeviceInterface,
        triggerTime: number,
        message: string,
        rule: OccupancyRule,
        image: MediaObject,
    }) {
        const { cameraDevice, rule, message, triggerTime, image } = props;
        const logger = this.getLogger();

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as Notifier & DeviceInterface;
            const deviceSettings = await cameraDevice.getSettings();

            const notifierData = await this.getNotifierData({
                device: cameraDevice,
                deviceSettings,
                notifier,
                triggerTime,
                rule,
            });

            const notifierOptions: NotifierOptions = {
                body: message,
                data: notifierData
            }

            const title = cameraDevice.name;

            logger.log(`Finally sending Occupancy event notification ${triggerTime} to ${notifier.name}. ${JSON.stringify({
                notifierOptions,
                title,
                message,
            })}`);

            await notifier.sendNotification(title, notifierOptions, image, undefined);
        }
    }

    async notifyTimelapse(props: {
        cameraDevice: DeviceInterface,
        rule: TimelapseRule,
        timelapseName: string,
    }) {
        const { cameraDevice, rule, timelapseName } = props;
        const logger = this.getLogger();

        const deviceInternal = this.currentMixinsMap[cameraDevice.name] as AdvancedNotifierCameraMixin;

        const { downloadUrl } = await deviceInternal.getTimelapseWebhookUrl({
            ruleName: rule.name,
            timelapseName,
        });
        const { generatedPath } = this.getTimelapseFolder({
            ruleName: rule.name
        });

        const timelapsePath = path.join(generatedPath, timelapseName);

        const fileStats = fs.statSync(timelapsePath);
        const sizeInBytes = fileStats.size;
        const fileSizeInMegabytes = sizeInBytes / (1024 * 1024);
        const isVideoValid = fileSizeInMegabytes < 50;

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as Notifier & DeviceInterface;
            const deviceSettings = await cameraDevice.getSettings();

            const notifierData = await this.getNotifierData({
                device: cameraDevice,
                deviceSettings,
                notifier,
                rule,
                videoUrl: downloadUrl,
                skipVideoAttach: !isVideoValid,
                ignoreActions: true,
            });

            const message = `${rule.customText}`;

            const notifierOptions: NotifierOptions = {
                body: message,
                data: notifierData
            }

            const title = cameraDevice.name;

            logger.log(`Finally sending Timelapse notification to ${notifier.name}. ${JSON.stringify({
                notifierOptions,
                title,
                message,
            })}`);

            await notifier.sendNotification(title, notifierOptions);
        }
    }

    async notifyNvrEvent(props: ParseNotificationMessageResult & { cameraDevice: DeviceInterface, triggerTime: number }) {
        const { eventType, textKey, triggerDevice, cameraDevice, triggerTime, label } = props;
        const logger = this.getLogger();
        const rules = this.nvrRules.filter(rule => rule.nvrEvents.includes(eventType as NvrEvent));

        const notifyCameraProps: Partial<NotifyCameraProps> = {
            triggerDevice,
            cameraDevice,
            time: triggerTime,
            source: NotificationSource.NVR,
            textKey,
            logger,
        }

        const { externalUrl } = this.getUrls(cameraDevice.id, triggerTime);

        if (eventType === NvrEvent.RecordingInterrupted) {
            notifyCameraProps.detection = {
                label,
            } as ObjectDetectionResult
        }

        for (const rule of rules) {
            const notifiers = rule.notifiers
            for (const notifierId of notifiers) {
                const notifier = systemManager.getDeviceById(notifierId) as unknown as Notifier & DeviceInterface;
                const notifierSettings = await notifier.getSettings();
                notifyCameraProps.notifierId = notifierId;
                notifyCameraProps.notifierSettings = notifierSettings;
                const deviceSettings = await cameraDevice.getSettings();

                const message = await this.getNotificationText({
                    detection: notifyCameraProps.detection,
                    detectionTime: triggerTime,
                    notifierId,
                    textKey,
                    device: triggerDevice,
                    notifierSettings,
                    externalUrl,
                });

                const notifierData = await this.getNotifierData({
                    device: cameraDevice,
                    deviceSettings,
                    notifier,
                    triggerTime,
                    rule,
                });

                const notifierOptions: NotifierOptions = {
                    body: message,
                    data: notifierData
                }

                const title = cameraDevice.name;

                logger.log(`Finally sending Nvr event notification ${triggerTime} to ${notifier.name}. ${JSON.stringify({
                    notifierOptions,
                    title,
                    message,
                })}`);

                await notifier.sendNotification(title, notifierOptions, undefined, undefined);
            }
        }
    }

    async onNvrNotification(cameraName: string, options?: NotifierOptions, image?: MediaObject, icon?: MediaObject | string) {
        const logger = this.getLogger();
        const triggerTime = options?.recordedEvent?.data.timestamp ?? new Date().getTime();
        const cameraDevice = sdk.systemManager.getDeviceByName(cameraName) as unknown as DeviceInterface;
        const deviceSensors = this.videocameraDevicesMap[cameraDevice.id] ?? [];
        const { devNotifier } = this.storageSettings.values;
        const result = await parseNvrNotificationMessage(cameraDevice, deviceSensors, options, logger);
        const {
            allDetections,
            eventType,
            triggerDevice,
        } = result;

        logger.debug(`NVR notification received: ${JSON.stringify({ cameraName, options, result, imageExists: !!image })}`);

        if ([EventType.ObjectDetection, EventType.Package].includes(eventType as EventType)) {
            await (this.currentMixinsMap[triggerDevice.name] as AdvancedNotifierCameraMixin)?.processDetections({
                detections: allDetections,
                isFromNvr: true,
                triggerTime,
                image,
            });
        } else if ([EventType.Contact, EventType.Doorbell, EventType.Doorlock].includes(eventType as EventType)) {
            await (this.currentMixinsMap[triggerDevice.name] as AdvancedNotifierSensorMixin)?.processEvent({
                triggered: true,
                isFromNvr: true,
                triggerTime,
                image,
            });
        } else if ([NvrEvent.Offline, NvrEvent.Online].includes(eventType as NvrEvent) &&
            cameraDevice.interfaces.includes(ScryptedInterface.Battery)) {
            logger.log(`Online/Offline notification for a battery camera. Skipping: ${JSON.stringify({
                cameraName,
                options,
                allDetections,
                eventType,
                triggerDevice,
            })}`);

            return;
        } else {
            if (eventType) {
                await this.notifyNvrEvent(
                    {
                        ...result,
                        cameraDevice,
                        triggerTime
                    }
                );
            } else {
                logger.log(`Notification coming from NVR not mapped yet: ${JSON.stringify({
                    cameraName,
                    options,
                    allDetections,
                    eventType,
                    triggerDevice,
                })}`);
                if (devNotifier) {
                    (devNotifier as Notifier).sendNotification('Unmapped notification', {
                        body: JSON.stringify({
                            cameraName,
                            options,
                            allDetections,
                            eventType,
                            triggerDevice,
                        })
                    });
                }
            }
        }
    }

    public getLinkedCamera = async (deviceId: string) => {
        const device = systemManager.getDeviceById(deviceId) as unknown as DeviceInterface;
        const cameraDevice = await this.getCameraDevice(device);

        if (!device || !cameraDevice) {
            this.getLogger().log(`Camera device for ID ${deviceId} not found. Device found: ${!!device} and camera was found: ${!!cameraDevice}`);
        }

        return { device: cameraDevice, isDoorbell: this.doorbellDevices.includes(deviceId) };
    }

    public matchDetectionFound = async (props: {
        image?: MediaObject,
        match?: ObjectDetectionResult,
        rule: DetectionRule | TimelapseRule,
        logger: Console,
        eventType: EventType,
        triggerDeviceId: string,
        triggerTime: number,
    }) => {
        const {
            eventType,
            logger,
            triggerDeviceId,
            triggerTime,
            match,
            image,
            rule,
        } = props;
        const triggerDevice = systemManager.getDeviceById(triggerDeviceId) as unknown as DeviceInterface;
        const cameraDevice = await this.getCameraDevice(triggerDevice);

        const textKey = getTextKey({ eventType, classname: match?.className });

        if (rule.ruleType !== RuleType.Timelapse) {
            logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ match, rule })}`);
        }

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as Settings & ScryptedDeviceBase;
            const notifierSettings = await notifier.getSettings();

            if (rule.ruleType === RuleType.Detection) {
                this.notifyCamera({
                    triggerDevice,
                    cameraDevice,
                    notifierId,
                    time: triggerTime,
                    image,
                    detection: match,
                    source: NotificationSource.DETECTION,
                    textKey,
                    logger,
                    notifierSettings,
                    rule: rule as DetectionRule,
                }).catch(e => logger.log(`Error on notifier ${notifier.name}`, e));
            }
        }

        if (rule.ruleType === RuleType.Timelapse) {
            logger.debug(`Storing timelapse image for rule ${rule.name}: ${JSON.stringify({
                timestamp: triggerTime,
                id: this.id
            })}`);
            this.storeTimelapseFrame({
                imageMo: image,
                timestamp: triggerTime,
                device: cameraDevice,
                rule: rule as TimelapseRule
            }).catch(logger.log);
        }
    };

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        const props = {
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Advanced notifier',
            groupKey: 'homeassistantMetadata'
        };

        if (
            [ScryptedInterface.Camera, ScryptedInterface.VideoCamera,].some(int => mixinDeviceInterfaces.includes(int))
        ) {
            return new AdvancedNotifierCameraMixin(
                props,
                this
            );
        } else if (
            [ScryptedInterface.BinarySensor, ScryptedInterface.Lock].some(int => mixinDeviceInterfaces.includes(int))
        ) {
            return new AdvancedNotifierSensorMixin(
                props,
                this
            );
        } else if (mixinDeviceInterfaces.includes(ScryptedInterface.Notifier)) {
            return new AdvancedNotifierNotifierMixin(
                props,
                this
            );
        }
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }

    private getUrls(cameraId: string, time: number) {
        const serverId = this.storageSettings.getItem('serverId');
        const nvrUrl = this.storageSettings.getItem('nvrUrl');
        const scryptedToken = this.storageSettings.getItem('scryptedToken');

        const timelinePart = `#/timeline/${cameraId}?time=${time}&from=notification&serverId=${serverId}&disableTransition=true`;
        const haUrl = `/api/scrypted/${scryptedToken}/endpoint/@scrypted/nvr/public/${timelinePart}`
        const externalUrl = `${nvrUrl}/${timelinePart}`
        return { externalUrl: externalUrl, haUrl: `/scrypted_${scryptedToken}?url=${encodeURIComponent(haUrl)}` }
    }

    private getTriggerZone = (detection: ObjectDetectionResult, rule: DetectionRule) => {
        const { zones } = detection ?? {};
        let zone: string;
        if (rule?.whitelistedZones) {
            zone = detection?.zones?.find(zoneInner => rule.whitelistedZones.includes(zoneInner));
        } else {
            zone = zones?.[0];
        }

        return zone;
    }

    private async getNotificationText(
        props: {
            device: DeviceInterface,
            detectionTime: number,
            detection?: ObjectDetectionResult,
            notifierId: string,
            externalUrl?: string,
            textKey: string,
            rule?: DetectionRule,
            notifierSettings: Setting[],
        }
    ) {
        const { detection, detectionTime, notifierId, device, externalUrl, textKey, notifierSettings, rule } = props;
        const { label, className } = detection ?? {};

        const roomName = this.deviceRoomMap[device.id];

        let textToUse;
        if (rule?.customText) {
            textToUse = rule?.customText
        } else {
            const notifierSettingsByKey = keyBy(notifierSettings, 'key');
            textToUse = notifierSettingsByKey[`homeassistantMetadata:${textKey}`]?.value || this.storageSettings.getItem(textKey as any);
        }

        const classNameParsed = detectionClassesDefaultMap[className];
        const detectionTimeText = this.storageSettings.getItem(`notifier:${notifierId}:detectionTimeText` as any) || this.storageSettings.getItem('detectionTimeText');
        const detectionClassText = classNameParsed === DetectionClass.Person ? this.storageSettings.getItem('personText') :
            className === DetectionClass.Animal ? this.storageSettings.getItem('animalText') :
                className === DetectionClass.Vehicle ? this.storageSettings.getItem('vehicleText') :
                    className
        const time = eval(detectionTimeText.replace('${time}', detectionTime));

        const zone = this.getTriggerZone(detection, rule);

        return textToUse.toString()
            .replace('${time}', time)
            .replace('${nvrLink}', externalUrl ?? '')
            .replace('${person}', label ?? '')
            .replace('${plate}', label ?? '')
            .replace('${streamName}', label ?? '')
            .replace('${label}', label ?? '')
            .replace('${class}', detectionClassText ?? '')
            .replace('${zone}', zone ?? '')
            .replace('${room}', roomName ?? '');
    }

    async getNotifierData(props: {
        notifier: DeviceBase,
        rule?: DetectionRule | OccupancyRule | TimelapseRule,
        deviceSettings: Setting[],
        device: DeviceBase,
        triggerTime?: number,
        ignoreActions?: boolean,
        skipVideoAttach?: boolean,
        videoUrl?: string
    }) {
        const { notifier, rule, deviceSettings, triggerTime, device, videoUrl, ignoreActions, skipVideoAttach } = props;
        const { priority, actions } = rule ?? {};

        const { haUrl, externalUrl } = this.getUrls(device.id, triggerTime);

        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];
        if (actions) {
            haActions.push(...actions);
        }
        let haActionsToNotify: any[] = [];

        try {
            haActions.forEach(haAction => haActionsToNotify.push(JSON.parse(haAction)));
        } catch (e) {
            this.getLogger().log(`Error building ha actions: ${JSON.stringify({ haActions, actions })}.`, e);
        }
        let data: any = {};

        if (notifier.providerId === this.pushoverProviderId) {
            // message += '\n';
            // for (const stringifiedAction of haActions) {
            //     const { action, title } = JSON.parse(stringifiedAction);
            //     const { haActionUrl } = await getWebookUrls(action, logger);
            //     message += `<a href="${haActionUrl}">${title}</a>\n`;
            // }

            data.pushover = {
                timestamp: triggerTime,
                url: !videoUrl ? externalUrl : videoUrl,
                html: 1,
                priority: getPushoverPriority(priority)
            };
        } else if (notifier.providerId === this.haNotifiersProviderId) {
            data.ha = {
                url: videoUrl ?? haUrl,
                clickAction: videoUrl ?? haUrl,
                video: !skipVideoAttach ? videoUrl : undefined,
                actions: !ignoreActions ? haActionsToNotify : undefined
            }

        }

        return data;
    }

    async notifyCamera(props: NotifyCameraProps) {
        try {
            const {
                triggerDevice,
                cameraDevice,
                notifierId,
                time,
                image: imageParent,
                detection,
                textKey,
                source,
                logger,
                notifierSettings,
                rule,
                skipImage,
            } = props;

            const device = cameraDevice ?? await this.getCameraDevice(triggerDevice);

            if (!device) {
                logger.log(`There is no camera linked to the device ${triggerDevice.name}`);
                return;
            }

            const deviceSettings = await device.getSettings();
            const notifier = systemManager.getDeviceById(notifierId) as unknown as (Notifier & ScryptedDevice);

            const { externalUrl } = this.getUrls(device.id, time);

            let message = await this.getNotificationText({
                detection,
                externalUrl,
                detectionTime: time,
                notifierId,
                textKey,
                device: triggerDevice,
                notifierSettings,
                rule,
            });

            const notifierSnapshotScale = this.storageSettings.getItem(`notifier:${notifierId}:snapshotScale` as any) ?? 1;
            const cameraSnapshotHeight = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotHeight')?.value as number) ?? 720;
            const cameraSnapshotWidth = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:snapshotWidth')?.value as number) ?? 1280;

            const { image } = !skipImage ? await this.getCameraSnapshot({
                cameraDevice: device,
                snapshotHeight: cameraSnapshotHeight * notifierSnapshotScale,
                snapshotWidth: cameraSnapshotWidth * notifierSnapshotScale,
                image: notifierSnapshotScale === 1 ? imageParent : undefined,
            }) : {};


            let title = (triggerDevice ?? device).name;

            const zone = this.getTriggerZone(detection, rule);
            if (zone) {
                title += ` (${zone})`;
            }

            const notifierData = await this.getNotifierData({
                device,
                deviceSettings,
                notifier,
                rule,
                triggerTime: time
            });

            const notifierOptions: NotifierOptions = {
                body: message,
                data: notifierData
            }

            logger.log(`Finally sending notification ${time} to ${notifier.name}. ${JSON.stringify({
                notifierOptions,
                source,
                title,
                message,
                rule,
                detection,
            })}`);

            await notifier.sendNotification(title, notifierOptions, image, undefined);
        } catch (e) {
            this.getLogger().log('Error in notifyCamera', e);
        }
    }

    async executeNotificationTest() {
        const logger = this.getLogger();
        try {
            const testDevice = this.storageSettings.getItem('testDevice') as DeviceInterface;
            const testNotifier = this.storageSettings.getItem('testNotifier') as DeviceInterface;
            const textKey = this.storageSettings.getItem('testMessage') as string;
            const testPriority = this.storageSettings.getItem('testPriority') as NotificationPriority;

            if (testDevice && textKey && testNotifier) {
                const currentTime = new Date().getTime();
                const testNotifierId = testNotifier.id
                const notifierSettings = await testNotifier.getSettings();

                logger.log(`Sending test notification to ${testNotifier.name} - ${testDevice.name} with key ${textKey}}`);

                this.notifyCamera({
                    triggerDevice: testDevice,
                    notifierId: testNotifierId,
                    time: currentTime,
                    textKey,
                    detection: { label: 'Familiar' } as ObjectDetectionResult,
                    source: NotificationSource.TEST,
                    logger,
                    notifierSettings,
                    rule: { priority: testPriority } as DetectionRule
                })
            }
        } catch (e) {
            logger.log('Error in executeNotificationTest', e);
        }
    }

    async getCameraDevice(device: DeviceInterface) {
        const deviceType = device.type;
        const deviceId = device.id;
        const isCamera = [ScryptedDeviceType.Camera, ScryptedDeviceType.Doorbell].includes(deviceType);

        if (isCamera) {
            return device;
        }

        const linkedCameraId = this.deviceVideocameraMap[deviceId];
        return systemManager.getDeviceById(linkedCameraId) as unknown as DeviceInterface;
    }

    private async getCameraSnapshot(props: {
        cameraDevice: DeviceInterface,
        snapshotWidth: number,
        snapshotHeight: number,
        image?: MediaObject,
    }) {
        const { cameraDevice, snapshotWidth, snapshotHeight, image: imageParent } = props;

        let image = imageParent;

        if (!image) {
            try {
                image = await cameraDevice.takePicture({
                    reason: 'event',
                    picture: {
                        height: snapshotHeight,
                        width: snapshotWidth,
                    },
                });
            } catch (e) {
                this.getLogger().log('Error taking a picture', e);
            }
        }

        let imageBuffer = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');

        const b64Image = imageBuffer.toString('base64');

        return { image, b64Image };
    }

    async getAllActiveDevices() {
        const activeDevicesForNotifications = this.storageSettings.getItem('activeDevicesForNotifications') as string[];
        const activeDevicesForReporting = this.storageSettings.getItem('activeDevicesForReporting') as string[];

        const allActiveDevicesForNotifications = [...activeDevicesForNotifications];

        const allActiveDevices: string[] = [];
        allActiveDevicesForNotifications.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));
        activeDevicesForReporting.forEach(device => !allActiveDevices.includes(device) && allActiveDevices.push(device));

        const notifiers = this.storageSettings.getItem('notifiers') as string[];

        return {
            allActiveDevices,
            allActiveDevicesForNotifications,
            activeDevicesForNotifications,
            activeDevicesForReporting,
            notifiers
        }
    }

    public storeImage: StoreImageFn = async (props) => {
        const { device, name, timestamp, imageMo } = props;
        const { imagesPath, imagesRegex } = this.storageSettings.values;

        if (imagesPath) {
            const savePath = path.join(imagesPath, device.name);

            if (!fs.existsSync(savePath)) {
                fs.mkdirSync(savePath, { recursive: true });
            }

            const filename = imagesRegex
                .replace('${name}', name)
                .replace('${timestamp}', timestamp);

            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(path.join(savePath, `${filename}.jpg`), jpeg);
        }
    }

    private getTimelapseFolder = (props: {
        ruleName: string,
    }) => {
        let { imagesPath } = this.storageSettings.values;
        if (!imagesPath) {
            imagesPath = process.env.SCRYPTED_PLUGIN_VOLUME;
        }

        const { ruleName } = props;
        const timelapsePath = path.join(imagesPath, 'timelapses', ruleName);
        const framesPath = path.join(timelapsePath, 'frames');
        const generatedPath = path.join(timelapsePath, 'generated');

        return {
            timelapsePath,
            framesPath,
            generatedPath,
        };
    }

    public storeTimelapseFrame = async (props: {
        rule: TimelapseRule,
        timestamp: number,
        device: ScryptedDeviceBase,
        imageMo: MediaObject
    }) => {
        const { rule, timestamp, imageMo } = props;
        const { imagesPath } = this.storageSettings.values;

        if (imagesPath) {
            const { framesPath } = this.getTimelapseFolder({ ruleName: rule.name });

            if (!fs.existsSync(framesPath)) {
                fs.mkdirSync(framesPath, { recursive: true });
            }

            const jpeg = await mediaManager.convertMediaObjectToBuffer(imageMo, 'image/jpeg');
            await fs.promises.writeFile(path.join(framesPath, `${timestamp}.jpg`), jpeg);
        }
    }

    public timelapseRuleStarted = async (props: {
        rule: TimelapseRule,
        logger: Console,
        device: ScryptedDeviceBase,
    }) => {
        const { device, rule, logger } = props;

        const isAlreadyRunning = rule.currentlyActive;

        if (!isAlreadyRunning) {
            logger.log(`Clearing frames for rule ${rule.name}.`);
            this.clearFramesData({
                device,
                logger,
                rule,
            }).catch(logger.log);

            const { currentlyActiveKey } = getTimelapseRuleKeys(rule.name);
            this.currentMixinsMap[device.name].putMixinSetting(currentlyActiveKey, 'true');
        }
    }

    public clearFramesData = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console
    }) => {
        const { rule, logger } = props;
        const { framesPath } = this.getTimelapseFolder({ ruleName: rule.name });

        fs.rmSync(framesPath, { recursive: true, force: true });
        logger.log(`Folder ${framesPath} removed`);
    }

    public timelapseRuleEnded = async (props: {
        rule: TimelapseRule,
        device: ScryptedDeviceBase,
        logger: Console,
    }) => {
        const { device, rule, logger } = props;
        const { currentlyActiveKey } = getTimelapseRuleKeys(rule.name);
        this.currentMixinsMap[device.name].putMixinSetting(currentlyActiveKey, 'false');
        const { imagesPath } = this.storageSettings.values;

        if (imagesPath) {
            try {
                const { timelapsePath, framesPath, generatedPath } = this.getTimelapseFolder({ ruleName: rule.name });
                const listPath = path.join(timelapsePath, 'file_list.txt');

                const timelapseName = `${getNowFriendlyDate()}.mp4`;
                const outputFile = path.join(generatedPath, timelapseName);

                const files = fs.readdirSync(framesPath);
                const sortedFiles = files
                    .sort((a, b) => parseInt(a) - parseInt(b));
                const fileListContent = sortedFiles
                    .map(file => `file '${path.join(framesPath, file)}'`)
                    .join('\n');
                fs.writeFileSync(listPath, fileListContent);

                if (!fs.existsSync(generatedPath)) {
                    fs.mkdirSync(generatedPath, { recursive: true });
                }

                const ffmpegArgs = [
                    '-loglevel', 'error',
                    '-f', 'concat',
                    '-safe', '0',
                    '-r', `${rule.timelapseFramerate}`,
                    '-i', listPath,
                    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-y',
                    outputFile
                ];

                logger.log(`Generating timelapse ${rule.name} with arguments: ${ffmpegArgs}`);

                const cp = child_process.spawn(await sdk.mediaManager.getFFmpegPath(), ffmpegArgs, {
                    stdio: 'inherit',
                });
                await once(cp, 'exit');

                await this.notifyTimelapse({
                    cameraDevice: device as DeviceInterface,
                    timelapseName,
                    rule
                });
            } catch (e) {
                logger.log('Error generating timelapse', e);
            }
        }
    }
}

