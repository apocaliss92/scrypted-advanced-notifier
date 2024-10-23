import { connect, Client } from 'mqtt';
import sdk, { MediaObject, ObjectDetectionResult, ScryptedDeviceBase, Setting } from '@scrypted/sdk';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | 'lastTrigger';
    domain: 'sensor' | 'binary_sensor' | 'camera';
    isMainEntity?: boolean;
    deviceClass?: string;
}

const mqttEntities: MqttEntity[] = [
    { entity: 'triggered', domain: 'binary_sensor', isMainEntity: true },
    { entity: 'lastImage', domain: 'camera' },
    { entity: 'lastClassname', domain: 'sensor' },
    { entity: 'lastZones', domain: 'sensor' },
    { entity: 'lastLabel', domain: 'sensor' },
    { entity: 'lastTrigger', domain: 'sensor', deviceClass: 'timestamp' },
]

export default class MqttClient {
    mqttClient: Client;
    autodiscoveryPublishedMap: Record<string, boolean> = {};
    mqttPathmame: string;
    host: string;
    username: string;
    password: string;
    console: Console;

    constructor(host: string, username: string, password: string, console: Console) {
        this.host = host;
        this.username = username;
        this.password = password;
        this.console = console;
    }

    getMqttClient() {
        if (!this.mqttClient) {
            const url = this.host;
            const urlWithoutPath = new URL(url);
            urlWithoutPath.pathname = '';

            this.mqttPathmame = urlWithoutPath.toString();
            if (!this.mqttPathmame.endsWith('/')) {
                this.mqttPathmame = `${this.mqttPathmame}/`;
            }
            this.mqttClient = connect(this.mqttPathmame, {
                rejectUnauthorized: false,
                username: this.username,
                password: this.password,
            });
            this.mqttClient.setMaxListeners(Infinity);

            this.mqttClient.on('connect', packet => {
                this.console.log('connected to mqtt', packet);
            })
        }

        return this.mqttClient;
    }

    publish(device: ScryptedDeviceBase, topic: string, value: any) {
        if (typeof value === 'object')
            value = JSON.stringify(value);
        if (value.constructor.name !== Buffer.name)
            value = value.toString();

        // this.console.log(`[${device.name}] Publishing ${topic}`);
        this.getMqttClient().publish(topic, value, { retain: true });
    }

    private getMqttTopicTopics(device: ScryptedDeviceBase) {
        const deviceId = device.id;

        const getEntityTopic = (entity: string) => `scrypted/homeassistantUtilities/${deviceId}/${entity}`;
        const getInfoTopic = (entity: string) => `${getEntityTopic(entity)}/info`;
        const getDiscoveryTopic = (domain: string, entity: string) => `homeassistant/${domain}/scrypted-homeassistant-utilities-${deviceId}/${entity}/config`;

        return {
            getEntityTopic,
            getDiscoveryTopic,
            getInfoTopic,
        }
    }

    private async findDeviceStreams(deviceSettings: Setting[], localIp: string) {
        const streams = deviceSettings.filter(setting => setting.key === 'prebuffer:rtspRebroadcastUrl');

        return streams.map(stream => ({ name: stream.subgroup.split(': ')[1], url: (stream.value as string)?.replace('localhost', localIp) }))
    }

    async setupDeviceAutodiscovery(device: ScryptedDeviceBase, name: string, deviceSettings: Setting[]) {
        const id = device.id;

        if (this.autodiscoveryPublishedMap[id]) {
            return;
        }

        const haDeviceClass = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haDeviceClass')?.value as string;
        const mqttdevice = {
            ids: `scrypted-ha-utilities-${id}`,
            name: `Scrypted HA utilities ${name}`
        };

        const { getDiscoveryTopic, getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);

        mqttEntities.forEach(mqttEntity => {
            const { domain, entity, isMainEntity: mainEntity, deviceClass } = mqttEntity;

            const config: any = {
                json_attributes_topic: mainEntity ? getInfoTopic(entity) : undefined,
                json_attributes_template: mainEntity ? '{{ value_json | tojson }}' : undefined,
                dev: mqttdevice,
                unique_id: `scrypted-ha-utilities-${id}-${entity}`,
                name: entity.charAt(0).toUpperCase() + entity.slice(1),
                object_id: `${name}_${entity}`,
                device_class: mainEntity ? haDeviceClass : deviceClass
            };
            const topic = getEntityTopic(entity);

            if (domain === 'binary_sensor') {
                config.payload_on = 'true';
                config.payload_off = 'false';
                config.state_topic = topic;
            }
            if (domain === 'camera') {
                config.topic = topic;
                config.image_encoding = 'b64';
            }
            if (domain === 'sensor') {
                config.state_topic = topic;
            }

            this.publish(device, getDiscoveryTopic(domain, entity), JSON.stringify(config));
        })

        // Add IP configuration
        // const localIp = (await sdk.endpointManager.getLocalAddresses())[0];
        // if (localIp) {
        //     const deviceStreams = await this.findDeviceStreams(deviceSettings, localIp);

        //     deviceStreams.map(stream => {
        //         const entity = stream.name.replace(/ /g,'');
        //         const config: any = {
        //             dev: mqttdevice,
        //             unique_id: `scrypted-ha-utilities-${id}-${entity}`,
        //             name: entity.charAt(0).toUpperCase() + entity.slice(1),
        //             object_id: `${name}_${entity}`,
        //             topic: getEntityTopic(entity)
        //         };

        //         this.publish(device, getDiscoveryTopic('camera', entity), JSON.stringify(config));
        //         this.publish(device, getEntityTopic(entity), stream.url);
        //     })
        // }

        this.autodiscoveryPublishedMap[id] = true;
    }

    async publishDeviceState(props: {
        device: ScryptedDeviceBase,
        deviceSettings: Setting[],
        triggered: boolean,
        info?: {
            imageUrl: string,
            localImageUrl: string,
            scryptedUrl: string,
            detection: ObjectDetectionResult,
            triggerTime: number,
            image: MediaObject
        }
    }) {
        const { device, triggered, info } = props;
        try {
            const entitiesToRun = triggered ? mqttEntities : mqttEntities.filter(entity => entity.entity === 'triggered');
            // this.console.log(`[${device.name}] Entities to publish: ${JSON.stringify(entitiesToRun)}`)
            for (const mqttEntity of entitiesToRun) {
                const { getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);
                const { entity, isMainEntity: mainEntity } = mqttEntity;

                let value: any = triggered;
                switch (entity) {
                    case 'lastImage': {
                        if (info?.image) {
                            const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(info.image, 'image/jpeg');
                            value = await buffer.toString('base64');
                        }
                        break;
                    }
                    case 'lastTrigger': {
                        value = new Date(info?.triggerTime).toISOString();
                        break;
                    }
                    case 'lastClassname': {
                        value = info?.detection?.className ?? 'motion';
                        break;
                    }
                    case 'lastLabel': {
                        value = info?.detection?.label ?? 'none';
                        break;
                    }
                    case 'triggered': {
                        value = triggered;
                        break;
                    }
                    case 'lastZones': {
                        value = (info?.detection?.zones || []);
                        if (!value.length) value.push('none');
                        value = value.toString();
                        break;
                    }
                }

                // this.console.log(`[${device.name}] Publishing ${value} to ${getEntityTopic(entity)}`)
                this.publish(device, getEntityTopic(entity), value);
                mainEntity && triggered && info && this.publish(device, getInfoTopic(entity), info);
            }
        } catch (e) {
            this.console.log(`[${device.name}] Error publishing`, e);
        }
    }

    subscribeToHaTopics(entitiesActiveTopic: string, cb?: (topic: string, entitiesActive: string[]) => void) {
        this.getMqttClient().subscribe([entitiesActiveTopic]);
        this.getMqttClient().on('message', (messageTopic, message) => {
            const messageString = message.toString();
            if (messageTopic === entitiesActiveTopic) {
                cb && cb(messageTopic, messageString !== 'null' ? JSON.parse(messageString) : []);
            }
        })
    }
}