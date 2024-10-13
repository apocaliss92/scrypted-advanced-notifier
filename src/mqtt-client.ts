import { connect, Client } from 'mqtt';
import { DeviceType } from './types';
import { Setting } from '@scrypted/sdk';

export const ACTIVE_DEVICES_ID = 'active_devices';

export default class MqttClient {
    mqttClient: Client;
    lastSetMap: { [topic: string]: any } = {};
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

    publish(topic: string, value: any) {
        if (typeof value === 'object')
            value = JSON.stringify(value);
        if (value.constructor.name !== Buffer.name)
            value = value.toString();

        this.console.log(`Publishing ${topic}`);
        this.getMqttClient().publish(topic, value, { retain: true });
    }

    // subscribe(topic: string) {
    // this.getMqttClient().subscribe(topic, value, { retain: true });
    // }

    private getMqttTopics(deviceId: string) {
        let sensorTopic: string;
        let autodiscoveryTopic: string;

        if (deviceId === ACTIVE_DEVICES_ID) {
            sensorTopic = `scrypted/homeassistantUtilities/activeDevices`;
            autodiscoveryTopic = `homeassistant/binary_sensor/scrypted-homeassistant-utilities-active-devices/config`;
        } else {
            sensorTopic = `scrypted/homeassistantUtilities/deviceTrigger/${deviceId}`;
            autodiscoveryTopic = `homeassistant/binary_sensor/scrypted-homeassistant-utilities-${deviceId}/DeviceTrigger/config`;
        }

        const sensorInfoTopic = `${sensorTopic}/info`;

        return {
            sensorTopic,
            sensorInfoTopic,
            autodiscoveryTopic
        }
    }

    setupDeviceAutodiscovery(id: string, name: string, deviceSettings: Setting[]) {
        if (this.autodiscoveryPublishedMap[id]) {
            return;
        }
        const deviceClass = deviceSettings.find(setting => setting.key === 'homeassistantMetadata:haDeviceClass')?.value as string;

        const { autodiscoveryTopic, sensorInfoTopic, sensorTopic } = this.getMqttTopics(id);

        const config = {
            state_topic: sensorTopic,
            json_attributes_topic: sensorInfoTopic,
            json_attributes_template: '{{ value_json | tojson }}',
            payload_on: 'true',
            payload_off: 'false',
            dev: {
                ids: `scrypted-deviceTrigger-${id}`,
                name: `Device trigger for ${name}`
            },
            unique_id: `scrypted-homeassistant-utilities-${id}`,
            name: `${name} triggered`,
            object_id: `${name}_triggered`,
            device_class: deviceClass
        };
        this.publish(autodiscoveryTopic, JSON.stringify(config));
        this.autodiscoveryPublishedMap[id] = true;
    }

    publishDeviceState(deviceId: string, value: boolean, info?: any) {
        const { sensorTopic, sensorInfoTopic } = this.getMqttTopics(deviceId);

        if (value === this.lastSetMap[sensorTopic]) {
            return;
        }

        this.publish(sensorTopic, value);
        info && this.publish(sensorInfoTopic, info);
        this.lastSetMap[sensorTopic] = value;
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