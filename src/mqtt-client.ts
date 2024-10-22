import { connect, Client } from 'mqtt';
import { DeviceType } from './types';
import { ObjectDetectionResult, ScryptedDeviceBase, Setting } from '@scrypted/sdk';

interface MqttEntity {
    entity: 'triggered' | 'image' | 'classname' | 'zones' | 'label' | 'lastTrigger';
    domain: 'sensor' | 'binary_sensor' | 'image';
    isMainEntity?: boolean;
    deviceClass?: string;
}

const mqttEntities: MqttEntity[] = [
    { entity: 'triggered', domain: 'binary_sensor', isMainEntity: true },
    { entity: 'image', domain: 'image' },
    { entity: 'classname', domain: 'sensor' },
    { entity: 'zones', domain: 'sensor' },
    { entity: 'label', domain: 'sensor' },
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

        this.console.log(`[${device.name}] Publishing ${topic}`);
        this.getMqttClient().publish(topic, value, { retain: true });
    }

    private getMqttTopicTopics(device: ScryptedDeviceBase) {
        const deviceId = device.id;

        const getEntityTopic = (entity: string) => `scrypted/homeassistantUtilities/${deviceId}/${entity}`;
        const getInfoTopic = (entity: string,) => `${getEntityTopic(entity)}/info`;
        const getDiscoveryTopic = (domain: string, entity: string) => `homeassistant/${domain}/scrypted-homeassistant-utilities-${deviceId}/${entity}/config`;

        return {
            getEntityTopic,
            getDiscoveryTopic,
            getInfoTopic,
        }
    }

    setupDeviceAutodiscovery(device: ScryptedDeviceBase, name: string, deviceSettings: Setting[]) {
        const id = device.id;

        if (this.autodiscoveryPublishedMap[id]) {
            return;
        }

        const haDeviceClass = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haDeviceClass')?.value as string;
        const mqttdevice = {
            ids: `scrypted-ha-utilities-${id}`,
            name: `Scrypted HA utilities ${name}`
        };

        mqttEntities.forEach(mqttEntity => {
            const { getDiscoveryTopic, getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);
            const { domain, entity, isMainEntity: mainEntity, deviceClass } = mqttEntity;

            const config: any = {
                json_attributes_topic: mainEntity ? getInfoTopic(entity) : undefined,
                json_attributes_template: mainEntity ? '{{ value_json | tojson }}' : undefined,
                dev: mqttdevice,
                unique_id: `scrypted-ha-utilities-${entity}-${id}`,
                name: entity.charAt(0).toUpperCase() + entity.slice(1),
                object_id: `${mqttdevice.ids}_${entity}`,
                device_class: mainEntity ? haDeviceClass : deviceClass
            };

            if (domain === 'binary_sensor') {
                config.payload_on = 'true';
                config.payload_off = 'false';
                config.state_topic = getEntityTopic(entity);
            }
            if (domain === 'image') {
                // config.url_topic = getEntityTopic(entity);
                config.image_topic = getEntityTopic(entity);
                config.content_type = 'image/jpg';
            }
            if (domain === 'sensor') {
                config.state_topic = getEntityTopic(entity);
            }

            this.publish(device, getDiscoveryTopic(domain, entity), JSON.stringify(config));
        })

        this.autodiscoveryPublishedMap[id] = true;
    }

    publishDeviceState(device: ScryptedDeviceBase, triggered: boolean, info?: {
        imageUrl: string,
        localImageUrl: string,
        scryptedUrl: string,
        detection: ObjectDetectionResult,
        triggerTime: number
    }) {
        try {
            (!triggered ? mqttEntities.filter(entity => entity.entity === 'triggered') : mqttEntities).forEach(mqttEntity => {
                const { getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);
                const { entity, isMainEntity: mainEntity } = mqttEntity;

                let value: any = triggered;
                switch (entity) {
                    case 'image': {
                        value = info?.imageUrl;
                        break;
                    }
                    case 'lastTrigger': {
                        value = new Date(info?.triggerTime).toISOString();
                        break;
                    }
                    case 'classname': {
                        value = info?.detection?.className;
                        break;
                    }
                    case 'label': {
                        value = info?.detection?.label ?? 'none';
                        break;
                    }
                    case 'triggered': {
                        value = triggered;
                        break;
                    }
                    case 'zones': {
                        value = (info?.detection?.zones || []);
                        if (!value.length) value.push('none');
                        value = value.toString();
                        break;
                    }
                }

                this.publish(device, getEntityTopic(entity), value);
                mainEntity && info && this.publish(device, getInfoTopic(entity), info);
            })
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