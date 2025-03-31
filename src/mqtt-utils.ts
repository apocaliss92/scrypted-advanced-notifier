import sdk, { MediaObject, ObjectDetectionResult, ObjectsDetected, PanTiltZoomCommand, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';
import { cloneDeep, groupBy } from 'lodash';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { OccupancyRuleData } from './cameraMixin';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isFaceClassname, isLabelDetection, parentDetectionClassMap } from './detecionClasses';
import { BaseRule, DetectionRule, getWebooks, RuleSource, RuleType, StoreImageFn, storeWebhookImage, toKebabCase, toSnakeCase, toTitleCase } from './utils';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'image' | 'switch' | 'button' | 'select';
    name: string;
    className?: DetectionClass,
    key?: string,
    deviceClass?: string,
    icon?: string;
    entityCategory?: 'diagnostic' | 'config';
    valueToDispatch?: string;
    forceDiscoveryId?: string;
    forceStateId?: string;
    forceCommandId?: string;
    options?: string[];
}

interface AutodiscoveryConfig {
    dev: object;
    unique_id: string;
    object_id?: string;
    name: string;
    platform: MqttEntity['domain'];
    optimistic: boolean;
    retain: boolean;
    qos: 0 | 1 | 2;
    device_class: string;
    icon?: string;
    entity_category: MqttEntity['entityCategory'];
    options: string[];
    payload_on?: string;
    payload_off?: string;
    state_topic?: string;
    command_topic?: string;
    image_topic?: string;
    image_encoding?: 'b64';
}

export const detectionClassForObjectsReporting = [DetectionClass.Animal, DetectionClass.Person, DetectionClass.Vehicle];

const idPrefix = 'scrypted-an';
const namePrefix = 'Scrypted AN';
const peopleTrackerId = 'people-tracker';
const mainRuleId = 'main-rule';

const scryptedIdPrefix = 'scrypted-an';
const pluginId = 'plugin';

const triggeredEntity: MqttEntity = {
    entity: 'triggered',
    name: 'Notification triggered',
    domain: 'binary_sensor',
    valueToDispatch: 'false'
};

const batteryEntity: MqttEntity = {
    domain: 'sensor',
    entity: 'battery',
    name: 'Battery',
    deviceClass: 'battery',
    entityCategory: 'diagnostic'
};
const onlineEntity: MqttEntity = {
    domain: 'binary_sensor',
    entity: 'online',
    name: 'Online',
    deviceClass: 'power',
    entityCategory: 'diagnostic'
};
const recordingEntity: MqttEntity = {
    domain: 'switch',
    entity: 'recording',
    name: 'Recording',
    icon: 'mdi:record-circle-outline',
    entityCategory: 'diagnostic'
};
const rebootEntity: MqttEntity = {
    domain: 'button',
    entity: 'reboot',
    name: 'Reboot',
    deviceClass: 'restart'
};
const ptzPresetEntity: MqttEntity = {
    domain: 'select',
    entity: 'ptz-preset',
    name: 'PTZ preset',
    deviceClass: 'restart',
};
const ptzZoomInEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz-zoom-in',
    name: 'Zoom in',
    icon: 'mdi:magnify-plus',
};
const ptzZoomOutEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz-zoom-out',
    name: 'Zoom out',
    icon: 'mdi:magnify-minus'
};
const ptzUpEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz-move-up',
    name: 'Move up',
    icon: 'mdi:arrow-up-thick'
};
const ptzDownEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz-move-down',
    name: 'Move down',
    icon: 'mdi:arrow-down-thick'
};
const ptzLeftEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz-move-left',
    name: 'Move left',
    icon: 'mdi:arrow-left-thick'
};
const ptzRightEntity: MqttEntity = {
    domain: 'button',
    entity: 'ptz-move-right',
    name: 'Move right',
    icon: 'mdi:arrow-right-thick'
};

const getBasicMqttAutodiscoveryConfiguration = (props: {
    mqttEntity: MqttEntity,
    mqttDevice: AutodiscoveryConfig['dev'],
    deviceId: string,
    additionalProps?: Partial<AutodiscoveryConfig>,
    stateTopic: string,
    commandTopic?: string,
}) => {
    const { mqttEntity, mqttDevice, deviceId, additionalProps = {}, stateTopic, commandTopic } = props;
    const { entity, domain, name, icon, deviceClass, entityCategory, options } = mqttEntity;

    const config: AutodiscoveryConfig = {
        dev: mqttDevice,
        unique_id: `${scryptedIdPrefix}-${deviceId}-${toKebabCase(entity)}`,
        // object_id: `${scryptedIdPrefix}-${deviceId}-${toKebabCase(entity)}`,
        name,
        platform: domain,
        optimistic: false,
        retain: true,
        qos: 0,
        device_class: deviceClass,
        icon,
        entity_category: entityCategory,
        options,
        ...additionalProps
    };

    if (domain === 'binary_sensor') {
        config.payload_on = 'true';
        config.payload_off = 'false';
        config.state_topic = stateTopic;
    } else if (domain === 'image') {
        config.image_topic = stateTopic;
        config.image_encoding = 'b64';
        config.state_topic = stateTopic;
    } else if (domain === 'sensor') {
        config.state_topic = stateTopic;
    } else if (domain === 'switch') {
        config.state_topic = stateTopic;
        config.command_topic = commandTopic;
    } else if (domain === 'button') {
        config.command_topic = commandTopic;
    } else if (domain === 'select') {
        config.command_topic = commandTopic;
        config.state_topic = stateTopic;
    }

    return config;
}

const getVideocameraMqttAutodiscoveryConfiguration = async (props: {
    mqttEntity: MqttEntity,
    device?: ScryptedDeviceBase,
    additionalProps?: Partial<AutodiscoveryConfig>
}) => {
    const { device, mqttEntity, additionalProps = {} } = props;
    const { forceStateId } = mqttEntity;

    const mqttDevice = await getMqttDevice(device);
    const deviceId = forceStateId ?? (device ? device.id : pluginId);

    const { commandTopic, discoveryTopic, stateTopic } = getMqttTopicsV2({ mqttEntity, device });

    const config = getBasicMqttAutodiscoveryConfiguration({
        deviceId,
        mqttDevice,
        mqttEntity,
        stateTopic,
        commandTopic,
        additionalProps,
    });

    return { discoveryTopic, config, stateTopic, commandTopic };
}

const detectedSuffix = '_detected';
const lastDetectionSuffix = '_last_detection';
const lastLabelSuffix = '_last_recognized';
const lastImageSuffix = '_last_image';
const objectsSuffix = '_objects';

const deviceClassMqttEntities: MqttEntity[] = defaultDetectionClasses.flatMap(className => {
    const parsedClassName = toTitleCase(className);
    const entries: MqttEntity[] = [
        {
            entity: `${className}${detectedSuffix}`,
            name: `${parsedClassName} detected`,
            domain: 'binary_sensor',
            className,
            valueToDispatch: 'false'
        },
        {
            entity: `${className}${lastImageSuffix}`,
            name: `${parsedClassName} last image `,
            domain: 'image',
            className
        },
        {
            entity: `${className}${lastDetectionSuffix}`,
            name: `${parsedClassName} last detection`,
            domain: 'sensor',
            className,
            icon: 'mdi:clock',
            deviceClass: 'timestamp'
        },
    ];

    if (isLabelDetection(className)) {
        entries.push({ entity: `${className}${lastLabelSuffix}`, name: `${parsedClassName} last recognized`, domain: 'sensor', className });
    }

    if (detectionClassForObjectsReporting.includes(className)) {
        entries.push({ entity: `${className}${objectsSuffix}`, name: `${parsedClassName} objects`, domain: 'sensor', className });
    }

    return entries;
});

export const getDetectionRuleId = (rule: BaseRule) => `${rule.source}_${rule.name.replaceAll(/\s/g, '')}`;

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

const ruleRunningSuffix = '_running';
const ruleActiveSuffix = '_active';
const ruleTriggeredSuffix = '_triggered';
const ruleLastDetectionSuffix = '_last_detection';

const getRuleMqttEntitiesV2 = (props: {
    rule: BaseRule,
    device?: ScryptedDeviceBase,
}): MqttEntity[] => {
    const { rule, device } = props;
    const { name } = rule;
    const entity = toSnakeCase(name);
    const parsedName = toTitleCase(name);
    const isPluginRuleForDevice = rule.source === RuleSource.Plugin && !!device;

    const forcedId = isPluginRuleForDevice ? pluginId : undefined;
    const switchEntity: MqttEntity = {
        entity: `${entity}${ruleActiveSuffix}`,
        name: `${parsedName} active`,
        domain: 'switch',
        entityCategory: 'config'
    };
    const runningEntity: MqttEntity = {
        entity: `${entity}${ruleRunningSuffix}`,
        name: `${parsedName} running`,
        domain: 'binary_sensor',
        deviceClass: 'running',
        entityCategory: 'diagnostic',
        forceStateId: forcedId,
        forceCommandId: forcedId,
    };
    const triggeredEntity: MqttEntity = {
        entity: `${entity}${ruleTriggeredSuffix}`,
        name: `${parsedName} triggered`,
        domain: 'binary_sensor',
        deviceClass: 'motion',
        forceStateId: forcedId,
        forceCommandId: forcedId,
    };
    const lastImageEntity: MqttEntity = {
        entity: `${entity}${lastImageSuffix}`,
        name: `${parsedName} last image `,
        domain: 'image',
    };
    const lastTriggerEntity: MqttEntity = {
        entity: `${entity}${ruleLastDetectionSuffix}`,
        name: `${parsedName} last triggered`,
        domain: 'sensor',
        icon: 'mdi:clock',
        deviceClass: 'timestamp',
        forceStateId: forcedId,
        forceCommandId: forcedId,
    };

    const entities: MqttEntity[] = [
        runningEntity,
    ];

    if (!isPluginRuleForDevice) {
        entities.push(switchEntity);
    }

    if (rule.ruleType !== RuleType.Timelapse) {
        entities.push(
            triggeredEntity,
            lastImageEntity,
            lastTriggerEntity,
        );
    }

    return entities;
}

const getPersonMqttEntity = (person: string) => {
    const personId = toSnakeCase(person);
    const personName = toTitleCase(person);

    const personEntity: MqttEntity = {
        entity: `${personId}`,
        name: `${personName}`,
        domain: 'sensor',
        icon: 'mdi:account',
        forceStateId: peopleTrackerId
    };

    return personEntity;
}

const getTrackedPersonMqttAutodiscoveryConfiguration = async (props: {
    person: string
}) => {
    const { person } = props;
    const personEntity = getPersonMqttEntity(person);
    const mqttDevice = {
        ...(await getMqttDevice()),
        ids: `${idPrefix}-${peopleTrackerId}`,
        name: `${namePrefix} people tracker`
    };

    const { stateTopic, discoveryTopic } = getMqttTopicsV2({ mqttEntity: personEntity });

    const config = getBasicMqttAutodiscoveryConfiguration({
        deviceId: peopleTrackerId,
        mqttDevice,
        mqttEntity: personEntity,
        stateTopic,
    });

    return { config, stateTopic, discoveryTopic };
}


const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

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

export const getMqttTopicsV2 = (props: {
    mqttEntity: MqttEntity,
    device?: ScryptedDeviceBase
}) => {
    const { mqttEntity, device } = props;
    const deviceIdParent = device?.id ?? pluginId;
    const { entity, domain, forceStateId, forceCommandId, forceDiscoveryId } = mqttEntity;

    const stateTopic = `scrypted/${idPrefix}-${forceStateId ?? deviceIdParent}/${entity}`;
    const commandTopic = `scrypted/${idPrefix}-${forceCommandId ?? deviceIdParent}/${entity}/set`;
    const infoTopic = `scrypted/${idPrefix}-${stateTopic ?? deviceIdParent}/${entity}/info`;
    const discoveryTopic = `homeassistant/${domain}/${idPrefix}-${forceDiscoveryId ?? deviceIdParent}/${entity}/config`;

    return {
        stateTopic,
        commandTopic,
        infoTopic,
        discoveryTopic
    };
}

const ruleTypeIdMap: Record<RuleType, string> = {
    [RuleType.Detection]: 'detection-rule',
    [RuleType.Occupancy]: 'occupancy-rule',
    [RuleType.Timelapse]: 'timelapse-rule',
    [RuleType.Audio]: 'audio-rule',
}

export const getRuleStrings = (rule: BaseRule) => {
    const entityId = rule.name.trim().replaceAll(' ', '_');
    const id = ruleTypeIdMap[rule.ruleType];
    const ruleDeviceId = rule.deviceId ? `${id}-${rule.name}` : mainRuleId;

    return { entityId, ruleDeviceId };
}

export const getObserveZoneStrings = (zoneName: string, className: DetectionClass) => {
    const parsedClassName = toTitleCase(className);
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

    for (const person of people) {
        const { config, discoveryTopic } = await getTrackedPersonMqttAutodiscoveryConfiguration({ person });

        await mqttClient.publish(discoveryTopic, JSON.stringify(config));
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

        const currentlyActiveEntity = getRuleMqttEntities(detectionRule).find(entity => entity.deviceClass === 'running');

        const activeStateTopic = getEntityTopic(currentlyActiveEntity.entity);
        const currentlyActiveEntityConfig = {
            dev: mqttMainSettingsDevice,
            unique_id: `${mainRuleId}-rule-${currentlyActiveEntity.entity}-active`,
            name: `Main rule ${detectionRule.name} active`,
            platform: currentlyActiveEntity.domain,
            state_topic: activeStateTopic,
            optimistic: false,
            retain: true,
            payload_on: 'true',
            payload_off: 'false',
            qos: 0,
            device_class: currentlyActiveEntity.deviceClass
        };

        await mqttClient.publish(getDiscoveryTopic(currentlyActiveEntity.domain, currentlyActiveEntity.entity), JSON.stringify(currentlyActiveEntityConfig));
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
            const mqttEntity = getRuleMqttEntitiesV2({ rule, device })?.find(item => item.entity.endsWith(ruleActiveSuffix));

            if (mqttEntity) {
                const { commandTopic, stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

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
    }

    await processRules(rules);

    if (switchRecordingCb) {
        const { commandTopic, stateTopic } = getMqttTopicsV2({ mqttEntity: recordingEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                switchRecordingCb(message === 'ON');

                await mqttClient.publish(stateTopic, message);
            }
        });
    }

    if (rebootCb) {
        const { commandTopic } = getMqttTopicsV2({ mqttEntity: rebootEntity, device });
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
            const { stateTopic, commandTopic } = getMqttTopicsV2({ mqttEntity: commandEntity, device });

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

    const triggerEntityToUse: MqttEntity = {
        ...triggeredEntity,
        deviceClass
    }
    const allEntities = [triggerEntityToUse, ...getDeviceClassEntities(device)];
    const entitiesToRun = withDetections ?
        allEntities :
        [triggerEntityToUse];

    if (device.interfaces.includes(ScryptedInterface.Battery)) {
        entitiesToRun.push(cloneDeep(batteryEntity));
    }

    if (device.interfaces.includes(ScryptedInterface.Online)) {
        entitiesToRun.push(cloneDeep(onlineEntity));
    }

    if (device.interfaces.includes(ScryptedInterface.VideoRecorder)) {
        entitiesToRun.push(recordingEntity);
    }

    if (device.interfaces.includes(ScryptedInterface.Reboot)) {
        entitiesToRun.push(rebootEntity);
    }


    if (device.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
        const presets = Object.values(device.ptzCapabilities.presets ?? {});
        if (presets?.length) {
            entitiesToRun.push({ ...ptzPresetEntity, options: presets });
        }

        const commandEntities = getPtzCommandEntities(device);
        entitiesToRun.push(...commandEntities);
    }

    for (const rule of rules) {
        const ruleEntities = getRuleMqttEntitiesV2({ rule, device });
        entitiesToRun.push(...ruleEntities);
    }

    for (const mqttEntity of entitiesToRun) {
        const { config, discoveryTopic, stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

        await mqttClient.publish(discoveryTopic, JSON.stringify(config));

        if (mqttEntity.valueToDispatch) {
            await mqttClient.publish(stateTopic, mqttEntity.valueToDispatch);
        }
    }
}

export const publishResetDetectionsEntities = async (props: {
    mqttClient: MqttClient,
    device: ScryptedDeviceBase,
    allRules: BaseRule[]
}) => {
    const { device, mqttClient, allRules = [] } = props;

    const mqttEntities: MqttEntity[] = [
        ...getDeviceClassEntities(device).filter(item => item.entity.endsWith(detectedSuffix)),
    ];

    for (const rule of allRules) {
        const mqttEntity = getRuleMqttEntitiesV2({ rule, device }).find(item => item.entity.endsWith(ruleTriggeredSuffix));

        if (mqttEntity) {
            mqttEntities.push(mqttEntity);
        }
    }

    for (const mqttEntity of mqttEntities) {
        const { stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

        await mqttClient.publish(stateTopic, false);
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
    room?: string,
    storeImageFn?: StoreImageFn
}) => {
    const { mqttClient, device, detections = [], triggerTime, console, b64Image, image, room, storeImageFn } = props;
    try {
        for (const detection of detections) {
            const detectionClass = detectionClassesDefaultMap[detection.className];
            if (detectionClass) {
                const parentClass = parentDetectionClassMap[detectionClass];
                const specificClassEntries = deviceClassMqttEntitiesGrouped[detectionClass] ?? [];
                const parentClassEntries = parentClass ? deviceClassMqttEntitiesGrouped[parentClass] ?? [] : [];

                const classEntries = [...specificClassEntries, ...parentClassEntries];
                console.debug(`Relevant detections to publish: ${JSON.stringify({ detections, classEntries, b64Image: !!b64Image })}`);

                for (const entry of classEntries) {
                    const { entity } = entry;
                    let value: any;
                    let retain: true;

                    if (entity.endsWith(detectedSuffix)) {
                        value = true;
                    } else if (entity.endsWith(lastLabelSuffix)) {
                        value = detection?.label || null;
                    } else if (entity.endsWith(lastDetectionSuffix)) {
                        value = new Date(triggerTime).toISOString();
                    } else if (entity.endsWith(lastImageSuffix) && b64Image) {
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
                        const { stateTopic } = getMqttTopicsV2({ mqttEntity: entry, device });
                        await mqttClient.publish(stateTopic, value, retain);
                    }
                }

                const person = detection.label;
                if (isFaceClassname(detection.className) && person && room) {
                    const { stateTopic } = await getTrackedPersonMqttAutodiscoveryConfiguration({ person });
                    await mqttClient.publish(stateTopic, room, true);
                }

                if (image) {
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
        if (device.interfaces.includes(ScryptedInterface.Battery) && device.batteryLevel) {
            const { stateTopic } = getMqttTopicsV2({ mqttEntity: batteryEntity, device });
            await mqttClient.publish(stateTopic, device.batteryLevel, true);
        }
        if (device.interfaces.includes(ScryptedInterface.Online)) {
            const { stateTopic } = getMqttTopicsV2({ mqttEntity: onlineEntity, device });
            await mqttClient.publish(stateTopic, device.online, true);
        }
        if (device.interfaces.includes(ScryptedInterface.VideoRecorder)) {
            const { stateTopic } = getMqttTopicsV2({ mqttEntity: recordingEntity, device });
            await mqttClient.publish(stateTopic, isRecording ? 'ON' : 'OFF', true);
        }
    }

    for (const rule of rulesToEnable) {
        await publishRuleCurrentlyActive({
            console: console,
            mqttClient,
            rule,
            active: true,
            device,
        });
    }

    for (const rule of rulesToDisable) {
        await publishRuleCurrentlyActive({
            console: console,
            mqttClient,
            rule,
            active: false,
            device,
        });
    }
}

export const publishRuleData = async (props: {
    device: ScryptedDeviceBase,
    rule: BaseRule,
    console: Console,
    mqttClient: MqttClient,
    image: MediaObject,
    b64Image: string,
    triggerTime: number,
    storeImageFn?: StoreImageFn,
    triggerValue?: boolean
}) => {
    const { console, device, mqttClient, rule, b64Image, image, triggerTime, storeImageFn, triggerValue } = props;
    const mqttEntities = getRuleMqttEntitiesV2({ rule, device });
    console.debug(`Rule entities to publish: ${JSON.stringify({
        rule,
        mqttEntities,
        b64Image,
        triggerValue,
    })}`);

    for (const mqttEntity of mqttEntities) {
        const { entity } = mqttEntity;
        const { config, discoveryTopic, stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

        await mqttClient.publish(discoveryTopic, JSON.stringify(config));

        let value: any;
        let retain = false;

        if (entity.endsWith(ruleTriggeredSuffix)) {
            value = triggerValue ?? false;
        } else if (entity.endsWith(ruleLastDetectionSuffix)) {
            value = new Date(triggerTime).toISOString();
        } else if (entity.endsWith(lastImageSuffix) && b64Image) {
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
            await mqttClient.publish(stateTopic, value, retain);
        }
    }
}

export const publishRuleCurrentlyActive = async (props: {
    rule: BaseRule,
    console: Console,
    mqttClient: MqttClient,
    active?: boolean,
    device?: ScryptedDeviceBase
}) => {
    const { mqttClient, rule, active, device } = props;
    const mqttEntity = getRuleMqttEntitiesV2({ rule, device }).find(item => item.entity.endsWith(ruleRunningSuffix));

    const { stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });
    const isActive = active ?? false;

    await mqttClient.publish(stateTopic, JSON.stringify(isActive));
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
        // Publish the occupancy data for each detection class
        const entities = deviceClassMqttEntities.filter(entity => entity.entity.endsWith(objectsSuffix));
        for (const mqttEntity of entities) {
            const { stateTopic } = getMqttTopicsV2({ mqttEntity, device });
            const classObjects = objectsDetected.detections.filter(det => mqttEntity.className === detectionClassesDefaultMap[det.className])?.length;

            await mqttClient.publish(stateTopic, classObjects, true);
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
