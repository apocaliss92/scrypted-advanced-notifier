import sdk, { DeviceBase, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, MediaObject, MixinProvider, Notifier, NotifierOptions, ObjectDetectionResult, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import axios from "axios";
import { isEqual, keyBy, sortBy, uniq } from 'lodash';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DeviceInterface, NotificationSource, getWebooks, getTextSettings, getTextKey, EventType, detectionRulesKey, getDetectionRulesSettings, DetectionRule, getElegibleDevices, deviceFilter, notifierFilter, ADVANCED_NOTIFIER_INTERFACE, parseNvrNotificationMessage, NotificationPriority, getFolderPaths, getDeviceRules, NvrEvent, ParseNotificationMessageResult, getPushoverPriority, getDetectionRuleKeys, enabledRegex } from "./utils";
import { AdvancedNotifierCameraMixin } from "./cameraMixin";
import { AdvancedNotifierSensorMixin } from "./sensorMixin";
import { AdvancedNotifierNotifierMixin } from "./notifierMixin";
import { DetectionClass, detectionClassesDefaultMap } from "./detecionClasses";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { getMqttTopicTopics, getRuleStrings, setupPluginAutodiscovery, subscribeToMqttTopics } from "./mqtt-utils";
import path from 'path';
import { AdvancedNotifierNotifier } from "./notifier";

const { systemManager } = sdk;
const defaultNotifierNativeId = 'advancedNotifierDefaultNotifier';
const nvrAcceleratedMotionSensorId = sdk.systemManager.getDeviceById('@scrypted/nvr', 'motion')?.id;

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
    private firstCheckAlwaysActiveDevices = false;
    public currentMixinsMap: Record<string, AdvancedNotifierCameraMixin | AdvancedNotifierSensorMixin> = {};
    private haProviderId: string;
    private pushoverProviderId: string;
    private refreshDeviceLinksInterval: NodeJS.Timeout;
    defaultNotifier: AdvancedNotifierNotifier;
    nvrRules: DetectionRule[] = [];

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
        domains: {
            group: 'Base',
            subgroup: 'Homeassistant',
            title: 'Entity regex patterns',
            description: 'Regex to filter out entities fetched',
            type: 'string',
            multiple: true,
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
        fetchedEntities: {
            group: 'Metadata',
            title: '',
            subgroup: 'Entities',
            multiple: true,
        },
        fetchedRooms: {
            group: 'Metadata',
            title: '',
            subgroup: 'Rooms',
            multiple: true,
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
    });


    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Advanced notifier'
        });

        (async () => {
            await sdk.deviceManager.onDeviceDiscovered(
                {
                    name: 'Advanced notifier NVR notifier',
                    nativeId: defaultNotifierNativeId,
                    interfaces: [ScryptedInterface.Notifier],
                    type: ScryptedDeviceType.Notifier,
                },
            );
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
        await this.mqttClient?.disconnect();
    }

    async start() {
        try {
            await this.initPluginSettings();
            await this.refreshDevicesLinks();
            await this.setupMqttEntities();

            this.refreshDeviceLinksInterval = setInterval(async () => await this.refreshDevicesLinks(), 10000);
        } catch (e) {
            this.getLogger().log(`Error in initFLow`, e);
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const decodedUrl = decodeURIComponent(request.url);
        const [_, __, ___, ____, _____, webhook, deviceNameOrAction] = decodedUrl.split('/');
        try {
            const { lastSnapshot, haAction } = await getWebooks();

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

                if (isWebhookEnabled) {
                    // response.send(`${JSON.stringify(this.storageSettings.getItem('deviceLastSnapshotMap'))}`, {
                    //     code: 404,
                    // });
                    // return;
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
        const allRules: DetectionRule[] = [];
        const { allPluginRules } = getDeviceRules({ mainPluginStorage: mainSettingsByKey });
        allRules.push(...allPluginRules);

        const allDevices = getElegibleDevices();
        for (const device of allDevices) {
            const deviceSettings = await device.getSettings();
            const deviceSettingsByKey = keyBy(deviceSettings, 'key');
            const { allDeviceRules } = getDeviceRules({
                mainPluginStorage: mainSettingsByKey,
                deviceId: device.id,
                deviceType: device.type,
                deviceStorage: deviceSettingsByKey
            });
            allRules.push(...allDeviceRules);
        }

        await setupPluginAutodiscovery({
            mqttClient,
            people: knownPeople,
            console: logger,
            detectionRules: allRules,
        });

        return { allRules };
    }

    async putSetting(key: string, value: SettingValue, skipMqtt?: boolean): Promise<void> {
        if (!skipMqtt) {
            const enabledResult = enabledRegex.exec(key);
            if (enabledResult) {
                const ruleName = enabledResult[1];
                this.updateRuleOnMqtt({ active: value as boolean, ruleName, logger: this.getLogger() })
            }
        }

        return this.storageSettings.putSetting(key, value);
    }

    async updateRuleOnMqtt(props: { deviceId?: string, active: boolean, ruleName: string, logger: Console }) {
        const { active, ruleName, deviceId, logger } = props;
        const mqttClient = await this.getMqttClient();
        const { entityId, ruleDeviceId } = getRuleStrings({ name: ruleName, deviceId } as DetectionRule);

        const { getEntityTopic } = getMqttTopicTopics(ruleDeviceId);
        const stateTopic = getEntityTopic(entityId);
        logger.log(`Setting rule ${ruleName} to ${active} for device ${deviceId}`);
        await mqttClient.publish(stateTopic, active ? 'ON' : 'OFF');
    }

    private async setupMqttEntities() {
        const { mqttEnabled, mqttActiveEntitiesTopic } = this.storageSettings.values;
        if (mqttEnabled) {
            try {
                const mqttClient = await this.getMqttClient();
                const { allRules } = await this.sendAutoDiscovery();
                const logger = this.getLogger();

                this.getLogger().log(`Subscribing to mqtt topics`);
                await subscribeToMqttTopics({
                    entitiesActiveTopic: mqttActiveEntitiesTopic,
                    mqttClient,
                    detectionRules: allRules,
                    activeEntitiesCb: async (message) => {
                        logger.log(`Received update for ${mqttActiveEntitiesTopic} topic: ${JSON.stringify(message)}`);
                        await this.syncHaEntityIds(message);
                    },
                    ruleCb: async ({ active, ruleName, deviceId }) => {
                        const { enabledKey } = getDetectionRuleKeys(ruleName);
                        if (!deviceId) {
                            logger.log(`Setting rule ${ruleName} to ${active}`);
                            await this.putSetting(enabledKey, active, true);
                        } else {
                            const device = sdk.systemManager.getDeviceById<Settings>(deviceId);
                            logger.log(`Setting rule ${ruleName} for device ${device.name} to ${active}`);
                            await device.putSetting(`homeassistantMetadata:${enabledKey}`, active);
                        }
                    }
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

        const localIp = (await sdk.endpointManager.getLocalAddresses())[0];
        this.putSetting('localIp', localIp);
        logger.log(`Local IP found: ${localIp}`);

        const pushoverPlugin = systemManager.getDeviceByName('Pushover Plugin') as unknown as ScryptedDeviceBase;
        const haPlugin = systemManager.getDeviceByName('Notify Service') as unknown as ScryptedDeviceBase;

        this.haProviderId = haPlugin?.id
        this.pushoverProviderId = pushoverPlugin?.id
        logger.log(`HA providerId: ${this.haProviderId} and Pushover providerId: ${this.pushoverProviderId}`);
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
                    const room = settings.find(setting => setting.key === 'homeassistantMetadata:room')?.value as string;
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

            const sensorsNotMapped = allDevices.filter(device => device.type === ScryptedDeviceType.Sensor && !deviceVideocameraMap[device.id])
                .map(sensor => sensor.name);

            if (sensorsNotMapped.length && !this.firstCheckAlwaysActiveDevices) {
                logger.log(`Following binary sensors are not mapped to any camera yet: ${sensorsNotMapped}`);
            }

            const mainSettings = await this.getSettings();
            const mainSettingsByKey = keyBy(mainSettings, 'key');
            const { nvrRules } = getDeviceRules({ mainPluginStorage: mainSettingsByKey });
            this.nvrRules = nvrRules;

            this.deviceHaEntityMap = deviceHaEntityMap;
            this.haEntityDeviceMap = haEntityDeviceMap;
            this.deviceVideocameraMap = deviceVideocameraMap;
            this.videocameraDevicesMap = videocameraDevicesMap;
            this.deviceRoomMap = deviceRoomMap;
            this.doorbellDevices = doorbellDevices;
            this.firstCheckAlwaysActiveDevices = true;

            if (this.storageSettings.values.mqttEnabled) {
                await this.sendAutoDiscovery();
            }
        } catch (e) {
            logger.log('Error in refreshDevicesLinks', e);
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

        let rooms: string[] = [];
        let entityIds: string[] = [];

        try {
            const haApi = await this.getHaApi();
            const roomsResponse = await haApi.getTemplateData("{{ areas() }}");

            const getRoomName = async (areaId: string) => {
                return await haApi.getTemplateData(`{{ area_name('${areaId}') }}`);
            }

            const entitiesResponse = await haApi.getStatesDate();
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
            this.getLogger().log(e);
        } finally {
            this.getLogger().log(`Entities found: ${JSON.stringify(entityIds)}`);
            this.getLogger().log(`Rooms found: ${JSON.stringify(rooms)}`);
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

    async notifyNvrEvent(props: ParseNotificationMessageResult & { cameraDevice: DeviceInterface, triggerTime: number }) {
        const { eventType, textKey, triggerDevice, cameraDevice, triggerTime, label } = props;
        const logger = this.getLogger();
        const notifiers = uniq(this.nvrRules.filter(rule => rule.nvrEvents.includes(eventType as NvrEvent)).flatMap(rule => rule.notifiers));

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
                triggerTime
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

        // logger.log(`NVR notification received: ${JSON.stringify({ cameraName, options })}`)

        if (eventType === EventType.ObjectDetection) {
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
        } else {
            if (result.eventType) {
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
        rule: DetectionRule,
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
        logger.log(`${rule.notifiers.length} notifiers will be notified: ${JSON.stringify({ match, rule })}`);

        for (const notifierId of rule.notifiers) {
            const notifier = systemManager.getDeviceById(notifierId) as unknown as Settings & ScryptedDeviceBase;
            const notifierSettings = await notifier.getSettings();

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
                rule,
            }).catch(e => logger.log(`Error on notifier ${notifier.name}`, e));
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
        rule?: DetectionRule
        deviceSettings: Setting[],
        device: DeviceBase,
        triggerTime: number,
    }) {
        const { notifier, rule, deviceSettings, triggerTime, device } = props;
        const { priority, actions } = rule ?? {};

        const { haUrl, externalUrl } = this.getUrls(device.id, triggerTime);

        const haActions = (deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haActions')?.value as string[]) ?? [];
        if (actions) {
            haActions.push(...actions);
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
                url: externalUrl,
                html: 1,
                priority: getPushoverPriority(priority)
            };
        } else if (notifier.providerId === this.haProviderId) {
            data.ha = {
                url: haUrl,
                clickAction: haUrl,
                actions: haActions.length ? haActions.map(action => JSON.parse(action)) : undefined
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
}

