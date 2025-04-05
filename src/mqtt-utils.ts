import sdk, { MediaObject, ObjectDetectionResult, ObjectDetector, ObjectsDetected, PanTiltZoomCommand, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';
import { cloneDeep, groupBy } from 'lodash';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { OccupancyRuleData } from './cameraMixin';
import { defaultDetectionClasses, DetectionClass, detectionClassesDefaultMap, isFaceClassname, isLabelDetection, parentDetectionClassMap } from './detecionClasses';
import { BaseRule, getWebooks, isDetectionRule, RuleSource, RuleType, StoreImageFn, storeWebhookImage, toKebabCase, toSnakeCase, toTitleCase } from './utils';

export enum MqttEntityIdentifier {
    Triggered = 'Triggered',
    Occupied = 'Occupied',
    RuleActive = 'RuleActive',
    RuleRunning = 'RuleRunning',
    LastImage = 'LastImage',
    LastTrigger = 'LastTrigger',
    LastLabel = 'LastLabel',
    LastDetection = 'LastDetection',
    Detected = 'Detected',
    Object = 'Object',
}

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'image' | 'switch' | 'button' | 'select';
    name: string;
    className?: DetectionClass,
    key?: string,
    deviceClass?: string,
    icon?: string;
    entityCategory?: 'diagnostic' | 'config';
    valueToDispatch?: any;
    forceDiscoveryId?: string;
    forceStateId?: string;
    forceCommandId?: string;
    unitOfMeasurement?: string;
    stateClass?: string;
    precision?: number;
    options?: string[];
    retain?: boolean;
    cleanupDiscovery?: boolean;
    identifier?: MqttEntityIdentifier;
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
    unit_of_measurement?: string;
    suggested_display_precision?: number;
    url_topic?: string;
    command_topic?: string;
    state_class?: string;
    image_topic?: string;
    image_encoding?: 'b64';
}

type MqttDeviceType = 'Plugin' | 'PeopleTracker' | ScryptedDeviceBase;

export const detectionClassForObjectsReporting = [DetectionClass.Animal, DetectionClass.Person, DetectionClass.Vehicle];

const idPrefix = 'scrypted-an';
const namePrefix = 'Scrypted AN';
const pluginIds = `${idPrefix}-main-settings`;
const peopleTrackerId = 'people-tracker';

const scryptedIdPrefix = 'scrypted-an';
const pluginId = 'plugin';

const triggeredEntity: MqttEntity = {
    entity: 'triggered',
    name: 'Notification triggered',
    domain: 'binary_sensor',
    valueToDispatch: 'false',
    identifier: MqttEntityIdentifier.Triggered,
    deviceClass: 'motion'
};

const batteryEntity: MqttEntity = {
    domain: 'sensor',
    entity: 'battery',
    name: 'Battery',
    deviceClass: 'battery',
    entityCategory: 'diagnostic',
    retain: true,
};
const sleepingEntity: MqttEntity = {
    domain: 'binary_sensor',
    entity: 'sleeping',
    name: 'Sleeping',
    entityCategory: 'diagnostic',
    retain: true,
    icon: 'mdi:sleep'
};
const audioPressureEntity: MqttEntity = {
    domain: 'sensor',
    entity: 'sound_pressure',
    name: 'Sound pressure',
    entityCategory: 'diagnostic',
    deviceClass: 'sound_pressure',
    precision: 1,
    stateClass: 'measurement',
    retain: true,
    unitOfMeasurement: 'dB',
};
const onlineEntity: MqttEntity = {
    domain: 'binary_sensor',
    entity: 'online',
    name: 'Online',
    deviceClass: 'power',
    entityCategory: 'diagnostic',
    retain: true,
};
const recordingEntity: MqttEntity = {
    domain: 'switch',
    entity: 'recording',
    name: 'Recording',
    icon: 'mdi:record-circle-outline',
    entityCategory: 'diagnostic',
    retain: true,
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
    icon: 'mdi:arrow-left-thick',
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
    const { entity, domain, name, icon, deviceClass, entityCategory, options, unitOfMeasurement, stateClass, precision } = mqttEntity;

    const config: AutodiscoveryConfig = {
        dev: mqttDevice,
        unique_id: `${scryptedIdPrefix}-${deviceId}-${toKebabCase(entity)}`,
        name,
        platform: domain,
        optimistic: false,
        retain: true,
        qos: 0,
        device_class: deviceClass,
        state_class: stateClass,
        icon,
        entity_category: entityCategory,
        unit_of_measurement: unitOfMeasurement,
        suggested_display_precision: precision,
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
        // config.url_topic = stateTopic;
    } else if (domain === 'sensor') {
        config.state_topic = stateTopic;
    } else if (domain === 'switch') {
        config.state_topic = stateTopic;
        config.command_topic = commandTopic;
        config.payload_on = 'true';
        config.payload_off = 'false';
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
    device: ScryptedDeviceBase,
    additionalProps?: Partial<AutodiscoveryConfig>
}) => {
    const { device, mqttEntity, additionalProps = {} } = props;

    const mqttDevice = await getMqttDevice(device);
    const deviceId = device.id;

    const { commandTopic, discoveryTopic, stateTopic } = getMqttTopics({ mqttEntity, device });

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

export const getPluginMqttAutodiscoveryConfiguration = async (props: {
    mqttEntity: MqttEntity,
    additionalProps?: Partial<AutodiscoveryConfig>
}) => {
    const { mqttEntity, additionalProps = {} } = props;
    const { forceStateId } = mqttEntity;

    const mqttDevice = await getMqttDevice('Plugin');
    const deviceId = forceStateId ?? pluginId;

    const { commandTopic, discoveryTopic, stateTopic } = getMqttTopics({ mqttEntity });

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

const lastDetectionSuffix = '_last_detection';
const lastImageSuffix = '_last_image';

const deviceClassMqttEntities: MqttEntity[] = defaultDetectionClasses.flatMap(className => {
    const parsedClassName = toTitleCase(className);
    const entries: MqttEntity[] = [
        {
            entity: `${className}_detected`,
            name: `${parsedClassName} detected`,
            domain: 'binary_sensor',
            className,
            valueToDispatch: 'false',
            deviceClass: 'motion',
            identifier: MqttEntityIdentifier.Detected
        },
        {
            entity: `${className}${lastImageSuffix}`,
            name: `${parsedClassName} last image `,
            domain: 'image',
            className,
            retain: true,
            identifier: MqttEntityIdentifier.LastImage
        },
        {
            entity: `${className}${lastDetectionSuffix}`,
            name: `${parsedClassName} last detection`,
            domain: 'sensor',
            className,
            icon: 'mdi:clock',
            deviceClass: 'timestamp',
            retain: true,
            identifier: MqttEntityIdentifier.LastDetection
        },
    ];

    if (isLabelDetection(className)) {
        entries.push({
            entity: `${className}_last_recognized`,
            name: `${parsedClassName} last recognized`,
            domain: 'sensor',
            className,
            identifier: MqttEntityIdentifier.LastLabel
        });
    }

    if (detectionClassForObjectsReporting.includes(className)) {
        entries.push({
            entity: `${className}_objects`,
            name: `${parsedClassName} objects`,
            domain: 'sensor',
            className,
            identifier: MqttEntityIdentifier.Object
        });
    }

    return entries;
});

export const getRuleMqttEntities = (props: {
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
        entity: `${entity}_active`,
        name: `${parsedName} active`,
        domain: 'switch',
        entityCategory: 'config',
        identifier: MqttEntityIdentifier.RuleActive
    };
    const runningEntity: MqttEntity = {
        entity: `${entity}_running`,
        name: `${parsedName} running`,
        domain: 'binary_sensor',
        deviceClass: 'running',
        entityCategory: 'diagnostic',
        forceStateId: forcedId,
        forceCommandId: forcedId,
        identifier: MqttEntityIdentifier.RuleRunning
    };
    const triggeredEntity: MqttEntity = {
        entity: `${entity}_triggered`,
        name: `${parsedName} triggered`,
        domain: 'binary_sensor',
        deviceClass: rule.ruleType === RuleType.Audio ? 'sound' : rule.ruleType === RuleType.Detection ? 'motion' : undefined,
        // forceStateId: forcedId,
        // forceCommandId: forcedId,
        identifier: MqttEntityIdentifier.Triggered
    };
    const occupiedEntity: MqttEntity = {
        entity: `${entity}_occupied`,
        name: `${parsedName} occupied`,
        domain: 'binary_sensor',
        deviceClass: 'occupancy',
        retain: true,
        identifier: MqttEntityIdentifier.Occupied
    };
    const lastImageEntity: MqttEntity = {
        entity: `${entity}${lastImageSuffix}`,
        name: `${parsedName} last image `,
        domain: 'image',
        retain: true,
        identifier: MqttEntityIdentifier.LastImage
    };
    const lastTriggerEntity: MqttEntity = {
        entity: `${entity}${lastDetectionSuffix}`,
        name: `${parsedName} last triggered`,
        domain: 'sensor',
        icon: 'mdi:clock',
        deviceClass: 'timestamp',
        // forceStateId: forcedId,
        // forceCommandId: forcedId,
        retain: true,
        identifier: MqttEntityIdentifier.LastTrigger
    };

    const entities: MqttEntity[] = [
        runningEntity,
    ];

    if (!isPluginRuleForDevice) {
        entities.push(switchEntity);
    }

    if (isDetectionRule(rule)) {
        if (isPluginRuleForDevice || rule.source === RuleSource.Device) {
            entities.push(
                triggeredEntity,
                lastImageEntity,
                lastTriggerEntity,
            );
        }
    } else if (rule.ruleType === RuleType.Occupancy) {
        entities.push(
            occupiedEntity,
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
        forceStateId: peopleTrackerId,
        retain: true,
    };

    return personEntity;
}

const getTrackedPersonMqttAutodiscoveryConfiguration = async (props: {
    person: string
}) => {
    const { person } = props;
    const personEntity = getPersonMqttEntity(person);
    const mqttDevice = await getMqttDevice('PeopleTracker');

    const { stateTopic, discoveryTopic } = getMqttTopics({ mqttEntity: personEntity });

    const config = getBasicMqttAutodiscoveryConfiguration({
        deviceId: peopleTrackerId,
        mqttDevice,
        mqttEntity: personEntity,
        stateTopic,
    });

    return { config, stateTopic, discoveryTopic, personEntity };
}

const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

export const getMqttTopics = (props: {
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

export const getObserveZoneStrings = (zoneName: string, className: DetectionClass) => {
    const parsedClassName = toTitleCase(className);
    const parsedZoneName = zoneName.trim().replaceAll(' ', '_');
    const entityId = `${parsedZoneName}_${className}_Objects`;
    const name = `${parsedZoneName} ${parsedClassName} objects`;

    return { entityId, name };
}

const publishMqttEntitiesDiscovery = async (props: { mqttClient?: MqttClient, mqttEntities: MqttEntity[], device?: ScryptedDeviceBase, console: Console }) => {
    const { mqttClient, mqttEntities, device, console } = props;

    if (!mqttClient) {
        return;
    }

    for (const mqttEntity of mqttEntities) {
        const { discoveryTopic, config, stateTopic } = device ?
            await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device }) :
            await getPluginMqttAutodiscoveryConfiguration({ mqttEntity });

        console.debug(`Discovering ${JSON.stringify({ mqttEntity, discoveryTopic, config })}`)

        if (mqttEntity.cleanupDiscovery) {
            await mqttClient.publish(discoveryTopic, '', true);
            console.info(`Entity ${mqttEntity.entity} unpublished`);
        } else {
            await mqttClient.publish(discoveryTopic, JSON.stringify(config), true);
            if (mqttEntity.valueToDispatch !== undefined) {
                await mqttClient.publish(stateTopic, mqttEntity.valueToDispatch, mqttEntity.retain);
            }
            console.info(`Entity ${mqttEntity.entity} published`);
        }
    }
}

export const setupPluginAutodiscovery = async (props: {
    mqttClient?: MqttClient,
    people: string[],
    console: Console,
    rules: BaseRule[];
}) => {
    const { people, mqttClient, rules, console } = props;

    if (!mqttClient) {
        return;
    }

    for (const person of people) {
        const { config, discoveryTopic } = await getTrackedPersonMqttAutodiscoveryConfiguration({ person });
        await mqttClient.publish(discoveryTopic, JSON.stringify(config), true);
    }

    const mqttEntities: MqttEntity[] = [];

    for (const rule of rules) {
        const ruleEntities = getRuleMqttEntities({ rule });

        for (const mqttEntity of ruleEntities) {
            let entityToPublish = mqttEntity;
            if (mqttEntity.identifier === MqttEntityIdentifier.RuleActive) {
                entityToPublish = {
                    ...mqttEntity,
                    valueToDispatch: rule.isEnabled,
                };
            } else if (mqttEntity.identifier === MqttEntityIdentifier.RuleRunning) {
                entityToPublish = {
                    ...mqttEntity,
                    valueToDispatch: rule.currentlyActive
                };
            }

            mqttEntities.push(entityToPublish);
        }
    }

    await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, console });
}

export const subscribeToPluginMqttTopics = async (
    props: {
        mqttClient?: MqttClient,
        entitiesActiveTopic?: string,
        rules: BaseRule[],
        activeEntitiesCb: (activeEntities: string[]) => void,
        ruleCb: (props: {
            ruleName: string;
            active: boolean
        }) => void
    }
) => {
    const { activeEntitiesCb, entitiesActiveTopic, mqttClient, rules, ruleCb } = props;

    if (!mqttClient) {
        return;
    }

    if (entitiesActiveTopic) {
        mqttClient.subscribe([entitiesActiveTopic], async (messageTopic, message) => {
            const messageString = message.toString();
            if (messageTopic === entitiesActiveTopic) {
                activeEntitiesCb(messageString !== 'null' ? JSON.parse(messageString) : [])
            }
        });
    }

    for (const rule of rules) {
        const ruleActiveEntity = getRuleMqttEntities({ rule }).find(item => item.identifier === MqttEntityIdentifier.RuleActive);

        if (ruleActiveEntity) {
            const { commandTopic, stateTopic } = await getPluginMqttAutodiscoveryConfiguration({ mqttEntity: ruleActiveEntity });
            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    ruleCb({
                        active: message === 'true',
                        ruleName: rule.name,
                    });

                    await mqttClient.publish(stateTopic, message, ruleActiveEntity.retain);
                }
            });
        }
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
        mqttClient?: MqttClient,
        rules: BaseRule[],
        device: ScryptedDeviceBase,
        console: Console,
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
        device,
        console
    } = props;
    if (!mqttClient) {
        return;
    }

    for (const rule of rules) {
        const mqttEntity = getRuleMqttEntities({ rule, device })?.find(item => item.identifier === MqttEntityIdentifier.RuleActive);

        if (mqttEntity) {
            const { commandTopic, stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    activationRuleCb({
                        active: message === 'true',
                        ruleName: rule.name,
                        ruleType: rule.ruleType
                    });

                    await mqttClient.publish(stateTopic, message, mqttEntity.retain);
                }
            });
        }
    }

    if (switchRecordingCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: recordingEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                switchRecordingCb(message === 'true');

                await mqttClient.publish(stateTopic, message, recordingEntity.retain);
            }
        });
    }

    if (rebootCb) {
        const { commandTopic } = getMqttTopics({ mqttEntity: rebootEntity, device });
        await mqttClient.subscribe([commandTopic], async (messageTopic) => {
            if (messageTopic === commandTopic) {
                rebootCb();
            }
        });
    }

    if (ptzCommandCb) {
        const commandEntities = getPtzCommandEntities(device);
        commandEntities.push(ptzPresetEntity);

        for (const commandEntity of commandEntities) {
            const { stateTopic, commandTopic } = getMqttTopics({ mqttEntity: commandEntity, device });

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

const getMqttDevice = async (device: MqttDeviceType) => {
    if (typeof device === 'object') {
        const localEndpoint = await sdk.endpointManager.getLocalEndpoint();
        const deviceConfigurationUrl = `${new URL(localEndpoint).origin}/endpoint/@scrypted/core/public/#/device/${device.id}`;
        return {
            ids: `${idPrefix}-${device.id}`,
            name: `${device.name}`,
            manufacturer: namePrefix,
            model: `${device?.info?.manufacturer ?? ''} ${device?.info?.model ?? ''}`,
            via_device: pluginIds,
            configuration_url: deviceConfigurationUrl
        }
    } else {
        if (device === 'PeopleTracker') {
            return {
                ids: `${idPrefix}-${peopleTrackerId}`,
                name: `${namePrefix} people tracker`,
                manufacturer: namePrefix,
                via_device: pluginIds,
            }
        } else if (device === 'Plugin') {
            return {
                ids: pluginIds,
                name: `${namePrefix} plugin settings`,
                manufacturer: namePrefix,
            }
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
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase & ObjectDetector,
    console: Console,
    rules: BaseRule[],
    deletedRules: BaseRule[],
    occupancyEnabled: boolean,
    withAudio: boolean,
}) => {
    const { device, mqttClient, rules, console, occupancyEnabled, deletedRules, withAudio } = props;

    if (!mqttClient) {
        return;
    }

    const enabledClasses: string[] = [];
    if (device.interfaces.includes(ScryptedInterface.MotionSensor)) {
        enabledClasses.push(DetectionClass.Motion);
    }

    if (device.interfaces.includes(ScryptedInterface.ObjectDetector)) {
        const objectTypes = await device.getObjectTypes();
        enabledClasses.push(...(objectTypes?.classes?.map(classname => detectionClassesDefaultMap[classname]) ?? []));
    }

    const detectionMqttEntities = getDeviceClassEntities(device).map(entity => {
        let cleanupDiscovery = false;
        if (!enabledClasses.includes(detectionClassesDefaultMap[entity.className])) {
            cleanupDiscovery = true;
        } else if (entity.identifier === MqttEntityIdentifier.Object && !occupancyEnabled) {
            cleanupDiscovery = true
        }

        return {
            ...entity,
            cleanupDiscovery,
        };
    })

    const mqttEntities = [triggeredEntity, ...detectionMqttEntities];

    if (device.interfaces.includes(ScryptedInterface.Battery)) {
        mqttEntities.push(cloneDeep(batteryEntity));
    }

    if (device.interfaces.includes(ScryptedInterface.Online)) {
        mqttEntities.push(cloneDeep(onlineEntity));
    }

    if (device.interfaces.includes(ScryptedInterface.Sleep)) {
        mqttEntities.push(cloneDeep(sleepingEntity));
    }

    if (device.interfaces.includes(ScryptedInterface.VideoRecorder)) {
        mqttEntities.push(recordingEntity);
    }

    if (device.interfaces.includes(ScryptedInterface.Reboot)) {
        mqttEntities.push(rebootEntity);
    }

    mqttEntities.push({
        ...audioPressureEntity,
        cleanupDiscovery: !withAudio
    });


    if (device.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
        const presets = Object.values(device.ptzCapabilities.presets ?? {});
        if (presets?.length) {
            mqttEntities.push({ ...ptzPresetEntity, options: presets });
        }

        const commandEntities = getPtzCommandEntities(device);
        mqttEntities.push(...commandEntities);
    }

    for (const rule of rules) {
        const ruleEntities = getRuleMqttEntities({ rule, device });

        for (const mqttEntity of ruleEntities) {
            if (mqttEntity.identifier === MqttEntityIdentifier.RuleActive) {
                mqttEntities.push({
                    ...mqttEntity,
                    valueToDispatch: rule.isEnabled
                });
            } else if (mqttEntity.identifier === MqttEntityIdentifier.RuleRunning) {
                mqttEntities.push({
                    ...mqttEntity,
                    valueToDispatch: rule.currentlyActive
                });
            } else {
                mqttEntities.push(mqttEntity);
            }
        }
    }

    // console.info(`Mqtt entities to discover: ${mqttEntities.map(item => item.name).join(', ')}`);

    for (const rule of deletedRules) {
        const ruleEntities = getRuleMqttEntities({ rule, device });
        for (const mqttEntity of ruleEntities) {
            mqttEntities.push({
                ...mqttEntity,
                cleanupDiscovery: true
            });
        }
    }

    await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, device, console });
}

export const publishResetDetectionsEntities = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    console: Console
}) => {
    const { device, mqttClient, console } = props;

    if (!mqttClient) {
        return;
    }

    const mqttEntities: MqttEntity[] = [
        ...getDeviceClassEntities(device).filter(item => item.identifier === MqttEntityIdentifier.Detected),
    ];

    console.info(`Resetting detection entities: ${mqttEntities.map(item => item.className).join(', ')}`);

    for (const mqttEntity of mqttEntities) {
        const { stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

        await mqttClient.publish(stateTopic, false, mqttEntity.retain);
    }
}

export const publishResetRuleEntities = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    rule: BaseRule,
    console: Console
}) => {
    const { device, mqttClient, rule, console } = props;

    if (!mqttClient) {
        return;
    }

    const mqttEntities: MqttEntity[] = [];

    console.info(`Resetting entities of rule ${rule.name}`);

    const mqttEntity = getRuleMqttEntities({ rule, device }).find(item => item.identifier === MqttEntityIdentifier.Triggered);

    if (mqttEntity) {
        mqttEntities.push(mqttEntity);
    }

    for (const mqttEntity of mqttEntities) {
        const { stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

        await mqttClient.publish(stateTopic, false, mqttEntity.retain);
    }
}

export const publishRelevantDetections = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    detections?: ObjectDetectionResult[],
    triggerTime: number,
    b64Image?: string,
    imageUrl?: string,
    image?: MediaObject,
    room?: string,
    isNvrRule?: boolean,
    storeImageFn?: StoreImageFn
}) => {
    const { mqttClient, device, detections = [], triggerTime, console, b64Image, image, room, storeImageFn, isNvrRule } = props;

    if (!mqttClient) {
        return;
    }

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
                    const { identifier, retain } = entry;
                    let value: any;

                    if (identifier === MqttEntityIdentifier.Detected) {
                        value = true;
                    } else if (identifier === MqttEntityIdentifier.LastLabel) {
                        value = detection?.label || null;
                    } else if (identifier === MqttEntityIdentifier.LastDetection) {
                        value = new Date(triggerTime).toISOString();
                    } else if (identifier === MqttEntityIdentifier.LastImage && b64Image) {
                        // value = imageUrl || null;
                        value = b64Image || null;
                        let name = `object-detection-${entry.className}`;
                        if (isNvrRule) {
                            name += '-NVR';
                        }

                        storeImageFn && storeImageFn({
                            device,
                            name,
                            imageMo: image,
                            timestamp: triggerTime,
                            b64Image
                        }).catch(console.log);
                    }

                    if (value) {
                        const { stateTopic } = getMqttTopics({ mqttEntity: entry, device });
                        await mqttClient.publish(stateTopic, value, retain);
                    }
                }

                const person = detection.label;
                if (isFaceClassname(detection.className) && person && room) {
                    const { stateTopic, personEntity } = await getTrackedPersonMqttAutodiscoveryConfiguration({ person });
                    await mqttClient.publish(stateTopic, room, personEntity.retain);
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

export const publishAudioPressureValue = async (props: {
    mqttClient?: MqttClient,
    console: Console,
    device: ScryptedDeviceBase,
    decibels: number,
}) => {
    const { mqttClient, console, device, decibels } = props;

    if (!mqttClient) {
        return;
    }

    console.info(`Publishing audio update ${decibels}`);
    try {
        const { stateTopic } = getMqttTopics({ mqttEntity: audioPressureEntity, device });
        await mqttClient.publish(stateTopic, decibels, audioPressureEntity.retain);
    } catch (e) {
        console.log(`Error publishing audio pressure: ${decibels}`, e);
    }
}

export const publishClassnameImages = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    triggerTime: number,
    classnames?: string[],
    b64Image?: string,
    imageUrl?: string,
    image?: MediaObject,
    storeImageFn?: StoreImageFn
}) => {
    const { mqttClient, device, classnames = [], console, b64Image, image, triggerTime, storeImageFn } = props;

    if (!mqttClient) {
        return;
    }
    console.info(`Publishing image for classnames: ${classnames.join(', ')}`);

    try {
        for (const classname of classnames) {
            const detectionClass = detectionClassesDefaultMap[classname];
            if (detectionClass) {
                const mqttEntity = deviceClassMqttEntitiesGrouped[detectionClass].find(entry => entry.identifier === MqttEntityIdentifier.LastImage);

                storeImageFn && storeImageFn({
                    device,
                    name: `object-detection-${classname}`,
                    imageMo: image,
                    timestamp: triggerTime,
                    b64Image
                });

                const { stateTopic } = getMqttTopics({ mqttEntity, device });
                await mqttClient.publish(stateTopic, b64Image, false);

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
            } else {
                console.log(`${classname} not found`);
            }
        }
    } catch (e) {
        console.log(`Error publishing ${JSON.stringify({ classnames })}`, e);
    }
}

export const reportDeviceValues = async (props: {
    mqttClient?: MqttClient,
    device?: ScryptedDeviceBase,
    isRecording?: boolean,
    console: Console,
    rulesToEnable: BaseRule[],
    rulesToDisable: BaseRule[],
}) => {
    const { device, mqttClient, isRecording, rulesToDisable, rulesToEnable, console } = props;

    if (!mqttClient) {
        return;
    }

    if (device) {
        if (device.interfaces.includes(ScryptedInterface.Battery) && device.batteryLevel) {
            const { stateTopic } = getMqttTopics({ mqttEntity: batteryEntity, device });
            await mqttClient.publish(stateTopic, device.batteryLevel, batteryEntity.retain);
        }
        if (device.interfaces.includes(ScryptedInterface.Online)) {
            const { stateTopic } = getMqttTopics({ mqttEntity: onlineEntity, device });
            await mqttClient.publish(stateTopic, device.online, onlineEntity.retain);
        }
        if (device.interfaces.includes(ScryptedInterface.Sleep)) {
            const { stateTopic } = getMqttTopics({ mqttEntity: sleepingEntity, device });
            await mqttClient.publish(stateTopic, device.sleeping, sleepingEntity.retain);
        }
        if (device.interfaces.includes(ScryptedInterface.VideoRecorder)) {
            const { stateTopic } = getMqttTopics({ mqttEntity: recordingEntity, device });
            await mqttClient.publish(stateTopic, isRecording ? 'true' : 'false', recordingEntity.retain);
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
    mqttClient?: MqttClient,
    image: MediaObject,
    b64Image: string,
    imageUrl?: string,
    triggerTime: number,
    storeImageFn?: StoreImageFn,
    triggerValue?: boolean,
    isValueChanged?: boolean
}) => {
    const { isValueChanged, console, device, mqttClient, rule, b64Image, image, imageUrl, triggerTime, storeImageFn, triggerValue } = props;

    if (!mqttClient) {
        return;
    }

    console.log(`Updating data for rule ${rule.name}: triggered ${triggerValue} and image is present: ${!!b64Image}`);

    let mqttEntities = getRuleMqttEntities({ rule, device });

    if (rule.ruleType === RuleType.Occupancy && !isValueChanged) {
        mqttEntities = mqttEntities.filter(item => item.identifier === MqttEntityIdentifier.Occupied);
    }

    console.debug(`Publishing rule entities: ${JSON.stringify({
        rule,
        mqttEntities,
        b64Image: b64Image?.substring(0, 10),
        triggerValue,
    })}`);

    for (const mqttEntity of mqttEntities) {
        const { identifier, retain } = mqttEntity;
        const { config, discoveryTopic, stateTopic } = await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device });

        await mqttClient.publish(discoveryTopic, JSON.stringify(config), true);

        let value: any;

        if ([MqttEntityIdentifier.Triggered, MqttEntityIdentifier.Occupied].includes(identifier)) {
            value = triggerValue ?? false;
        } else if (identifier === MqttEntityIdentifier.LastTrigger) {
            value = new Date(triggerTime).toISOString();
        } else if (identifier === MqttEntityIdentifier.LastImage && b64Image) {
            // value = imageUrl;
            value = b64Image || null;
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
    mqttClient?: MqttClient,
    active?: boolean,
    device?: ScryptedDeviceBase
}) => {
    const { mqttClient, rule, active, device } = props;

    if (!mqttClient) {
        return;
    }

    const mqttEntity = getRuleMqttEntities({ rule, device }).find(item => item.identifier === MqttEntityIdentifier.RuleRunning);

    const { stateTopic } = device ?
        await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device }) :
        await getPluginMqttAutodiscoveryConfiguration({ mqttEntity });
    const isActive = active ?? false;

    await mqttClient.publish(stateTopic, JSON.stringify(isActive), mqttEntity.retain);
}

export const publishRuleEnabled = async (props: {
    rule: BaseRule,
    console: Console,
    mqttClient?: MqttClient,
    enabled?: boolean,
    device?: ScryptedDeviceBase
}) => {
    const { mqttClient, rule, enabled, device } = props;

    if (!mqttClient) {
        return;
    }

    const mqttEntity = getRuleMqttEntities({ rule, device }).find(item => item.identifier === MqttEntityIdentifier.RuleActive);

    const { stateTopic } = device ?
        await getVideocameraMqttAutodiscoveryConfiguration({ mqttEntity, device }) :
        await getPluginMqttAutodiscoveryConfiguration({ mqttEntity });
    const isActive = enabled ?? false;

    await mqttClient.publish(stateTopic, JSON.stringify(isActive), mqttEntity.retain);
}

export const publishOccupancy = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    objectsDetected: ObjectsDetected,
    occupancyRulesData: OccupancyRuleData[],
    storeImageFn: StoreImageFn
}) => {
    const { mqttClient, device, objectsDetected, occupancyRulesData, console, storeImageFn } = props;

    if (!mqttClient) {
        return;
    }

    try {
        // Publish the occupancy data for each detection class
        const entities = deviceClassMqttEntities.filter(entity => entity.identifier === MqttEntityIdentifier.Object);
        for (const mqttEntity of entities) {
            const { stateTopic } = getMqttTopics({ mqttEntity, device });
            const classObjects = objectsDetected.detections.filter(det => mqttEntity.className === detectionClassesDefaultMap[det.className])?.length;

            await mqttClient.publish(stateTopic, classObjects, mqttEntity.retain);
        }

        for (const occupancyRuleData of occupancyRulesData) {
            const { occupies, rule, b64Image, image, triggerTime, changed } = occupancyRuleData;

            await publishRuleData({
                b64Image,
                console,
                device,
                image,
                mqttClient,
                rule,
                triggerTime,
                storeImageFn,
                triggerValue: occupies,
                isValueChanged: changed
            });
        }
    } catch (e) {
        console.log(`Error in publishOccupancy ${JSON.stringify({
            objectsDetected,
            occupancyRulesData
        })}`, e);
    }
}
