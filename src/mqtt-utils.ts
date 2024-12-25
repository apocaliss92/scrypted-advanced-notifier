import { MediaObject, ObjectDetectionResult, ObjectsDetected, ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isFaceClassname, isLabelDetection, parentDetectionClassMap } from './detecionClasses';
import { DetectionRule, DetectionRuleSource, firstUpperCase, getWebooks, storeWebhookImage } from './utils';
import { cloneDeep, groupBy } from 'lodash';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'camera' | 'switch';
    name: string;
    className?: string,
    key?: string,
    deviceClass?: string,
}

const idPrefix = 'scrypted-an';
const namePrefix = 'Scrypted AN';
const peopleTrackerId = 'people-tracker';
const mainRuleId = 'main-rule';
const deviceRuleId = 'device-rule';

const triggeredEntity: MqttEntity = { entity: 'triggered', name: 'Notification triggered', domain: 'binary_sensor' };

const batteryEntity: MqttEntity = {
    domain: 'sensor',
    entity: 'battery',
    name: 'Battery',
    deviceClass: 'battery'
};
const onlineEntity: MqttEntity = {
    domain: 'binary_sensor',
    entity: 'online',
    name: 'Online',
    deviceClass: 'power'
};

const deviceClassMqttEntities: MqttEntity[] = defaultDetectionClasses.flatMap(className => {
    const parsedClassName = firstUpperCase(className);
    const entries: MqttEntity[] = [
        { entity: `${className}Detected`, name: `${parsedClassName} detected`, domain: 'binary_sensor', className, },
        { entity: `${className}LastImage`, name: `${parsedClassName} last image `, domain: 'camera', className },
        { entity: `${className}LastDetection`, name: `${parsedClassName} last detection `, domain: 'sensor', className },
    ];

    if (isLabelDetection(className)) {
        entries.push({ entity: `${className}LastLabel`, name: `${parsedClassName} last recognized`, domain: 'sensor', className });
    }

    if ([DetectionClass.Animal, DetectionClass.Person, DetectionClass.Vehicle].includes(className)) {
        entries.push({ entity: `${className}Objects`, name: `${parsedClassName} objects`, domain: 'sensor', className });
    }

    return entries;
});

const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

export const getDetectionRuleId = (rule: DetectionRule) => `${rule.source}_${rule.name.replace(/\s/g, '')}`;

export const getMqttTopicTopics = (deviceId: string) => {
    const getEntityTopic = (entity: string) => `scrypted/advancedNotifier/${deviceId}/${entity}`;
    const getCommandTopic = (entity: string) => `${getEntityTopic(entity)}/set`;
    const getInfoTopic = (entity: string) => `${getEntityTopic(entity)}/info`;
    const getDiscoveryTopic = (domain: MqttEntity['domain'], entity: string) => `homeassistant/${domain}/${idPrefix}-${deviceId}/${entity}/config`;

    return {
        getEntityTopic,
        getDiscoveryTopic,
        getInfoTopic,
        getCommandTopic,
    }
}


const getPersonStrings = (person: string) => {
    const personId = person.trim().replace(' ', '_');

    return {
        personId,
        personName: person,
    }
}

export const getRuleStrings = (rule: DetectionRule) => {
    const entityId = rule.name.trim().replace(' ', '_');
    const ruleDeviceId = rule.deviceId ? `${deviceRuleId}-${rule.deviceId}` : mainRuleId;

    return { entityId, ruleDeviceId };
}

export const setupPluginAutodiscovery = async (props: {
    mqttClient: MqttClient,
    people: string[],
    console: Console,
    detectionRules: DetectionRule[];
}) => {
    const { people, mqttClient, detectionRules } = props;

    const mqttPeopleTrackerDevice = {
        ids: `${idPrefix}-${peopleTrackerId}`,
        name: `${namePrefix} people tracker`
    };

    const { getDiscoveryTopic, getEntityTopic } = getMqttTopicTopics(peopleTrackerId);

    for (const person of people) {
        const { personId, personName } = getPersonStrings(person);
        const config = {
            dev: mqttPeopleTrackerDevice,
            unique_id: `${idPrefix}-${peopleTrackerId}-${personId}`,
            name: personName,
            object_id: `${idPrefix}-${peopleTrackerId}-${personId}`,
            state_topic: getEntityTopic(personId)
        };

        await mqttClient.publish(getDiscoveryTopic('sensor', personId), JSON.stringify(config));
    }

    const mqttMainSettingsDevice = {
        ids: `${idPrefix}-main-settings`,
        name: `${namePrefix} main settings`,
    };

    for (const detectionRule of detectionRules) {
        const isPluginRule = detectionRule.source === DetectionRuleSource.Plugin;

        if (isPluginRule) {
            const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
            const { getCommandTopic, getEntityTopic, getDiscoveryTopic } = getMqttTopicTopics(ruleDeviceId);
            const commandTopic = getCommandTopic(entityId);
            const stateTopic = getEntityTopic(entityId);

            const detectionRUleEnabledConfig = {
                dev: mqttMainSettingsDevice,
                unique_id: `${mainRuleId}-rule-${entityId}`,
                name: `Main rule ${detectionRule.name}`,
                platform: 'switch',
                command_topic: commandTopic,
                state_topic: stateTopic,
                optimistic: false,
                retain: true,
                qos: 0
            };

            await mqttClient.publish(getDiscoveryTopic('switch', entityId), JSON.stringify(detectionRUleEnabledConfig));
        } else {
            const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
            const { getCommandTopic, getEntityTopic, getDiscoveryTopic } = getMqttTopicTopics(ruleDeviceId);
            const commandTopic = getCommandTopic(entityId);
            const stateTopic = getEntityTopic(entityId);

            const detectionRUleEnabledConfig = {
                dev: mqttMainSettingsDevice,
                unique_id: `${deviceRuleId}-rule-${entityId}`,
                name: `Device ${detectionRule.deviceId} rule ${detectionRule.name}`,
                platform: 'switch',
                command_topic: commandTopic,
                state_topic: stateTopic,
                optimistic: false,
                retain: true,
                qos: 0
            };

            await mqttClient.publish(getDiscoveryTopic('switch', entityId), JSON.stringify(detectionRUleEnabledConfig));
        }
    }
}

export const subscribeToMqttTopics = async (
    props: {
        mqttClient: MqttClient,
        entitiesActiveTopic?: string,
        detectionRules: DetectionRule[],
        activeEntitiesCb: (activeEntities: string[]) => void,
        ruleCb: (props: {
            ruleName: string;
            deviceId?: string;
            active: boolean
        }) => void
    }
) => {
    const { activeEntitiesCb, entitiesActiveTopic, mqttClient, detectionRules, ruleCb } = props;
    mqttClient.removeAllListeners();

    if (entitiesActiveTopic) {
        mqttClient.subscribe([entitiesActiveTopic], async (messageTopic, message) => {
            const messageString = message.toString();
            if (messageTopic === entitiesActiveTopic) {
                activeEntitiesCb(messageString !== 'null' ? JSON.parse(messageString) : [])
            }
        });
    }

    for (const detectionRule of detectionRules) {
        const isPluginRule = detectionRule.source === DetectionRuleSource.Plugin;
        const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
        const { getCommandTopic, getEntityTopic } = getMqttTopicTopics(ruleDeviceId);

        if (isPluginRule) {
            const commandTopic = getCommandTopic(entityId);
            const stateTopic = getEntityTopic(entityId);

            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    ruleCb({
                        active: message === 'ON',
                        ruleName: detectionRule.name,
                        deviceId: undefined
                    });

                    await mqttClient.publish(stateTopic, message);
                }
            });
        } else {
            const { entityId } = getRuleStrings(detectionRule);
            const commandTopic = getCommandTopic(entityId);
            const stateTopic = getEntityTopic(entityId);

            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    ruleCb({
                        active: message === 'ON',
                        ruleName: detectionRule.name,
                        deviceId: detectionRule.deviceId
                    });

                    await mqttClient.publish(stateTopic, message);
                }
            });
        }
    }
}

export const setupDeviceAutodiscovery = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    withDetections?: boolean,
    deviceClass: string,
}) => {
    const { device, withDetections, deviceClass, mqttClient } = props;
    const { name, id } = device;

    const mqttdevice = {
        ids: `${idPrefix}-${id}`,
        name: `${namePrefix} ${name}`
    };

    const { getDiscoveryTopic, getEntityTopic } = getMqttTopicTopics(device.id);
    const allEntities = [triggeredEntity, ...deviceClassMqttEntities];
    const entitiesToRun = withDetections ?
        allEntities :
        allEntities.filter(entity => entity.entity === 'triggered');

    if (device.interfaces.includes(ScryptedInterface.Battery)) {
        entitiesToRun.push(cloneDeep(batteryEntity));
    }
    if (device.interfaces.includes(ScryptedInterface.Online)) {
        entitiesToRun.push(cloneDeep(onlineEntity));
    }

    const getConfig = (entity: string, name: string, deviceClassParent?: string) => ({
        dev: mqttdevice,
        unique_id: `${idPrefix}-${id}-${entity}`,
        name,
        object_id: `${device.name}_${entity}`,
        device_class: deviceClassParent ?? (entity === 'triggered' || entity.includes('Detected') ? deviceClass : undefined)
    } as any);

    for (const mqttEntity of entitiesToRun) {
        const { domain, entity, name, deviceClass: deviceClassParent } = mqttEntity;

        const config = getConfig(entity, name, deviceClassParent);
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

        await mqttClient.publish(getDiscoveryTopic(domain, entity), JSON.stringify(config));
    }
}

export const discoverDetectionRules = async (props: {
    mqttClient: MqttClient
    device: ScryptedDeviceBase,
    console: Console,
    rules?: DetectionRule[],
}) => {
    const { device, rules, mqttClient } = props;
    const { name, id } = device;

    const mqttdevice = {
        ids: `${idPrefix}-${id}`,
        name: `${namePrefix} ${name}`
    };

    const { getDiscoveryTopic, getEntityTopic } = getMqttTopicTopics(device.id);

    for (const rule of rules) {
        const entity = getDetectionRuleId(rule);
        const topic = getEntityTopic(entity);

        const config: any = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${entity}`,
            name: `${rule.source} - ${rule.name} Triggered`,
            object_id: `${device.name}_${entity}`,
            device_class: 'motion',
            payload_on: 'true',
            payload_off: 'false',
            state_topic: topic,
        };

        await mqttClient.publish(getDiscoveryTopic('binary_sensor', entity), JSON.stringify(config));
    }
}

export const publishRelevantDetections = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    detections?: ObjectDetectionResult[],
    triggerTime: number,
    b64Image?: string,
    image?: MediaObject,
    reset?: boolean,
    room?: string,
}) => {
    const { mqttClient, device, detections = [], triggerTime, console, b64Image, image, reset, room } = props;
    try {
        const { getEntityTopic } = getMqttTopicTopics(device.id);

        for (const detection of detections) {
            const detectionClass = detectionClassesDefaultMap[detection.className];
            if (detectionClass) {
                const entitiesToPublish = deviceClassMqttEntitiesGrouped[detectionClass] ?? [];
                console.debug(`Relevant detections to publish: ${JSON.stringify({ detections, entitiesToPublish })}`);

                for (const entry of entitiesToPublish) {
                    const { entity } = entry;
                    let value: any;
                    let retain: true;

                    if (entity.includes('Detected')) {
                        value = true;
                    } else if (entity.includes('LastLabel')) {
                        value = detection?.label || null;
                    } else if (entity.includes('LastDetection')) {
                        value = new Date(triggerTime).toISOString();
                    } else if (entity.includes('LastImage') && b64Image) {
                        // if (isFaceClassname(detectionClass)) {
                        // const { b64Image: newB64Image } = await addBoundingToImage(detection.boundingBox,
                        //     await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg'),
                        //     console,
                        //     detectionClass);
                        // console.log(newB64Image);
                        // }
                        value = b64Image || null;
                        retain = true;
                    }

                    if (value) {
                        await mqttClient.publish(getEntityTopic(entity), value, retain);
                    }
                }

                const person = detection.label;
                if (isFaceClassname(detection.className) && person && room) {
                    const { personId } = getPersonStrings(person);
                    const { getEntityTopic } = getMqttTopicTopics(peopleTrackerId);
                    console.debug(`Person ${person} (${personId}) detected in room ${room}. Publishing topic ${getEntityTopic(personId)} with room ${room}`);
                    await mqttClient.publish(getEntityTopic(personId), room, true);
                }

                if (image && !reset) {
                    const { lastSnapshot } = await getWebooks();
                    await storeWebhookImage({
                        deviceId: device.id,
                        image,
                        logger: console,
                        webhook: lastSnapshot
                    }).catch(console.log);
                    await storeWebhookImage({
                        deviceId: device.id,
                        image,
                        logger: console,
                        webhook: `${lastSnapshot}_${detectionClass}`
                    }).catch(console.log);
                }
            } else {
                console.log(`${detection.className} not found`);
            }
        }

        if (reset) {
            for (const entry of deviceClassMqttEntities) {
                const { entity } = entry;

                if (entity.includes('Detected')) {
                    await mqttClient.publish(getEntityTopic(entity), false);
                }
            }
        }
    } catch (e) {
        console.log(`Error publishing ${JSON.stringify({
            detections,
            triggerTime,
        })}`, e);
    }
}

export const reportDeviceValues = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console
}) => {
    const { device, mqttClient } = props;
    const { getEntityTopic } = getMqttTopicTopics(device.id);

    if (device.interfaces.includes(ScryptedInterface.Battery) && device.batteryLevel) {
        await mqttClient.publish(getEntityTopic(batteryEntity.entity), device.batteryLevel, true);
    }
    if (device.interfaces.includes(ScryptedInterface.Online)) {
        await mqttClient.publish(getEntityTopic(onlineEntity.entity), device.online, true);
    }
}

export const publishDeviceState = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    triggered: boolean,
    b64Image?: string,
    detection?: ObjectDetectionResult,
    resettAllClasses?: boolean,
    rule?: DetectionRule,
    allRuleIds?: string[],
}) => {
    const { mqttClient, device, triggered, console, detection, b64Image, resettAllClasses, rule, allRuleIds } = props;
    try {
        const detectionClass = detection?.className ? detectionClassesDefaultMap[detection.className] : undefined;
        console.debug(`Trigger entities to publish: ${JSON.stringify(triggeredEntity)}`)
        const { getEntityTopic } = getMqttTopicTopics(device.id);

        const { entity } = triggeredEntity;

        const value: any = triggered;
        const retain = true;

        if (value !== null) {
            await mqttClient.publish(getEntityTopic(entity), value, retain);
        }

        if (rule) {
            await mqttClient.publish(getEntityTopic(getDetectionRuleId(rule)), true, true);
        }

        if (detection) {
            const parentClass = parentDetectionClassMap[detectionClass];
            const specificClassEntries = deviceClassMqttEntitiesGrouped[detectionClass] ?? [];
            const parentClassEntries = parentClass ? deviceClassMqttEntitiesGrouped[parentClass] ?? [] : [];

            const classEntries = [...specificClassEntries, ...parentClassEntries];
            console.debug(`Updating following entities related to ${detectionClass}. ${JSON.stringify({ classEntries, b64Image: !!b64Image })}`);
            for (const entry of classEntries) {
                const { entity } = entry;
                let value;
                let retain = true;

                if (entity.includes('Detected')) {
                    value = true;
                } else if (entity.includes('LastImage')) {
                    value = b64Image || null;
                    retain = false;
                } else if (entity.includes('LastLabel')) {
                    value = detection?.label || null;
                }

                if (value !== null) {
                    await mqttClient.publish(getEntityTopic(entity), value, retain);
                }
            }
        }

        if (resettAllClasses) {
            // Resetting all detection classes
            for (const entry of deviceClassMqttEntities) {
                const { entity } = entry;

                if (entity.includes('Detected')) {
                    await mqttClient.publish(getEntityTopic(entity), false);
                }
            }

            // Resetting all the rule triggers
            if (allRuleIds) {
                for (const ruleId of allRuleIds) {
                    await mqttClient.publish(getEntityTopic(ruleId), false);
                }
            }

            // Resetting main trigger
            await mqttClient.publish(getEntityTopic(triggeredEntity.entity), false);
        }
    } catch (e) {
        console.log(`Error publishing`, e);
    }
}

export const publishOccupancy = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    objectsDetected: ObjectsDetected,
}) => {
    const { mqttClient, device, objectsDetected } = props;
    try {
        const { getEntityTopic } = getMqttTopicTopics(device.id);

        const entities = deviceClassMqttEntities.filter(entity => entity.entity.includes('Objects'));
        for (const classEntity of entities) {
            const classObjects = objectsDetected.detections.filter(det => classEntity.className === detectionClassesDefaultMap[det.className])?.length;

            await mqttClient.publish(getEntityTopic(classEntity.entity), classObjects, true);
        }
    } catch (e) {
        console.log(`Error publishing ${JSON.stringify({
            objectsDetected,
        })}`, e);
    }
}
