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
];

export default class MqttClient {
    mqttClient: Client;
    autodiscoveryPublishedMap: Record<string, boolean> = {};
    mqttPathmame: string;
    host: string;
    username: string;
    password: string;
    console: Console;

    constructor(host: string, username: string, password: string) {
        this.host = host;
        this.username = username;
        this.password = password;
    }

    async disconnect() {
        return new Promise((r, f) => {
            if (this.mqttClient) {
                try {
                    this.mqttClient.end(false, undefined, () => r(true))
                } catch (e) {
                    f(e);
                }
            } else {
                r(true);
            }
        });
    }

    getMqttClient(console: Console) {
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

            this.mqttClient.on('connect', data => {
                console.log('connected to mqtt', JSON.stringify(data));
            })
        }

        return this.mqttClient;
    }

    publish(console: Console, topic: string, value: any, retain = true) {
        if (typeof value === 'object')
            value = JSON.stringify(value);
        if (value.constructor.name !== Buffer.name)
            value = value.toString();

        // console.debug(`Publishing ${JSON.stringify({ topic, value })}`);
        this.getMqttClient(console).publish(topic, value, { retain });
    }

    private getMqttTopicTopics(device: ScryptedDeviceBase) {
        const deviceId = device.id;

        const getEntityTopic = (entity: string) => `scrypted/homeassistantUtilities/${deviceId}/${entity}`;
        const getInfoTopic = (entity: string) => `${getEntityTopic(entity)}/info`;
        const getDiscoveryTopic = (domain: MqttEntity['domain'], entity: string) => `homeassistant/${domain}/scrypted-homeassistant-utilities-${deviceId}/${entity}/config`;

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

    private getLastDetectionTopics(detectionClass: string) {
        const timeEntity = `${detectionClass}LastDetection`;
        const imageEntity = `${detectionClass}LastDetectionImage`;

        return { timeEntity, imageEntity }
    }

    async setupDeviceAutodiscovery(props: {
        device: ScryptedDeviceBase,
        deviceSettings: Setting[],
        detectionClasses: string[],
        console: Console,
        localIp: string,
    }) {
        const { detectionClasses, device, deviceSettings, console, localIp } = props;
        const { name, id } = device;

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

            this.publish(console, getDiscoveryTopic(domain, entity), JSON.stringify(config));
        })

        // Add IP configuration
        if (localIp) {
            const deviceStreams = await this.findDeviceStreams(deviceSettings, localIp);
            console.debug(`Streams found: ${JSON.stringify(deviceStreams)}`);

            deviceStreams.map(stream => {
                const entity = stream.name.replace(/ /g, '');
                const config: any = {
                    dev: mqttdevice,
                    unique_id: `scrypted-ha-utilities-${id}-${entity}`,
                    name: entity.charAt(0).toUpperCase() + entity.slice(1),
                    object_id: `${name}_${entity}`,
                    state_topic: getEntityTopic(entity)
                };

                this.publish(console, getDiscoveryTopic('sensor', entity), JSON.stringify(config));
                this.publish(console, getEntityTopic(entity), stream.url);
            })
        }

        detectionClasses.map(detectionClass => {
            const { imageEntity, timeEntity } = this.getLastDetectionTopics(detectionClass);

            const timeConfig: any = {
                dev: mqttdevice,
                unique_id: `scrypted-ha-utilities-${id}-${timeEntity}`,
                name: timeEntity.charAt(0).toUpperCase() + timeEntity.slice(1),
                object_id: `${name}_${timeEntity}`,
                device_class: 'timestamp',
                state_topic: getEntityTopic(timeEntity)
            };

            const imageConfig: any = {
                dev: mqttdevice,
                unique_id: `scrypted-ha-utilities-${id}-${imageEntity}`,
                name: imageEntity.charAt(0).toUpperCase() + imageEntity.slice(1),
                object_id: `${name}_${imageEntity}`,
                topic: getEntityTopic(imageEntity),
                image_encoding: 'b64',
            };

            this.publish(console, getDiscoveryTopic('sensor', timeEntity), JSON.stringify(timeConfig));
            this.publish(console, getDiscoveryTopic('camera', imageEntity), JSON.stringify(imageConfig));
        })

        this.autodiscoveryPublishedMap[id] = true;
    }

    async publishDeviceState(props: {
        device: ScryptedDeviceBase,
        console: Console,
        triggered: boolean,
        info?: {
            scryptedUrl: string,
            detection: ObjectDetectionResult,
            triggerTime: number,
            b64Image: string
        }
    }) {
        const { device, triggered, info, console } = props;
        try {
            const entitiesToRun = triggered ? mqttEntities : mqttEntities.filter(entity => entity.entity === 'triggered');
            console.debug(`Entities to publish: ${JSON.stringify(entitiesToRun)}`)
            for (const mqttEntity of entitiesToRun) {
                const { getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);
                const { entity, isMainEntity: mainEntity } = mqttEntity;

                let value: any = triggered;
                switch (entity) {
                    case 'lastImage': {
                        if (info?.b64Image) {
                            value = info.b64Image;
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
                        if (['face', 'plate'].includes(info?.detection?.className)) {
                            value = info?.detection?.label ?? 'unknown';
                        } else {
                            value = null;
                        }
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

                if (value !== null) {
                    this.publish(console, getEntityTopic(entity), value, entity !== 'lastImage');
                    mainEntity && triggered && info && this.publish(console, getInfoTopic(entity), info);


                    if (entity === 'lastClassname' && info.b64Image) {
                        const { imageEntity } = this.getLastDetectionTopics(value);
                        this.publish(console, getEntityTopic(imageEntity), info.b64Image);

                        const { imageEntity: motionImageEntity } = this.getLastDetectionTopics('motion');
                        this.publish(console, getEntityTopic(motionImageEntity), info.b64Image);
                    }
                }
            }
        } catch (e) {
            console.log(`Error publishing`, e);
        }
    }

    async publishRelevantDetections(props: {
        device: ScryptedDeviceBase,
        console: Console,
        detections: ObjectDetectionResult[],
        triggerTime: number,
    }) {

        const { device, detections, triggerTime, console } = props;
        try {
            console.debug(`Entities to publish: ${JSON.stringify(detections)}`)
            for (const detection of detections) {
                const detectionClass = detection.className;
                const { timeEntity } = this.getLastDetectionTopics(detectionClass);
                const { getEntityTopic } = this.getMqttTopicTopics(device);

                this.publish(console, getEntityTopic(timeEntity), new Date(triggerTime).toISOString(), false);
            }
        } catch (e) {
            console.log(`Error publishing`, e);
        }
    }

    subscribeToHaTopics(entitiesActiveTopic: string, console: Console, cb?: (topic: string, entitiesActive: string[]) => void) {
        this.getMqttClient(console).removeAllListeners();
        this.getMqttClient(console).subscribe([entitiesActiveTopic]);
        this.getMqttClient(console).on('message', (messageTopic, message) => {
            const messageString = message.toString();
            if (messageTopic === entitiesActiveTopic) {
                cb && cb(messageTopic, messageString !== 'null' ? JSON.parse(messageString) : []);
            }
        })
    }
}