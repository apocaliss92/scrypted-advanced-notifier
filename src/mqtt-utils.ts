import { MediaObject, ObjectDetectionResult, ObjectsDetected, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isFaceClassname, isLabelDetection, parentDetectionClassMap } from './detecionClasses';
import { DetectionRule, firstUpperCase, getWebooks, ObserveZoneClasses, ObserveZoneData, OccupancyRule, OccupancyRuleData, storeWebhookImage } from './utils';
import { cloneDeep, groupBy } from 'lodash';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'image' | 'switch';
    name: string;
    className?: DetectionClass,
    key?: string,
    deviceClass?: string,
    icon?: string;
}

export const detectionClassForObjectsReporting = [DetectionClass.Animal, DetectionClass.Person, DetectionClass.Vehicle];

const idPrefix = 'scrypted-an';
const namePrefix = 'Scrypted AN';
const peopleTrackerId = 'people-tracker';
const mainRuleId = 'main-rule';
const deviceRuleId = 'device-rule';
const occupancyRuleId = 'occupancy-rule';

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
const recordingEntity: MqttEntity = {
    domain: 'switch',
    entity: 'recording',
    name: 'Recording',
    deviceClass: 'running'
};

const deviceClassMqttEntities: MqttEntity[] = defaultDetectionClasses.flatMap(className => {
    const parsedClassName = firstUpperCase(className);
    const entries: MqttEntity[] = [
        { entity: `${className}Detected`, name: `${parsedClassName} detected`, domain: 'binary_sensor', className, },
        { entity: `${className}LastImage`, name: `${parsedClassName} last image `, domain: 'image', className },
        {
            entity: `${className}LastDetection`,
            name: `${parsedClassName} last detection `,
            domain: 'sensor',
            className,
            icon: 'mdi:clock',
            deviceClass: 'timestamp'
        },
    ];

    if (isLabelDetection(className)) {
        entries.push({ entity: `${className}LastLabel`, name: `${parsedClassName} last recognized`, domain: 'sensor', className });
    }

    if (detectionClassForObjectsReporting.includes(className)) {
        entries.push({ entity: `${className}Objects`, name: `${parsedClassName} objects`, domain: 'sensor', className });
    }

    return entries;
});

const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

export const getDetectionRuleId = (rule: DetectionRule) => `${rule.source}_${rule.name.replace(/\s/g, '')}`;
export const getOccupancyRuleId = (rule: OccupancyRule) => `occupancy_${rule.name.replace(/\s/g, '')}`;

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
    const ruleDeviceId = rule.deviceId ? `${deviceRuleId}-${rule.name}` : mainRuleId;

    return { entityId, ruleDeviceId };
}

export const getOccupancyRuleStrings = (rule: OccupancyRule) => {
    const entityId = rule.name.trim().replace(' ', '_');
    const ruleDeviceId = `${occupancyRuleId}-${rule.name}`;

    return { entityId, ruleDeviceId };
}

export const getObserveZoneStrings = (zoneName: string, className: DetectionClass) => {
    const parsedClassName = firstUpperCase(className);
    const parsedZoneName = zoneName.trim().replace(' ', '_');
    const entityId = `${parsedZoneName}_${className}_Objects`;
    const name = `${parsedZoneName} ${parsedClassName} objects`;

    return { entityId, name };
}

const mqttMainSettingsDevice = {
    manufacturer: namePrefix,
    ids: `${idPrefix}-main-settings`,
    name: `${namePrefix} main settings`,
};

export const setupPluginAutodiscovery = async (props: {
    mqttClient: MqttClient,
    people: string[],
    console: Console,
    detectionRules: DetectionRule[];
}) => {
    const { people, mqttClient, detectionRules } = props;

    const mqttPeopleTrackerDevice = {
        ...getMqttDevice(),
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

    for (const detectionRule of detectionRules) {
        const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
        const { getCommandTopic, getEntityTopic, getDiscoveryTopic } = getMqttTopicTopics(ruleDeviceId);
        const commandTopic = getCommandTopic(entityId);
        const stateTopic = getEntityTopic(entityId);

        const detectionRuleEnabledConfig = {
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

        await mqttClient.publish(getDiscoveryTopic('switch', entityId), JSON.stringify(detectionRuleEnabledConfig));
    }
}

export const subscribeToMainMqttTopics = async (
    props: {
        mqttClient: MqttClient,
        entitiesActiveTopic?: string,
        detectionRules: DetectionRule[],
        activeEntitiesCb: (activeEntities: string[]) => void,
        ruleCb: (props: {
            ruleName: string;
            active: boolean
        }) => void
    }
) => {
    const { activeEntitiesCb, entitiesActiveTopic, mqttClient, detectionRules, ruleCb } = props;
    if (entitiesActiveTopic) {
        mqttClient.subscribe([entitiesActiveTopic], async (messageTopic, message) => {
            const messageString = message.toString();
            if (messageTopic === entitiesActiveTopic) {
                activeEntitiesCb(messageString !== 'null' ? JSON.parse(messageString) : [])
            }
        });
    }

    for (const detectionRule of detectionRules) {
        const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
        const { getCommandTopic, getEntityTopic } = getMqttTopicTopics(ruleDeviceId);

        const commandTopic = getCommandTopic(entityId);
        const stateTopic = getEntityTopic(entityId);

        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                ruleCb({
                    active: message === 'ON',
                    ruleName: detectionRule.name,
                });

                await mqttClient.publish(stateTopic, message);
            }
        });
    }
}

export const subscribeToDeviceMqttTopics = async (
    props: {
        mqttClient: MqttClient,
        detectionRules: DetectionRule[],
        occupancyRules?: OccupancyRule[],
        device: ScryptedDeviceBase,
        switchRecordingCb?: (active: boolean) => void,
        detectionRuleCb: (props: {
            ruleName: string;
            active: boolean
        }) => void,
        occupancyRuleCb?: (props: {
            ruleName: string;
            active: boolean
        }) => void
    }
) => {
    const { mqttClient, detectionRules, occupancyRules, detectionRuleCb, switchRecordingCb, occupancyRuleCb, device } = props;

    for (const detectionRule of detectionRules) {
        const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
        const { getCommandTopic, getEntityTopic } = getMqttTopicTopics(ruleDeviceId);

        const commandTopic = getCommandTopic(entityId);
        const stateTopic = getEntityTopic(entityId);

        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                detectionRuleCb({
                    active: message === 'ON',
                    ruleName: detectionRule.name,
                });

                await mqttClient.publish(stateTopic, message);
            }
        });
    }

    if (occupancyRuleCb) {
        for (const occupancyRule of occupancyRules) {
            const { entityId, ruleDeviceId } = getOccupancyRuleStrings(occupancyRule);
            const { getCommandTopic, getEntityTopic } = getMqttTopicTopics(ruleDeviceId);

            const commandTopic = getCommandTopic(entityId);
            const stateTopic = getEntityTopic(entityId);

            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    occupancyRuleCb({
                        active: message === 'ON',
                        ruleName: occupancyRule.name,
                    });

                    await mqttClient.publish(stateTopic, message);
                }
            });
        }
    }

    const { getCommandTopic, getEntityTopic } = getMqttTopicTopics(device.id);

    if (switchRecordingCb) {
        const commandTopic = getCommandTopic(recordingEntity.entity);
        const stateTopic = getEntityTopic(recordingEntity.entity);
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                switchRecordingCb(message === 'ON');

                await mqttClient.publish(stateTopic, message);
            }
        });
    }
}

const getMqttDevice = (device?: ScryptedDeviceBase) => {
    if (device) {
        return {
            ids: `${idPrefix}-${device.id}`,
            name: `${device.name}`,
            manufacturer: namePrefix,
            model: `${device?.info?.manufacturer ?? ''} ${device?.info?.model ?? ''}`,
            via_device: mqttMainSettingsDevice.ids
        }
    } else {
        return {
            manufacturer: namePrefix,
            via_device: mqttMainSettingsDevice.ids
        }
    }
}

const getDeviceClassEntities = (device: ScryptedDeviceBase) => {
    let classes: DetectionClass[] = [];
    if (device.type === ScryptedDeviceType.Camera || device.type === ScryptedDeviceType.Doorbell) {
        classes = [
            DetectionClass.Motion,
            DetectionClass.Person,
            DetectionClass.Vehicle,
            DetectionClass.Animal,
            DetectionClass.Face,
            DetectionClass.Plate,
            DetectionClass.Package,
        ]
    } else if (device.type === ScryptedDeviceType.Sensor) {
        classes = [DetectionClass.DoorSensor];
    } else if (device.type === ScryptedDeviceType.Lock) {
        classes = [DetectionClass.DoorLock]
    }

    return deviceClassMqttEntities.filter(entry => !entry.className || classes.includes(entry.className));
}

export const setupDeviceAutodiscovery = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    withDetections?: boolean,
    deviceClass: string,
    detectionRules: DetectionRule[],
    occupancyRules?: OccupancyRule[],
}) => {
    const { device, withDetections, deviceClass, mqttClient, detectionRules, occupancyRules } = props;
    const { id } = device;

    const mqttdevice = getMqttDevice(device);

    const { getDiscoveryTopic, getEntityTopic, getCommandTopic } = getMqttTopicTopics(device.id);
    const allEntities = [triggeredEntity, ...getDeviceClassEntities(device)];
    const entitiesToRun = withDetections ?
        allEntities :
        [triggeredEntity];

    if (device.interfaces.includes(ScryptedInterface.Battery)) {
        entitiesToRun.push(cloneDeep(batteryEntity));
    }

    if (device.interfaces.includes(ScryptedInterface.Online)) {
        entitiesToRun.push(cloneDeep(onlineEntity));
    }

    const getConfig = (entity: string, name: string, deviceClassParent?: string, icon?: string) => ({
        dev: mqttdevice,
        unique_id: `${idPrefix}-${id}-${entity}`,
        object_id: `${device.name}_${entity}`,
        name,
        device_class: deviceClassParent ?? (entity === 'triggered' || entity.includes('Detected') ? deviceClass : undefined),
        icon
    } as any);

    for (const mqttEntity of entitiesToRun) {
        const { domain, entity, name, deviceClass: deviceClassParent, icon } = mqttEntity;

        const config = getConfig(entity, name, deviceClassParent, icon);
        const topic = getEntityTopic(entity);

        if (domain === 'binary_sensor') {
            config.payload_on = 'true';
            config.payload_off = 'false';
            config.state_topic = topic;
        }
        if (domain === 'image') {
            config.image_topic = topic;
            config.image_encoding = 'b64';
            config.state_topic = topic;
        }
        if (domain === 'sensor') {
            config.state_topic = topic;
        }

        await mqttClient.publish(getDiscoveryTopic(domain, entity), JSON.stringify(config));
    }

    if (device.interfaces.includes(ScryptedInterface.VideoRecorder)) {
        const stateTopic = getEntityTopic(recordingEntity.entity);
        const commandTopic = getCommandTopic(recordingEntity.entity);

        const config = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${recordingEntity.entity}`,
            object_id: `${device.name}_${recordingEntity.entity}`,
            name: `${recordingEntity.name}`,
            platform: 'switch',
            command_topic: commandTopic,
            state_topic: stateTopic,
            optimistic: false,
            retain: true,
            qos: 0
        };

        await mqttClient.publish(getDiscoveryTopic(recordingEntity.domain, recordingEntity.entity), JSON.stringify(config));
    }

    for (const detectionRule of detectionRules) {
        const { entityId, ruleDeviceId } = getRuleStrings(detectionRule);
        const { getCommandTopic, getEntityTopic, getDiscoveryTopic } = getMqttTopicTopics(ruleDeviceId);
        const commandTopic = getCommandTopic(entityId);
        const stateTopic = getEntityTopic(entityId);

        const detectionRuleEnabledConfig = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${ruleDeviceId}`,
            object_id: `${device.name}_${ruleDeviceId}`,
            name: `${detectionRule.name} rule`,
            platform: 'switch',
            command_topic: commandTopic,
            state_topic: stateTopic,
            optimistic: false,
            retain: true,
            qos: 0,
        };

        await mqttClient.publish(getDiscoveryTopic('switch', entityId), JSON.stringify(detectionRuleEnabledConfig));
    }

    for (const occupancyRule of occupancyRules) {
        const { entityId, ruleDeviceId } = getOccupancyRuleStrings(occupancyRule);
        const { getCommandTopic, getEntityTopic, getDiscoveryTopic } = getMqttTopicTopics(ruleDeviceId);
        const commandTopic = getCommandTopic(entityId);
        const stateTopic = getEntityTopic(entityId);

        const detectionRuleEnabledConfig = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${ruleDeviceId}`,
            object_id: `${device.name}_${ruleDeviceId}`,
            name: `${occupancyRule.name} rule`,
            platform: 'switch',
            command_topic: commandTopic,
            state_topic: stateTopic,
            optimistic: false,
            retain: true,
            qos: 0,
        };

        await mqttClient.publish(getDiscoveryTopic('switch', entityId), JSON.stringify(detectionRuleEnabledConfig));
    }
}

export const discoverDetectionRules = async (props: {
    mqttClient: MqttClient
    device: ScryptedDeviceBase,
    console: Console,
    rules?: DetectionRule[],
}) => {
    const { device, rules, mqttClient } = props;
    const { id } = device;

    const mqttdevice = getMqttDevice(device);

    const { getDiscoveryTopic, getEntityTopic } = getMqttTopicTopics(device.id);

    for (const rule of rules) {
        const entity = getDetectionRuleId(rule);
        const topic = getEntityTopic(entity);

        const config: any = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${entity}`,
            name: `Rule ${rule.name}`,
            object_id: `${device.name}_${entity}`,
            device_class: 'motion',
            payload_on: 'true',
            payload_off: 'false',
            state_topic: topic,
        };

        await mqttClient.publish(getDiscoveryTopic('binary_sensor', entity), JSON.stringify(config));
    }
}

export const discoverOccupancyRules = async (props: {
    mqttClient: MqttClient
    device: ScryptedDeviceBase,
    console: Console,
    rules?: OccupancyRule[],
}) => {
    const { device, rules, mqttClient } = props;
    const { id } = device;

    const mqttdevice = getMqttDevice(device);

    const { getDiscoveryTopic, getEntityTopic } = getMqttTopicTopics(device.id);

    for (const rule of rules) {
        const entity = getOccupancyRuleId(rule);
        const topic = getEntityTopic(entity);

        const config: any = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${entity}`,
            name: `Rule ${rule.name}`,
            object_id: `${device.name}_${entity}`,
            device_class: 'occupancy',
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
            for (const entry of getDeviceClassEntities(device)) {
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
    isRecording: boolean,
    console: Console
}) => {
    const { device, mqttClient, isRecording } = props;
    const { getEntityTopic } = getMqttTopicTopics(device.id);

    if (device.interfaces.includes(ScryptedInterface.Battery) && device.batteryLevel) {
        await mqttClient.publish(getEntityTopic(batteryEntity.entity), device.batteryLevel, true);
    }
    if (device.interfaces.includes(ScryptedInterface.Online)) {
        await mqttClient.publish(getEntityTopic(onlineEntity.entity), device.online, true);
    }
    if (device.interfaces.includes(ScryptedInterface.VideoRecorder)) {
        await mqttClient.publish(getEntityTopic(recordingEntity.entity), isRecording ? 'ON' : 'OFF', true);
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

                if (value != null) {
                    await mqttClient.publish(getEntityTopic(entity), value, retain);
                }
            }
        }

        if (resettAllClasses) {
            // Resetting all detection classes
            for (const entry of getDeviceClassEntities(device)) {
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
    observeZonesClasses: ObserveZoneClasses,
    occupancyRulesData: OccupancyRuleData[]
}) => {
    const { mqttClient, device, objectsDetected, occupancyRulesData } = props;
    try {
        const { getEntityTopic } = getMqttTopicTopics(device.id);

        const entities = deviceClassMqttEntities.filter(entity => entity.entity.includes('Objects'));
        for (const classEntity of entities) {
            const classObjects = objectsDetected.detections.filter(det => classEntity.className === detectionClassesDefaultMap[det.className])?.length;

            await mqttClient.publish(getEntityTopic(classEntity.entity), classObjects, true);
        }

        // for (const zoneData of Object.entries(observeZonesClasses)) {
        //     const [zoneName, zoneDataOfClasses] = zoneData;
        //     for (const zoneClassData of Object.entries(zoneDataOfClasses)) {
        //         const [className, objects] = zoneClassData;
        //         const { entityId } = getObserveZoneStrings(zoneName, className as DetectionClass);

        //         await mqttClient.publish(getEntityTopic(entityId), objects, true);
        //     }
        // }

        for (const occupancyRule of occupancyRulesData) {
            const { occupies, rule } = occupancyRule;

            await mqttClient.publish(getEntityTopic(getOccupancyRuleId(rule)), occupies, true);
        }
    } catch (e) {
        console.log(`Error publishing ${JSON.stringify({
            objectsDetected,
        })}`, e);
    }
}
