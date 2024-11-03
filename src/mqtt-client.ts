import { connect, Client } from 'mqtt';
import { ObjectDetectionResult, ScryptedDeviceBase } from '@scrypted/sdk';
import { defaultDetectionClasses, detectionClassesDefaultMap, isLabelDetection } from './detecionClasses';
import { firstUpperCase } from './utils';
import { groupBy } from 'lodash';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'camera';
    name: string;
    className?: string,
    key?: string,
}

const idPrefix = 'scrypted-advanced-notifier';
const namePrefix = 'Scrypted advanced notifier';

const mqttEntities: MqttEntity[] = [
    { entity: 'triggered', name: 'Notification triggered', domain: 'binary_sensor' },
    { entity: 'lastImage', name: 'Last image detected', domain: 'camera' },
    { entity: 'lastClassname', name: 'Last classname detected', domain: 'sensor' },
    { entity: 'lastZones', name: 'Last zones detected', domain: 'sensor' },
    { entity: 'lastLabel', name: 'Last label detected', domain: 'sensor' },
];

const deviceClassMqttEntities: MqttEntity[] = defaultDetectionClasses.flatMap(className => {
    const parsedClassName = firstUpperCase(className);
    const entries: MqttEntity[] = [
        { entity: `${className}Detected`, name: `Detected ${parsedClassName}`, domain: 'binary_sensor', className, },
        { entity: `${className}LastImage`, name: `Last image ${parsedClassName}`, domain: 'camera', className },
    ];

    if (isLabelDetection(className)) {
        entries.push({ entity: `${className}LastLabel`, name: `Last label ${parsedClassName}`, domain: 'sensor', className });
    }

    return entries;
});

const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

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

    async getMqttClient(console: Console, forceReconnect?: boolean): Promise<Client> {
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

            if (!this.mqttClient || forceReconnect) {
                if (this.mqttClient) {
                    try {
                        this.mqttClient.end();
                    } catch (e) { }
                }
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
        try {
            if (typeof value === 'object')
                value = JSON.stringify(value);
            if (value.constructor.name !== Buffer.name)
                value = value.toString();
        } catch (e) {
            console.log(`Error parsing publish values: ${JSON.stringify({ topic, value })}`);
            return;
        }

        console.debug(`Publishing ${JSON.stringify({ topic, value })}`);
        const client = await this.getMqttClient(console);
        try {
            client.publish(topic, value, { retain });
        } catch (e) {
            console.log(`Error publishing to MQTT. Reconnecting. ${JSON.stringify({ topic, value })}`, e);
            await this.getMqttClient(console, true);
            client.publish(topic, value, { retain });
        }
    }

    private getMqttTopicTopics(device: ScryptedDeviceBase) {
        const deviceId = device.id;

        const getEntityTopic = (entity: string) => `scrypted/advancedNotifier/${deviceId}/${entity}`;
        const getInfoTopic = (entity: string) => `${getEntityTopic(entity)}/info`;
        const getDiscoveryTopic = (domain: MqttEntity['domain'], entity: string) => `homeassistant/${domain}/${idPrefix}-${deviceId}/${entity}/config`;

        return {
            getEntityTopic,
            getDiscoveryTopic,
            getInfoTopic,
        }
    }

    async setupDeviceAutodiscovery(props: {
        device: ScryptedDeviceBase,
        console: Console,
        localIp?: string,
        withDetections?: boolean,
        deviceClass: string,
    }) {
        const { device, console, withDetections, deviceClass } = props;
        const { name, id } = device;

        const mqttdevice = {
            ids: `${idPrefix}-${id}`,
            name: `${namePrefix} ${name}`
        };

        const { getDiscoveryTopic, getEntityTopic } = this.getMqttTopicTopics(device);
        const allEntities = [...mqttEntities, ...deviceClassMqttEntities];
        const entitiesToRun = withDetections ?
            allEntities :
            allEntities.filter(entity => entity.entity === 'triggered');

        for (const mqttEntity of entitiesToRun) {
            const { domain, entity, name } = mqttEntity;

            const config: any = {
                dev: mqttdevice,
                unique_id: `${idPrefix}-${id}-${entity}`,
                name,
                object_id: `${device.name}_${entity}`,
                device_class: entity === 'triggered' || entity.includes('Detected') ? deviceClass : undefined
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
    }

    async publishDeviceState(props: {
        device: ScryptedDeviceBase,
        console: Console,
        triggered: boolean,
        b64Image?: string,
        detection?: ObjectDetectionResult,
        resettAllClasses?: boolean,
    }) {
        const { device, triggered, console, detection, b64Image, resettAllClasses } = props;
        try {
            const detectionClass = detection?.className ? detectionClassesDefaultMap[detection.className] : undefined;
            const entitiesToRun = detection ?
                mqttEntities :
                mqttEntities.filter(entity => entity.entity === 'triggered');
            console.debug(`Trigger entities to publish: ${JSON.stringify(entitiesToRun)}`)
            const { getEntityTopic } = this.getMqttTopicTopics(device);

            for (const mqttEntity of entitiesToRun) {
                const { entity } = mqttEntity;

                let value: any = triggered;
                switch (entity) {
                    case 'lastImage': {
                        value = b64Image || null;
                        break;
                    }
                    case 'lastClassname': {
                        value = detectionClass || null;
                        break;
                    }
                    case 'lastLabel': {
                        value = detection?.label || null;
                        break;
                    }
                    case 'triggered': {
                        value = triggered;
                        break;
                    }
                    case 'lastZones': {
                        value = detection?.zones?.length ? detection.zones.toString() : null;
                        break;
                    }
                }

                if (value !== null) {
                    await this.publish(console, getEntityTopic(entity), value);
                }
            }

            if (detection) {
                const classEntries = deviceClassMqttEntitiesGrouped[detectionClass] ?? [];
                for (const entry of classEntries) {
                    const { entity } = entry;
                    let value;

                    if (entity.includes('Detected')) {
                        value = true;
                    } else if (entity.includes('LastImage')) {
                        value = b64Image || null;
                    } else if (entity.includes('LastLabel')) {
                        value = detection?.label || null;
                    }

                    await this.publish(console, getEntityTopic(entity), value);
                }
            }

            if (resettAllClasses) {
                for (const entry of deviceClassMqttEntities) {
                    const { entity, className } = entry;

                    if (entity.includes('Detected')) {
                        await this.publish(console, getEntityTopic(entity), false);
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
        b64Image?: string,
    }) {
        const { device, detections, triggerTime, console, b64Image } = props;
        try {
            for (const detection of detections) {
                const detectionClass = detectionClassesDefaultMap[detection.className];
                if (detectionClass) {
                    const entitiesToPublish = deviceClassMqttEntitiesGrouped[detectionClass];
                    console.debug(`Relevant detections to publish: ${JSON.stringify({ detections, entitiesToPublish })}`);

                    const { getEntityTopic } = this.getMqttTopicTopics(device);

                    for (const entry of entitiesToPublish) {
                        const { entity } = entry;
                        let value: any;

                        if (entity.includes('Detected')) {
                            value = true;
                        } else if (entity.includes('LastLabel')) {
                            value = detection?.label || null;
                        } else if (entity.includes('LastImage') && b64Image) {
                            value = b64Image || null;
                        }

                        if (value) {
                            await this.publish(console, getEntityTopic(entity), value);
                        }
                    }
                } else {
                    console.log(`${detectionClass} not found`);
                }
            }
        } catch (e) {
            console.log(`Error publishing ${JSON.stringify({
                detections,
                triggerTime,
            })}`, e);
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