import sdk, { MediaObject, ObjectDetectionResult, ObjectsDetected, PanTiltZoomCommand, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';
import { cloneDeep, groupBy } from 'lodash';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { OccupancyRuleData } from './cameraMixin';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isFaceClassname, isLabelDetection, parentDetectionClassMap } from './detecionClasses';
import { BaseRule, DetectionRule, firstUpperCase, getWebooks, OccupancyRule, RuleSource, RuleType, StoreImageFn, storeWebhookImage } from './utils';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'image' | 'switch' | 'button' | 'select';
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
const timelapseRuleId = 'timelapse-rule';
const audioRuleId = 'audio-rule';

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
    deviceClass: 'running',
    icon: 'mdi:record-circle-outline'
};
const rebootEntity: MqttEntity = {
    domain: 'button',
    entity: 'reboot',
    name: 'Reboot',
    deviceClass: 'restart'
};
const ptzPresetEntity: MqttEntity = {
    domain: 'select',
    entity: 'ptz_preset',
    name: 'PTZ preset',
    deviceClass: 'restart'
};
const ptzZoomInEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz_zoom_in',
    name: 'Zoom in',
    icon: 'mdi:magnify-plus',
};
const ptzZoomOutEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz_zoom_out',
    name: 'Zoom out',
    icon: 'mdi:magnify-minus'
};
const ptzUpEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz_move_up',
    name: 'Move up',
    icon: 'mdi:arrow-up-thick'
};
const ptzDownEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz_move_down',
    name: 'Move down',
    icon: 'mdi:arrow-down-thick'
};
const ptzLeftEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz_move_left',
    name: 'Move left',
    icon: 'mdi:arrow-left-thick'
};
const ptzRightEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz_move_right',
    name: 'Move right',
    icon: 'mdi:arrow-right-thick'
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

const getRuleMqttEntities = (rule: BaseRule): MqttEntity[] => {
    const parsedName = `Rule ${rule.name}`;
    const entity = getDetectionRuleId(rule);
    const entries: MqttEntity[] = [
        { entity: `${entity}`, name: `${parsedName}`, domain: 'binary_sensor', deviceClass: 'motion' },
        { entity: `${entity}Active`, name: `${parsedName} active`, domain: 'binary_sensor', deviceClass: 'running' },
        { entity: `${entity}LastImage`, name: `${parsedName} last image `, domain: 'image' },
        {
            entity: `${entity}LastTrigger`,
            name: `${parsedName} last trigger `,
            domain: 'sensor',
            icon: 'mdi:clock',
            deviceClass: 'timestamp'
        },
    ];

    return entries;
}

const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

export const getDetectionRuleId = (rule: BaseRule) => `${rule.source}_${rule.name.replaceAll(/\s/g, '')}`;

export const getMqttTopics = (deviceId: string) => {
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
    const personId = person.trim().replaceAll(' ', '_');

    return {
        personId,
        personName: person,
    }
}

const ruleTypeIdMap: Record<RuleType, string> = {
    [RuleType.Detection]: deviceRuleId,
    [RuleType.Occupancy]: occupancyRuleId,
    [RuleType.Timelapse]: timelapseRuleId,
    [RuleType.Audio]: audioRuleId,
}

export const getRuleStrings = (rule: BaseRule) => {
    const entityId = rule.name.trim().replaceAll(' ', '_');
    const id = ruleTypeIdMap[rule.ruleType];
    const ruleDeviceId = rule.deviceId ? `${id}-${rule.name}` : mainRuleId;

    return { entityId, ruleDeviceId };
}

export const getObserveZoneStrings = (zoneName: string, className: DetectionClass) => {
    const parsedClassName = firstUpperCase(className);
    const parsedZoneName = zoneName.trim().replaceAll(' ', '_');
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
        ...(await getMqttDevice()),
        ids: `${idPrefix}-${peopleTrackerId}`,
        name: `${namePrefix} people tracker`
    };

    const { getDiscoveryTopic, getEntityTopic } = getMqttTopics(peopleTrackerId);

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
        const { getCommandTopic, getEntityTopic, getDiscoveryTopic } = getMqttTopics(ruleDeviceId);
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
        const { getCommandTopic, getEntityTopic } = getMqttTopics(ruleDeviceId);

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

const getPtzCommandEntities = (device: ScryptedDeviceBase) => {
    const commandEntities: MqttEntity[] = [];

    if (device.ptzCapabilities?.zoom) {
        commandEntities.push(ptzZoomInEntity, ptzZoomOutEntity)
    }
    if (device.ptzCapabilities?.pan) {
        commandEntities.push(ptzLeftEntity, ptzRightEntity)
    }
    if (device.ptzCapabilities?.tilt) {
        commandEntities.push(ptzUpEntity, ptzDownEntity)
    }

    return commandEntities;
}

export const subscribeToDeviceMqttTopics = async (
    props: {
        mqttClient: MqttClient,
        rules: BaseRule[],
        device: ScryptedDeviceBase,
        switchRecordingCb?: (active: boolean) => void,
        rebootCb?: () => void,
        ptzCommandCb?: (command: PanTiltZoomCommand) => void,
        activationRuleCb: (props: {
            ruleName: string;
            active: boolean;
            ruleType: RuleType;
        }) => void,
    }
) => {
    const {
        mqttClient,
        rules,
        activationRuleCb,
        switchRecordingCb,
        rebootCb,
        ptzCommandCb,
        device
    } = props;

    const processRules = async (rules: BaseRule[]) => {
        for (const rule of rules) {
            const { entityId, ruleDeviceId } = getRuleStrings(rule);
            const { getCommandTopic, getEntityTopic } = getMqttTopics(ruleDeviceId);

            const commandTopic = getCommandTopic(entityId);
            const stateTopic = getEntityTopic(entityId);

            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    activationRuleCb({
                        active: message === 'ON',
                        ruleName: rule.name,
                        ruleType: rule.ruleType
                    });

                    await mqttClient.publish(stateTopic, message);
                }
            });
        }
    }

    await processRules(rules);

    const { getCommandTopic, getEntityTopic } = getMqttTopics(device.id);

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

    if (rebootCb) {
        const commandTopic = getCommandTopic(rebootEntity.entity);
        await mqttClient.subscribe([commandTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                rebootCb();
            }
        });
    }

    if (ptzCommandCb) {
        const commandEntities = getPtzCommandEntities(device);
        commandEntities.push(ptzPresetEntity);

        for (const commandEntity of commandEntities) {
            const commandTopic = getCommandTopic(commandEntity.entity);
            const stateTopic = getEntityTopic(commandEntity.entity);

            await mqttClient.subscribe([commandTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    if (commandEntity.entity === ptzPresetEntity.entity) {
                        ptzCommandCb({ preset: message });

                        await mqttClient.publish(stateTopic, 'None');
                    } else if (commandEntity.entity === ptzZoomInEntity.entity) {
                        ptzCommandCb({ zoom: 0.1 });
                    } else if (commandEntity.entity === ptzZoomOutEntity.entity) {
                        ptzCommandCb({ zoom: -0.1 });
                    } else if (commandEntity.entity === ptzRightEntity.entity) {
                        ptzCommandCb({ pan: 0.1 });
                    } else if (commandEntity.entity === ptzLeftEntity.entity) {
                        ptzCommandCb({ pan: -0.1 });
                    } else if (commandEntity.entity === ptzDownEntity.entity) {
                        ptzCommandCb({ tilt: -0.1 });
                    } else if (commandEntity.entity === ptzUpEntity.entity) {
                        ptzCommandCb({ tilt: 0.1 });
                    }
                }
            });
        }
    }
}

const getMqttDevice = async (device?: ScryptedDeviceBase) => {
    if (device) {
        const localEndpoint = await sdk.endpointManager.getLocalEndpoint();
        const deviceConfigurationUrl = `${new URL(localEndpoint).origin}/endpoint/@scrypted/core/public/#/device/${device.id}`;
        return {
            ids: `${idPrefix}-${device.id}`,
            name: `${device.name}`,
            manufacturer: namePrefix,
            model: `${device?.info?.manufacturer ?? ''} ${device?.info?.model ?? ''}`,
            via_device: mqttMainSettingsDevice.ids,
            configuration_url: deviceConfigurationUrl
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
    rules: BaseRule[],
}) => {
    const { device, withDetections, deviceClass, mqttClient, rules, console } = props;
    const { id } = device;

    const mqttdevice = await getMqttDevice(device);

    const { getDiscoveryTopic, getEntityTopic, getCommandTopic } = getMqttTopics(device.id);
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

        if (entity === 'triggered') {
            await mqttClient.publish(getEntityTopic(entity), false);
        }
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
            qos: 0,
            icon: recordingEntity.icon
        };

        await mqttClient.publish(getDiscoveryTopic(recordingEntity.domain, recordingEntity.entity), JSON.stringify(config));
    }

    if (device.interfaces.includes(ScryptedInterface.Reboot)) {
        const commandTopic = getCommandTopic(rebootEntity.entity);

        const config = {
            dev: mqttdevice,
            unique_id: `${idPrefix}-${id}-${rebootEntity.entity}`,
            object_id: `${device.name}_${rebootEntity.entity}`,
            name: `${rebootEntity.name}`,
            platform: 'button',
            command_topic: commandTopic,
            device_class: rebootEntity.deviceClass,
            qos: 0
        };

        await mqttClient.publish(getDiscoveryTopic(rebootEntity.domain, rebootEntity.entity), JSON.stringify(config));
    }

    if (device.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
        const presets = Object.values(device.ptzCapabilities.presets ?? {});
        if (presets?.length) {
            const commandTopic = getCommandTopic(ptzPresetEntity.entity);
            const stateTopic = getEntityTopic(ptzPresetEntity.entity);

            const config = {
                dev: mqttdevice,
                unique_id: `${idPrefix}-${id}-${ptzPresetEntity.entity}`,
                object_id: `${device.name}_${ptzPresetEntity.entity}`,
                name: `${ptzPresetEntity.name}`,
                platform: 'select',
                command_topic: commandTopic,
                state_topic: stateTopic,
                qos: 0,
                optimistic: false,
                options: presets
            };

            await mqttClient.publish(getDiscoveryTopic(ptzPresetEntity.domain, ptzPresetEntity.entity), JSON.stringify(config));
        }

        const commandEntities = getPtzCommandEntities(device);

        for (const commandEntity of commandEntities) {
            const commandTopic = getCommandTopic(commandEntity.entity);

            const config = {
                dev: mqttdevice,
                unique_id: `${idPrefix}-${id}-${commandEntity.entity}`,
                object_id: `${device.name}_${commandEntity.entity}`,
                name: `${commandEntity.name}`,
                platform: 'button',
                command_topic: commandTopic,
                device_class: commandEntity.deviceClass,
                qos: 0,
                icon: commandEntity.icon
            };

            await mqttClient.publish(getDiscoveryTopic(commandEntity.domain, commandEntity.entity), JSON.stringify(config));
        }
    }

    const publishRule = async (rule: BaseRule) => {
        const { entityId, ruleDeviceId } = getRuleStrings(rule);
        const { getCommandTopic, getEntityTopic } = getMqttTopics(ruleDeviceId);
        const commandTopic = getCommandTopic(entityId);
        const stateTopic = getEntityTopic(entityId);

        if (rule.source === RuleSource.Device) {
            const ruleEnabledConfig = {
                dev: mqttdevice,
                unique_id: `${idPrefix}-${id}-${ruleDeviceId}`,
                object_id: `${device.name}_${ruleDeviceId}`,
                name: `${rule.name} rule`,
                platform: 'switch',
                command_topic: commandTopic,
                state_topic: stateTopic,
                optimistic: false,
                retain: true,
                qos: 0,
            }

            await mqttClient.publish(getDiscoveryTopic('switch', entityId), JSON.stringify(ruleEnabledConfig));
        }


        if (rule.ruleType !== RuleType.Timelapse) {
            const mqttEntities = getRuleMqttEntities(rule);
            for (const mqttEntity of mqttEntities) {
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

                const discoveryTopic = getDiscoveryTopic(domain, entity);
                console.debug(`Discovering following entity ${JSON.stringify({
                    discoveryTopic,
                    config
                })} `);

                await mqttClient.publish(discoveryTopic, JSON.stringify(config));

                if (domain === 'binary_sensor' && rule.ruleType === RuleType.Detection) {
                    await mqttClient.publish(topic, JSON.stringify(false));
                }
            }
        }
    }

    for (const rule of rules) {
        await publishRule(rule);
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
    storeImageFn?: StoreImageFn
}) => {
    const { mqttClient, device, detections = [], triggerTime, console, b64Image, image, reset, room, storeImageFn } = props;
    try {
        const { getEntityTopic } = getMqttTopics(device.id);

        for (const detection of detections) {
            const detectionClass = detectionClassesDefaultMap[detection.className];
            if (detectionClass) {
                const entitiesToPublish = deviceClassMqttEntitiesGrouped[detectionClass] ?? [];
                console.debug(`Relevant detections to publish: ${JSON.stringify({ detections, entitiesToPublish, b64Image })}`);

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
                        storeImageFn && storeImageFn({
                            device,
                            name: `object-detection-${entry.className}`,
                            imageMo: image,
                            timestamp: triggerTime,
                            b64Image
                        }).catch(console.log);
                    }

                    if (value) {
                        await mqttClient.publish(getEntityTopic(entity), value, retain);
                    }
                }

                const person = detection.label;
                if (isFaceClassname(detection.className) && person && room) {
                    const { personId } = getPersonStrings(person);
                    const { getEntityTopic } = getMqttTopics(peopleTrackerId);
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
    device?: ScryptedDeviceBase,
    isRecording?: boolean,
    console: Console,
    rulesToEnable: BaseRule[],
    rulesToDisable: BaseRule[],
}) => {
    const { device, mqttClient, isRecording, rulesToDisable, rulesToEnable, console } = props;

    if (device) {
        const { getEntityTopic } = getMqttTopics(device.id);

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

    for (const rule of rulesToEnable) {
        await publishRuleCurrentlyActive({
            console: console,
            mqttClient,
            rule,
            active: true
        });
    }

    for (const rule of rulesToDisable) {
        await publishRuleCurrentlyActive({
            console: console,
            mqttClient,
            rule,
            active: false
        });
    }
}

const publishRuleData = async (props: {
    device: ScryptedDeviceBase,
    rule: DetectionRule | OccupancyRule,
    console: Console,
    mqttClient: MqttClient,
    image: MediaObject,
    b64Image: string,
    triggerTime: number,
    storeImageFn?: StoreImageFn,
    triggerValue?: boolean
}) => {
    const { console, device, mqttClient, rule, b64Image, image, triggerTime, storeImageFn, triggerValue } = props;
    const mqttEntities = getRuleMqttEntities(rule).filter(entity => entity.deviceClass !== 'running');
    console.debug(`Rule entities to publish: ${JSON.stringify({
        rule,
        mqttEntities,
        b64Image,
        triggerValue,
    })}`);

    const { ruleDeviceId } = getRuleStrings(rule);
    const { getEntityTopic } = getMqttTopics(ruleDeviceId);

    for (const entry of mqttEntities) {
        const { entity, domain } = entry;
        let value: any;
        let retain: true;

        if (domain === 'binary_sensor') {
            value = triggerValue ?? false;
        } else if (entity.includes('LastTrigger')) {
            value = new Date(triggerTime).toISOString();
        } else if (entity.includes('LastImage') && b64Image) {
            value = b64Image || null;
            retain = true;
            storeImageFn && storeImageFn({
                device,
                name: `rule-${rule.name}`,
                imageMo: image,
                timestamp: triggerTime,
                b64Image
            }).catch(console.log);
        }

        if (value !== undefined) {
            await mqttClient.publish(getEntityTopic(entity), value, retain);
        }
    }
}

export const publishRuleCurrentlyActive = async (props: {
    rule: BaseRule,
    console: Console,
    mqttClient: MqttClient,
    active?: boolean
}) => {
    const { mqttClient, rule, active } = props;
    const mqttEntity = getRuleMqttEntities(rule).find(entity => entity.deviceClass === 'running');

    const { ruleDeviceId } = getRuleStrings(rule);
    const { getEntityTopic } = getMqttTopics(ruleDeviceId);

    const { entity } = mqttEntity;

    await mqttClient.publish(getEntityTopic(entity), active ?? false, true);
}

export const publishDeviceState = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    triggered: boolean,
    b64Image?: string,
    image?: MediaObject,
    detection?: ObjectDetectionResult,
    resettAllClasses?: boolean,
    rule?: DetectionRule,
    allRuleIds?: string[],
    triggerTime: number,
    storeImageFn?: StoreImageFn
}) => {
    const { mqttClient, device, triggered, console, detection, b64Image, resettAllClasses, rule, allRuleIds, triggerTime, image, storeImageFn } = props;
    try {
        const detectionClass = detection?.className ? detectionClassesDefaultMap[detection.className] : undefined;
        console.debug(`Trigger entities to publish: ${JSON.stringify(triggeredEntity)}`);
        const { getEntityTopic } = getMqttTopics(device.id);

        const { entity } = triggeredEntity;

        const value: any = triggered;
        const retain = true;

        if (value !== null) {
            await mqttClient.publish(getEntityTopic(entity), value, retain);
        }

        if (rule) {
            await publishRuleData({
                b64Image,
                console,
                device,
                image,
                mqttClient,
                rule,
                triggerTime,
                storeImageFn,
            });
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
                    // storeImageFn && storeImageFn({
                    //     device,
                    //     name: `object-detection-${detectionClass}`,
                    //     imageMo: image,
                    //     timestamp: triggerTime,
                    //     b64Image
                    // }).catch(console.log);
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
    occupancyRulesData: OccupancyRuleData[],
    storeImageFn: StoreImageFn
}) => {
    const { mqttClient, device, objectsDetected, occupancyRulesData, console, storeImageFn } = props;
    try {
        const { getEntityTopic } = getMqttTopics(device.id);

        const entities = deviceClassMqttEntities.filter(entity => entity.entity.includes('Objects'));
        for (const classEntity of entities) {
            const classObjects = objectsDetected.detections.filter(det => classEntity.className === detectionClassesDefaultMap[det.className])?.length;

            await mqttClient.publish(getEntityTopic(classEntity.entity), classObjects, true);
        }

        for (const occupancyRuleData of occupancyRulesData) {
            const { occupies, rule, b64Image, image, triggerTime } = occupancyRuleData;
            await publishRuleData({
                b64Image,
                console,
                device,
                image,
                mqttClient,
                rule,
                triggerTime,
                storeImageFn,
                triggerValue: occupies
            });
        }
    } catch (e) {
        console.log(`Error in publishOccupancy ${JSON.stringify({
            objectsDetected,
            occupancyRulesData
        })}`, e);
    }
}
