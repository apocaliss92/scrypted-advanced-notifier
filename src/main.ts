import sdk, { ScryptedDeviceBase, ScryptedInterface, Setting, Settings } from "@scrypted/sdk";
import { camerasKey, peopleKey, intervalIdKey, ipsKey, mqttHostKey, mqttUsernameKey, mqttPasswordKey, KnownPersonResult, StreamInfo, CameraData } from "./types";
import { connect, Client } from 'mqtt';

const { systemManager } = sdk;

export default class ActiveStreamsConfig extends ScryptedDeviceBase implements Settings {
    mqttClient: Client;
    lastSetMap: { [topic: string]: any } = {};
    intervalId = new Date().getTime();
    autodiscoveryPublished = false;
    mqttPathmame: string;

    constructor(nativeId: string) {
        super(nativeId);

        this.start().catch(e => this.console.log(e));
    }

    async getSettings(): Promise<Setting[]> {
        const currentCameras = this.storage.getItem(camerasKey);
        const currentPeopleRaw = this.storage.getItem(peopleKey);
        const currentPeople = currentPeopleRaw ? currentPeopleRaw.split(',') : []

        const settings: Setting[] = [
            {
                key: intervalIdKey,
                type: 'string',
                title: 'Interval ID',
                readonly: true,
                value: this.storage.getItem(intervalIdKey)
            },
            {
                title: 'Host',
                group: 'MQTT',
                key: mqttHostKey,
                description: 'Specify the mqtt address.',
                placeholder: 'mqtt://192.168.1.100',
                value: this.storage.getItem(mqttHostKey)
            },
            {
                title: 'Username',
                group: 'MQTT',
                key: mqttUsernameKey,
                description: 'Specify the mqtt username.',
                value: this.storage.getItem(mqttUsernameKey)
            },
            {
                title: 'Password',
                group: 'MQTT',
                key: mqttPasswordKey,
                description: 'Specify the mqtt password.',
                type: 'password',
                value: this.storage.getItem(mqttPasswordKey)
            },
            {
                group: 'Tracked entities',
                key: camerasKey,
                type: 'device',
                title: 'Cameras',
                multiple: true,
                deviceFilter: `interfaces.includes("${ScryptedInterface.VideoCamera}")`,
                value: currentCameras ? currentCameras.split(',') : [],
            },
            {
                group: 'Tracked entities',
                key: peopleKey,
                type: 'string',
                title: 'People',
                multiple: true,
                value: currentPeople,
            }
        ];

        currentPeople.forEach(person => {
            const personIpsKey = `${ipsKey}:${person}`;
            const currentIps = this.storage.getItem(personIpsKey);
            settings.push({
                group: 'Tracked entities',
                key: personIpsKey,
                subgroup: person,
                type: 'string',
                title: `IPs`,
                multiple: true,
                value: currentIps ? currentIps.split(',') : [],
            })
        });

        return settings;
    }

    async putSetting(key: string, value: string) {
        this.storage.setItem(key, value.toString());
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    mapToStreamInfo(setting: Setting) {
        const fullIp = setting.subgroup.split(':');
        fullIp.pop();
        const ip = fullIp.join(':');
        return { camera: setting.group, ip };
    }

    private getMqttTopics({ cameraId, name }: { cameraId?: string, name?: string }) {
        let sensorTopic: string;
        let sensorInfoTopic: string;
        let autodiscoveryTopic: string;

        if (cameraId && !name) {
            sensorTopic = `scrypted/activeStreams/${cameraId}`;
            autodiscoveryTopic = `homeassistant/sensor/scrypted-active-streams-${cameraId}/ActiveStreams/config`;
        } else if (name && !cameraId) {
            sensorTopic = `scrypted/activeStreams/${name}`;
            autodiscoveryTopic = `homeassistant/sensor/scrypted-active-stream-${name}/ActiveStream/config`;
        } else if (name && cameraId) {
            sensorTopic = `scrypted/activeStreams/${cameraId}/${name}`;
            autodiscoveryTopic = `homeassistant/binary_sensor/scrypted-active-stream-${cameraId}-${name}/ActiveStream/config`;
        } else {
            sensorTopic = `scrypted/activeStreams`;
            autodiscoveryTopic = `homeassistant/sensor/scrypted-active-streams/ActiveStreams/config`;
        }

        sensorInfoTopic = `${sensorTopic}/info`;

        return {
            sensorTopic,
            sensorInfoTopic,
            autodiscoveryTopic
        }
    }

    private processMqttData({ cameraId, name, value, info }: { cameraId?: string, name?: string, value: any, info: any }) {
        const { sensorTopic, sensorInfoTopic } = this.getMqttTopics({ cameraId, name });
        const lastValue = this.lastSetMap[sensorTopic];
        if (lastValue !== value) {
            this.publish(sensorTopic, value);
            this.publish(sensorInfoTopic, info);
            this.lastSetMap[sensorTopic] = value;
        }
    }

    async processCamera(cameraId: string, settings: Setting[], activeStreamsConfigs: Setting[], isWhitelisted: boolean, knownPeople: string[]) {
        const camera = systemManager.getDeviceById(cameraId);
        const cameraName = camera.name;
        const cameraStreamsInformation = settings.filter(setting => setting.group === camera.name);

        const knownPeopleResult: KnownPersonResult[] = [];

        const activeClients = Number(cameraStreamsInformation.find(setting => setting.title === 'Active Streams')?.value ?? 0);

        for (const name of knownPeople) {
            const ips = (activeStreamsConfigs.find(setting => setting.key === `activeStreamsIps:${name}`)?.value ?? []) as string[];
            const personActiveStreams: StreamInfo[] = (cameraStreamsInformation
                .filter(setting => ips.some(ip => setting.subgroup?.startsWith(ip)) && setting.key === 'type') ?? [])
                .map(this.mapToStreamInfo);

            knownPeopleResult.push({
                cameraName,
                cameraId,
                person: name,
                settings: personActiveStreams
            })

            if (isWhitelisted) {
                const isPersonActive = !!personActiveStreams.length;
                this.processMqttData({ cameraId, name, value: isPersonActive, info: { streams: personActiveStreams } });
            }
        }

        if (isWhitelisted) {
            this.processMqttData({ cameraId, value: activeClients, info: { streams: knownPeopleResult.flatMap(elem => elem.settings) } });
        }

        return { activeClients, knownPeopleResult, cameraName };
    }

    private processMqttAutodiscovery(cameraData: CameraData[], whitelistedCameraIds: string[], knownPeople: string[]) {
        if (!this.autodiscoveryPublished) {
            for (const data of cameraData) {
                const { id: cameraId, name: cameraName } = data;
                if (whitelistedCameraIds.includes(cameraId)) {
                    for (const name of knownPeople) {
                        const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({ cameraId, name });
                        const config = {
                            state_topic: sensorTopic,
                            json_attributes_topic: sensorInfoTopic,
                            json_attributes_template: '{{ value_json | tojson }}',
                            payload_on: 'true',
                            payload_off: 'false',
                            dev: {
                                ids: `scrypted-activeStream-${cameraId}-${name}`,
                                name: `Active stream for ${cameraName} ${name}`
                            },
                            unique_id: `scrypted-active-stream-${cameraId}-${name}`,
                            name: `${cameraName} ${name} active`,
                        };
                        this.publish(autodiscoveryTopic, JSON.stringify(config));
                    }

                    const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({ cameraId });
                    const config = {
                        state_topic: sensorTopic,
                        json_attributes_topic: sensorInfoTopic,
                        json_attributes_template: '{{ value_json | tojson }}',
                        dev: {
                            ids: `scrypted-activeStreams-${cameraId}`,
                            name: `Active streams for ${cameraName}`
                        },
                        unique_id: `scrypted-active-streams-${cameraId}`,
                        name: `${cameraName} active streams`,
                    };
                    this.publish(autodiscoveryTopic, JSON.stringify(config));
                }
            }

            for (const name of knownPeople) {
                const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({ name });
                const config = {
                    state_topic: sensorTopic,
                    json_attributes_topic: sensorInfoTopic,
                    json_attributes_template: '{{ value_json | tojson }}',
                    dev: {
                        ids: `scrypted-activeStreams-${name}`,
                        name: `Active streams for ${name}`
                    },
                    unique_id: `scrypted-active-streams-${name}`,
                    name: `${name} active streams`,
                };
                this.publish(autodiscoveryTopic, JSON.stringify(config));
            }

            const { sensorTopic, autodiscoveryTopic, sensorInfoTopic } = this.getMqttTopics({});
            const config = {
                state_topic: sensorTopic,
                json_attributes_topic: sensorInfoTopic,
                json_attributes_template: '{{ value_json | tojson }}',
                dev: {
                    ids: `scrypted-activeStreams`,
                    name: `Active streams`
                },
                unique_id: `scrypted-active-streams`,
                name: `All active streams`,
            };
            this.publish(autodiscoveryTopic, JSON.stringify(config));

            this.autodiscoveryPublished = true;
        }
    }

    async start() {
        this.getMqttClient();
        await this.putSetting(intervalIdKey, JSON.stringify(this.intervalId));

        const currentInterval = setInterval(async () => {
            try {
                if (!this.mqttClient || !this.mqttClient.connected) {
                    return;
                }

                const activeStreamsConfigs = await this.getSettings();
                //this.console.log(`Active streams configs: ${JSON.stringify(activeStreamsConfigs, undefined, 2)}`);
                const currentIntervalId = Number(activeStreamsConfigs.find(setting => setting.key === intervalIdKey)?.value);
                const whitelistedCameraIds = (activeStreamsConfigs.find(setting => setting.key === camerasKey)?.value as string[]);
                const knownPeople = (activeStreamsConfigs.find(setting => setting.key === peopleKey)?.value ?? []) as string[];

                const cameraIds: string[] = [];

                Object.entries(systemManager.getSystemState()).forEach(([deviceId, device]) => {
                    if (device.interfaces.value.includes(ScryptedInterface.VideoCamera)) {
                        cameraIds.push(deviceId);
                    }
                })

                const cameraData: CameraData[] = [];
                const peopleData: { [person: string]: StreamInfo[] } = {};

                if (currentIntervalId && currentIntervalId > this.intervalId || !cameraIds || cameraIds.length === 0) {
                    this.console.log('Clearing interval because newer script is running');
                    clearInterval(currentInterval);
                } else {
                    let totalActiveStreams = 0;
                    const totalKnownPeopleResult: KnownPersonResult[] = [];

                    const adaptivePlugin = systemManager.getDeviceByName('Adaptive Streaming') as unknown as (Settings);
                    const settings = await adaptivePlugin.getSettings();

                    this.console.log(`All settings: ${JSON.stringify(settings, undefined, 2)}`);

                    for (const cameraId of cameraIds) {
                        const isWhitelisted = whitelistedCameraIds.includes(cameraId);
                        const { activeClients, knownPeopleResult, cameraName } = await this.processCamera(cameraId, settings, activeStreamsConfigs, isWhitelisted, knownPeople);
                        totalActiveStreams += activeClients;
                        totalKnownPeopleResult.push(...knownPeopleResult);

                        knownPeopleResult.forEach(elem => {
                            const { person, settings } = elem;
                            if (!peopleData[person]) {
                                peopleData[person] = [];
                            }

                            peopleData[person].push(...settings);
                        });

                        cameraData.push({ name: cameraName, id: cameraId, activeStreams: activeClients });
                    }

                    for (const person of knownPeople) {
                        const personStreams = peopleData[person] ?? [];
                        const activeClients = personStreams.length;
                        this.processMqttData({ name: person, value: activeClients, info: { streams: personStreams } });
                    }

                    this.processMqttData({
                        value: totalActiveStreams, info: {
                            streams: settings
                                .filter(setting => setting.key === 'type')
                                .map(this.mapToStreamInfo)
                        }
                    });

                    this.processMqttAutodiscovery(cameraData, whitelistedCameraIds, knownPeople)
                }
            } catch (e) {
                clearInterval(currentInterval);
                this.console.log(e);
            }
        }, 10000);
    }

    async getMqttClient() {
        if (!this.mqttClient) {
            const url = this.storage.getItem(mqttHostKey);
            const urlWithoutPath = new URL(url);
            urlWithoutPath.pathname = '';

            this.mqttPathmame = urlWithoutPath.toString();
            if (!this.mqttPathmame.endsWith('/')) {
                this.mqttPathmame = `${this.mqttPathmame}/`;
            }
            this.mqttClient = connect(this.mqttPathmame, {
                rejectUnauthorized: false,
                username: this.storage.getItem(mqttUsernameKey) || undefined,
                password: this.storage.getItem(mqttPasswordKey) || undefined,
            });
            this.mqttClient.setMaxListeners(Infinity);

            this.mqttClient.on('connect', packet => {
                this.console.log('connected to mqtt', packet);
            })
        }

        return this.mqttClient;
    }

    async publish(topic: string, value: any) {
        if (typeof value === 'object')
            value = JSON.stringify(value);
        if (value.constructor.name !== Buffer.name)
            value = value.toString();

        this.console.log(`Publishing ${value} to ${topic}`);
        (await this.getMqttClient()).publish(topic, value, { retain: true });
    }
}
