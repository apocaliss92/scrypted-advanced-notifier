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

    async getMqttClient(console: Console): Promise<Client> {
        return new Promise((res, rej) => {
            const _connect = async () => {
                const client = connect(this.mqttPathmame, {
                    rejectUnauthorized: false,
                    username: this.username,
                    password: this.password,
                });
                client.setMaxListeners(Infinity);

                client.on('connect', data => {
                    console.log('Connected to mqtt', JSON.stringify(data));
                    this.mqttClient = client;
                    res(client);
                });

                client.on('error', data => {
                    console.log('Error connecting to mqtt', data);
                    this.mqttClient = undefined;
                    rej();
                });
            }

            if (!this.mqttClient) {
                const url = this.host;
                const urlWithoutPath = new URL(url);
                urlWithoutPath.pathname = '';

                this.mqttPathmame = urlWithoutPath.toString();
                if (!this.mqttPathmame.endsWith('/')) {
                    this.mqttPathmame = `${this.mqttPathmame}/`;
                }
                console.log('Starting MQTT connection', this.host, this.username, this.mqttPathmame);

                _connect();
            } else if (!this.mqttClient.connected) {
                console.log('MQTT disconnected. Reconnecting', this.host, this.username, this.mqttPathmame);

                _connect();
            } else {
                res(this.mqttClient);
            }
        })
    }

    async publish(console: Console, topic: string, value: any, retain = true) {
        if (typeof value === 'object')
            value = JSON.stringify(value);
        if (value.constructor.name !== Buffer.name)
            value = value.toString();

        // console.debug(`Publishing ${JSON.stringify({ topic, value })}`);
        const client = await this.getMqttClient(console);
        client.publish(topic, value, { retain });
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

    // private async findDeviceStreams(deviceSettings: Setting[], localIp: string) {
    //     const streams = deviceSettings.filter(setting => setting.key === 'prebuffer:rtspRebroadcastUrl');

    //     return streams.map(stream => ({ name: stream.subgroup.split(': ')[1], url: (stream.value as string)?.replace('localhost', localIp) }))
    // }

    private getLastDetectionTopics(detectionClass: string) {
        const sanitizedDetectionClass = detectionClass.charAt(0).toUpperCase() + detectionClass.slice(1);
        const timeEntity = `LastDetection${sanitizedDetectionClass}`;
        const imageEntity = `LastImage${sanitizedDetectionClass}`;

        return { timeEntity, imageEntity }
    }

    async setupDeviceAutodiscovery(props: {
        device: ScryptedDeviceBase,
        deviceSettings: Setting[],
        detectionClasses: string[],
        console: Console,
        localIp: string,
        withImage: boolean,
    }) {
        const { detectionClasses, device, deviceSettings, console, withImage } = props;
        const { name, id } = device;

        const haDeviceClass = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haDeviceClass')?.value as string;
        const mqttdevice = {
            ids: `scrypted-ha-utilities-${id}`,
            name: `Scrypted HA utilities ${name}`
        };

        const { getDiscoveryTopic, getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);

        for (const mqttEntity of mqttEntities) {
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

            await this.publish(console, getDiscoveryTopic(domain, entity), JSON.stringify(config));
        }

        // if (localIp) {
        //     const deviceStreams = await this.findDeviceStreams(deviceSettings, localIp);
        //     console.debug(`Streams found: ${JSON.stringify(deviceStreams)}`);

        //     deviceStreams.map(stream => {
        //         const entity = stream.name.replace(/ /g, '');
        //         const config: any = {
        //             dev: mqttdevice,
        //             unique_id: `scrypted-ha-utilities-${id}-${entity}`,
        //             name: entity.charAt(0).toUpperCase() + entity.slice(1),
        //             object_id: `${name}_${entity}`,
        //             state_topic: getEntityTopic(entity)
        //         };

        //         this.publish(console, getDiscoveryTopic('sensor', entity), JSON.stringify(config));
        //         this.publish(console, getEntityTopic(entity), stream.url);
        //     })
        // }

        for (const detectionClass of detectionClasses) {
            const { imageEntity, timeEntity } = this.getLastDetectionTopics(detectionClass);

            const timeConfig: any = {
                dev: mqttdevice,
                unique_id: `scrypted-ha-utilities-${id}-${timeEntity}`,
                name: timeEntity.charAt(0).toUpperCase() + timeEntity.slice(1),
                object_id: `${name}_${timeEntity}`,
                device_class: 'timestamp',
                state_topic: getEntityTopic(timeEntity)
            };
            await this.publish(console, getDiscoveryTopic('sensor', timeEntity), JSON.stringify(timeConfig));

            if (withImage) {
                const imageConfig: any = {
                    dev: mqttdevice,
                    unique_id: `scrypted-ha-utilities-${id}-${imageEntity}`,
                    name: imageEntity.charAt(0).toUpperCase() + imageEntity.slice(1),
                    object_id: `${name}_${imageEntity}`,
                    topic: getEntityTopic(imageEntity),
                    image_encoding: 'b64',
                };
                await this.publish(console, getDiscoveryTopic('camera', imageEntity), JSON.stringify(imageConfig));
            }
        }
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
            console.debug(`publishDeviceState: Entities to publish: ${JSON.stringify(entitiesToRun)}`)
            for (const mqttEntity of entitiesToRun) {
                const { getEntityTopic, getInfoTopic } = this.getMqttTopicTopics(device);
                const { entity, isMainEntity: mainEntity } = mqttEntity;

                let value: any = triggered;
                switch (entity) {
                    case 'lastImage': {
                        value = info.b64Image || null;
                        break;
                    }
                    case 'lastTrigger': {
                        value = new Date(info?.triggerTime).toISOString();
                        break;
                    }
                    case 'lastClassname': {
                        value = info?.detection?.className || null;
                        break;
                    }
                    case 'lastLabel': {
                        value = info?.detection?.label || null;
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
                    // this.publish(console, getEntityTopic(entity), value, entity !== 'lastImage');
                    await this.publish(console, getEntityTopic(entity), value);
                    mainEntity && triggered && info && this.publish(console, getInfoTopic(entity), info);


                    // if (entity === 'lastClassname' && info.b64Image) {
                    //     const { imageEntity } = this.getLastDetectionTopics(value);
                    //     this.publish(console, getEntityTopic(imageEntity), info.b64Image);

                    //     const { imageEntity: motionImageEntity } = this.getLastDetectionTopics('motion');
                    //     this.publish(console, getEntityTopic(motionImageEntity), info.b64Image);
                    // }
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
        b64Image?: string,
    }) {

        const { device, detections, triggerTime, console, b64Image } = props;
        try {
            console.debug(`publishRelevantDetections: Detections to publish: ${JSON.stringify(detections)}`)
            for (const detection of detections) {
                const detectionClass = detection.className;
                const { timeEntity, imageEntity } = this.getLastDetectionTopics(detectionClass);
                const { getEntityTopic } = this.getMqttTopicTopics(device);

                await this.publish(console, getEntityTopic(timeEntity), new Date(triggerTime).toISOString(), false);

                if (b64Image) {
                    await this.publish(console, getEntityTopic(imageEntity), b64Image, false);
                }
            }
        } catch (e) {
            console.log(`Error publishing`, e);
        }
    }

    async subscribeToHaTopics(entitiesActiveTopic: string, console: Console, cb: (topic: any, message: any) => void) {
        const client = await this.getMqttClient(console);
        client.removeAllListeners();
        client.subscribe([entitiesActiveTopic]);

        client.on('message', (messageTopic, message) => {
            const messageString = message.toString();
            if (messageTopic === entitiesActiveTopic) {
                cb(messageTopic, messageString !== 'null' ? JSON.parse(messageString) : [])
            }
        })
    }
}