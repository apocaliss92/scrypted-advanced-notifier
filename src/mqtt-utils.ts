import sdk, { Notifier, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, PanTiltZoomCommand, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SecuritySystemMode } from '@scrypted/sdk';
import { cloneDeep, uniq } from 'lodash';
import MqttClient from '../../scrypted-apocaliss-base/src/mqtt-client';
import { DetectionClass, detectionClassesDefaultMap, getParentDetectionClass, isAudioClassname, isLabelDetection } from './detectionClasses';
import { BaseRule, DetectionsPerZone, DeviceInterface, ImageSource, isDetectionRule, RuleSource, RuleType, safeParseJson, toKebabCase, toSnakeCase, toTitleCase } from './utils';
import { OccupancyRuleData } from './states';

export enum MqttEntityIdentifier {
    Triggered = 'Triggered',
    Occupied = 'Occupied',
    RuleActive = 'RuleActive',
    RuleRunning = 'RuleRunning',
    LastImage = 'LastImage',
    PersonRoom = 'PersonRoom',
    LastTrigger = 'LastTrigger',
    LastLabel = 'LastLabel',
    LastDetection = 'LastDetection',
    Detected = 'Detected',
    Object = 'Object',
}

const PAYLOAD_PRESS = 'PRESS';
const PAYLOAD_ON = 'true';
const PAYLOAD_OFF = 'false';

interface MqttEntity {
    entity: 'triggered' | 'lastImage' | 'lastClassname' | 'lastZones' | 'lastLabel' | string;
    domain: 'sensor' | 'binary_sensor' | 'image' | 'switch' | 'button' | 'select' | 'alarm_control_panel';
    name: string;
    className?: string,
    key?: string,
    deviceClass?: string,
    icon?: string;
    entityCategory?: 'diagnostic' | 'config';
    valueToDispatch?: any;
    forceDiscoveryId?: string;
    forceInfoId?: string;
    forceStateId?: string;
    forceCommandId?: string;
    unitOfMeasurement?: string;
    disabled?: boolean;
    stateClass?: string;
    precision?: number;
    options?: string[];
    retain?: boolean;
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
    supported_features?: string[];
    unit_of_measurement?: string;
    json_attributes_topic?: string;
    suggested_display_precision?: number;
    url_topic?: string;
    payload_press?: string;
    command_topic?: string;
    state_class?: string;
    image_topic?: string;
    image_encoding?: 'b64';
    enabled_by_default?: boolean;
    code_disarm_required?: boolean;
    code_arm_required?: boolean;
    code_trigger_required?: boolean;
    payload_arm_away?: SecuritySystemMode;
    payload_arm_home?: SecuritySystemMode;
    payload_arm_night?: SecuritySystemMode;
    payload_disarm?: SecuritySystemMode;
}

export const detectionClassForObjectsReporting = [DetectionClass.Animal, DetectionClass.Person, DetectionClass.Vehicle];

export const idPrefix = 'scrypted-an';
const namePrefix = 'Scrypted AN';
const pluginIds = `${idPrefix}-main-settings`;
const peopleTrackerId = 'people-tracker';
const alarmSystemId = 'alarm-system';
const pluginId = 'plugin';

type MqttDeviceType = typeof pluginId | typeof peopleTrackerId | typeof alarmSystemId | ScryptedDeviceBase;

const getBasicMqttEntities = () => {
    const triggeredEntity: MqttEntity = {
        entity: 'triggered',
        name: 'Notification triggered',
        domain: 'binary_sensor',
        valueToDispatch: PAYLOAD_OFF,
        identifier: MqttEntityIdentifier.Triggered,
        deviceClass: 'motion'
    };
    const batteryEntity: MqttEntity = {
        domain: 'sensor',
        entity: 'battery',
        name: 'Battery',
        deviceClass: 'battery',
        entityCategory: 'diagnostic',
        unitOfMeasurement: '%',
        stateClass: 'measurement',
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
    const notificationsEnabledEntity: MqttEntity = {
        domain: 'switch',
        entity: 'notifications_enabled',
        name: 'Notifications enabled',
        entityCategory: 'diagnostic',
        retain: false,
        icon: 'mdi:bell'
    };
    const occupancyCheckEnabledEntity: MqttEntity = {
        domain: 'switch',
        entity: 'occupancy_check_enabled',
        name: 'Occupancy detection enabled',
        entityCategory: 'diagnostic',
        retain: false,
        icon: 'mdi:camera-metering-spot'
    };
    const audioPressureEntity: MqttEntity = {
        domain: 'sensor',
        entity: 'sound_pressure',
        name: 'Audio level',
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
        retain: false,
    };
    const snapshotsEntity: MqttEntity = {
        domain: 'switch',
        entity: 'snapshots',
        name: 'Snapshots',
        icon: 'mdi:camera',
        entityCategory: 'diagnostic',
        retain: false,
    };
    const rebroadcastEntity: MqttEntity = {
        domain: 'switch',
        entity: 'rebroadcast',
        name: 'Rebroadcast',
        icon: 'mdi:broadcast',
        entityCategory: 'diagnostic',
        retain: false,
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
    const snoozeEntity: MqttEntity = {
        domain: 'button',
        entity: 'snooze',
        name: 'Snooze',
        disabled: true,
        icon: 'mdi:alarm-snooze'
    };
    const alarmSystemEntity: MqttEntity = {
        domain: 'alarm_control_panel',
        entity: 'alarm-system',
        name: 'Alarm system',
        retain: false,
    };
    const rpcObjectsEntity: MqttEntity = {
        domain: 'sensor',
        entity: 'rpc_objects',
        name: 'RPC objects',
        entityCategory: 'diagnostic',
        icon: 'mdi:code-json',
        retain: true,
        stateClass: 'measurement',
        precision: 0,
    };
    const rssMemoryEntity: MqttEntity = {
        domain: 'sensor',
        entity: 'rss_memory',
        name: 'RSS memory',
        unitOfMeasurement: 'MB',
        precision: 0,
        stateClass: 'measurement',
        entityCategory: 'diagnostic',
        icon: 'mdi:memory',
        retain: true,
    };
    const heapMemoryEntity: MqttEntity = {
        domain: 'sensor',
        entity: 'heap_memory',
        name: 'Heap memory',
        unitOfMeasurement: 'MB',
        precision: 0,
        stateClass: 'measurement',
        entityCategory: 'diagnostic',
        icon: 'mdi:memory',
        retain: true,
    };
    const pendingResultsEntity: MqttEntity = {
        domain: 'sensor',
        entity: 'pending_results',
        name: 'Pending results',
        entityCategory: 'diagnostic',
        icon: 'mdi:progress-clock',
        retain: true,
        stateClass: 'measurement',
        precision: 0,
    };

    return {
        triggeredEntity,
        batteryEntity,
        sleepingEntity,
        notificationsEnabledEntity,
        occupancyCheckEnabledEntity,
        audioPressureEntity,
        onlineEntity,
        recordingEntity,
        snapshotsEntity,
        rebroadcastEntity,
        rebootEntity,
        ptzPresetEntity,
        ptzZoomInEntity,
        ptzZoomOutEntity,
        ptzUpEntity,
        ptzDownEntity,
        ptzLeftEntity,
        ptzRightEntity,
        snoozeEntity,
        alarmSystemEntity,
        rpcObjectsEntity,
        rssMemoryEntity,
        heapMemoryEntity,
        pendingResultsEntity,
    };
}

const getBasicMqttAutodiscoveryConfiguration = (props: {
    mqttEntity: MqttEntity,
    mqttDevice: AutodiscoveryConfig['dev'],
    deviceId: string,
    additionalProps?: Partial<AutodiscoveryConfig>,
    stateTopic: string,
    commandTopic?: string,
    infoTopic?: string,
}) => {
    const { mqttEntity, mqttDevice, deviceId, additionalProps = {}, stateTopic, commandTopic, infoTopic } = props;
    const { entity, domain, name, icon, deviceClass, entityCategory, options, unitOfMeasurement, stateClass, precision, disabled } = mqttEntity;

    const config: AutodiscoveryConfig = {
        dev: mqttDevice,
        unique_id: `${idPrefix}-${deviceId}-${toKebabCase(entity)}`,
        name,
        platform: domain,
        optimistic: false,
        retain: false,
        // retain: true,
        qos: 0,
        device_class: deviceClass,
        state_class: stateClass,
        icon,
        entity_category: entityCategory,
        unit_of_measurement: unitOfMeasurement,
        suggested_display_precision: precision,
        json_attributes_topic: infoTopic,
        options,
        ...additionalProps
    };

    if (disabled) {
        config.enabled_by_default = false;
    }

    if (domain === 'binary_sensor') {
        config.payload_on = PAYLOAD_ON;
        config.payload_off = PAYLOAD_OFF;
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
        config.payload_on = PAYLOAD_ON;
        config.payload_off = PAYLOAD_OFF;
    } else if (domain === 'button') {
        config.command_topic = commandTopic;
        config.payload_press = PAYLOAD_PRESS;
    } else if (domain === 'select') {
        config.command_topic = commandTopic;
        config.state_topic = stateTopic;
    } else if (domain === 'alarm_control_panel') {
        config.command_topic = commandTopic;
        config.state_topic = stateTopic;
        config.supported_features = ['arm_home', 'arm_away', 'arm_night', 'trigger'];
        config.code_arm_required = false;
        config.code_disarm_required = false;
        config.code_trigger_required = false;
        config.payload_arm_away = SecuritySystemMode.AwayArmed;
        config.payload_arm_night = SecuritySystemMode.NightArmed;
        config.payload_arm_home = SecuritySystemMode.HomeArmed;
        config.payload_disarm = SecuritySystemMode.Disarmed;
    }

    return config;
}

export const getMqttAutodiscoveryConfiguration = async (props: {
    mqttEntity: MqttEntity,
    additionalProps?: Partial<AutodiscoveryConfig>,
    device: MqttDeviceType
}) => {
    const { mqttEntity, additionalProps = {}, device } = props;

    const { mqttDevice, deviceId } = await getMqttDevice(device);

    const { commandTopic, discoveryTopic, stateTopic, infoTopic } = getMqttTopics({ mqttEntity, device });

    const config = getBasicMqttAutodiscoveryConfiguration({
        deviceId,
        mqttDevice,
        mqttEntity,
        stateTopic,
        commandTopic,
        additionalProps,
        infoTopic,
    });

    return { discoveryTopic, config, stateTopic, commandTopic };
}

const lastDetectionSuffix = '_last_detection';
const lastImageSuffix = '_last_image';

const getDetectionClassMqttEntities = (classes: string[]) => classes.flatMap(className => {
    const parsedClassName = toTitleCase(className);
    const isAudio = isAudioClassname(className);
    const entries: MqttEntity[] = [
        {
            entity: `${className}_detected`,
            name: `${parsedClassName} detected`,
            domain: 'binary_sensor',
            className,
            valueToDispatch: PAYLOAD_OFF,
            deviceClass: isAudio ? 'sound' : 'motion',
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
            disabled: true,
            identifier: MqttEntityIdentifier.LastDetection
        },
    ];

    if (!isAudio && isLabelDetection(className)) {
        entries.push({
            entity: `${className}_last_recognized`,
            name: `${parsedClassName} last recognized`,
            domain: 'sensor',
            className,
            identifier: MqttEntityIdentifier.LastLabel
        });
    }

    if (detectionClassForObjectsReporting.includes(className as DetectionClass)) {
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
    forDiscovery: boolean
}): MqttEntity[] => {
    const { rule, device, forDiscovery } = props;
    const { name } = rule;
    const entity = toSnakeCase(name);
    const parsedName = toTitleCase(name);
    const isPluginRuleForDevice = rule.source === RuleSource.Plugin && !!device;
    const isPluginRuleForPlugin = rule.source === RuleSource.Plugin && !device;
    const isDeviceRuleForDevice = rule.source === RuleSource.Device && !!device;
    const isOwnRule = isPluginRuleForPlugin || isDeviceRuleForDevice

    const switchEntity: MqttEntity = {
        entity: `${entity}_active`,
        name: `${parsedName} active`,
        domain: 'switch',
        entityCategory: 'config',
        retain: false,
        identifier: MqttEntityIdentifier.RuleActive
    };
    const runningEntity: MqttEntity = {
        entity: `${entity}_running`,
        name: `${parsedName} running`,
        domain: 'binary_sensor',
        deviceClass: 'running',
        entityCategory: 'diagnostic',
        identifier: MqttEntityIdentifier.RuleRunning
    };
    const triggeredEntity: MqttEntity = {
        entity: `${entity}_triggered`,
        name: `${parsedName} triggered`,
        domain: 'binary_sensor',
        deviceClass: rule.ruleType === RuleType.Audio ? 'sound' : rule.ruleType === RuleType.Detection ? 'motion' : undefined,
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
        retain: true,
        disabled: true,
        identifier: MqttEntityIdentifier.LastTrigger
    };

    const entities: MqttEntity[] = [
        {
            ...runningEntity,
            disabled: isOwnRule,
            forceStateId: isPluginRuleForDevice ? pluginId : undefined,
        },
    ];

    if (isOwnRule) {
        entities.push(switchEntity);
    }

    if (isDetectionRule(rule)) {
        if (isOwnRule) {
            entities.push(
                triggeredEntity,
                lastImageEntity,
                lastTriggerEntity,
            );
        }

        if (isPluginRuleForDevice) {
            entities.push(
                lastImageEntity,
                triggeredEntity,
                lastTriggerEntity,
            );

            if (!forDiscovery) {
                entities.push(
                    { ...triggeredEntity, forceStateId: pluginId },
                    { ...lastImageEntity, forceStateId: pluginId },
                    { ...lastTriggerEntity, forceStateId: pluginId },
                );
            }
        }

    } else if (rule.ruleType === RuleType.Occupancy && isDeviceRuleForDevice) {
        entities.push(
            occupiedEntity,
            lastImageEntity,
            lastTriggerEntity,
        );
    }

    return entities;
}

const getPersonMqttEntities = (person: string) => {
    const personId = toSnakeCase(person);
    const personName = toTitleCase(person);

    const personEntity: MqttEntity = {
        entity: `${personId}`,
        name: `${personName}`,
        domain: 'sensor',
        icon: 'mdi:account',
        retain: true,
        identifier: MqttEntityIdentifier.PersonRoom
    };
    const lastImageEntity: MqttEntity = {
        entity: `${personId}${lastImageSuffix}`,
        name: `${personName} last image `,
        domain: 'image',
        retain: true,
        identifier: MqttEntityIdentifier.LastImage
    };
    const lastTriggerEntity: MqttEntity = {
        entity: `${personId}${lastDetectionSuffix}`,
        name: `${personName} last triggered`,
        domain: 'sensor',
        icon: 'mdi:clock',
        deviceClass: 'timestamp',
        retain: true,
        disabled: true,
        identifier: MqttEntityIdentifier.LastTrigger
    };

    return [personEntity, lastImageEntity, lastTriggerEntity];
};

// export const deviceClassMqttEntitiesGrouped = groupBy(deviceClassMqttEntities, entry => entry.className);

export const getMqttTopics = (props: {
    mqttEntity: MqttEntity,
    device: MqttDeviceType
}) => {
    const { mqttEntity, device } = props;
    const deviceIdParent = typeof device === 'string' ? device : device?.id;
    const { entity, domain, forceStateId, forceCommandId, forceDiscoveryId, forceInfoId } = mqttEntity;

    const stateTopic = `scrypted/${idPrefix}-${forceStateId ?? deviceIdParent}/${entity}`;
    const commandTopic = `scrypted/${idPrefix}-${forceCommandId ?? deviceIdParent}/${entity}/set`;
    const infoTopic = `scrypted/${idPrefix}-${forceInfoId ?? deviceIdParent}/${entity}/info`;
    const discoveryTopic = `homeassistant/${domain}/${idPrefix}-${forceDiscoveryId ?? deviceIdParent}/${entity}/config`;

    return {
        stateTopic,
        commandTopic,
        infoTopic,
        discoveryTopic
    };
}

const publishMqttEntitiesDiscovery = async (props: { mqttClient?: MqttClient, mqttEntities: MqttEntity[], device: MqttDeviceType, console: Console }) => {
    const { mqttClient, mqttEntities, device, console } = props;

    if (!mqttClient) {
        return;
    }
    const autodiscoveryTopics: string[] = [];
    const entitiesEnsuredReset: string[] = [];

    for (const mqttEntity of mqttEntities) {
        const { discoveryTopic, config, stateTopic, commandTopic } = await getMqttAutodiscoveryConfiguration({ mqttEntity, device });

        console.debug(`Discovering ${JSON.stringify({ mqttEntity, discoveryTopic, config })}`);

        await mqttClient.publish(discoveryTopic, JSON.stringify(config), true);
        if (mqttEntity.valueToDispatch !== undefined) {
            await mqttClient.publish(stateTopic, mqttEntity.valueToDispatch, mqttEntity.retain);
        }
        console.info(`Entity ${mqttEntity.entity} published`);

        if (['switch', 'button'].includes(mqttEntity.domain)) {
            entitiesEnsuredReset.push(commandTopic);
            await mqttClient.publish(commandTopic, '', true);
        }

        autodiscoveryTopics.push(discoveryTopic);
    }

    console.info(`Entities ensured to not be retained: ${entitiesEnsuredReset}`);
    return autodiscoveryTopics;
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

    const mqttEntities: MqttEntity[] = [];

    for (const rule of rules) {
        const ruleEntities = getRuleMqttEntities({ rule, forDiscovery: true });

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

    const peopleEntities: MqttEntity[] = [];
    for (const person of people) {
        const personEntities = getPersonMqttEntities(person);
        peopleEntities.push(...personEntities);
    }

    const {
        notificationsEnabledEntity,
        rpcObjectsEntity,
        rssMemoryEntity,
        heapMemoryEntity,
        pendingResultsEntity,
    } = getBasicMqttEntities();

    mqttEntities.push(
        notificationsEnabledEntity,
        rpcObjectsEntity,
        rssMemoryEntity,
        heapMemoryEntity,
        pendingResultsEntity,
    );

    const pluginTopics = await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, console, device: pluginId });
    const peopleTopics = await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities: peopleEntities, device: peopleTrackerId, console });

    return [
        ...pluginTopics,
        ...peopleTopics,
    ]
}

export const setupAlarmSystemAutodiscovery = async (props: {
    mqttClient?: MqttClient,
    console: Console,
}) => {
    const { mqttClient, console } = props;

    if (!mqttClient) {
        return;
    }

    const mqttEntities: MqttEntity[] = [];

    const {
        alarmSystemEntity,
    } = getBasicMqttEntities();

    mqttEntities.push(alarmSystemEntity);

    return await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, device: alarmSystemId, console, });
}

export const subscribeToPluginMqttTopics = async (
    props: {
        mqttClient?: MqttClient,
        entitiesActiveTopic?: string,
        rules: BaseRule[],
        activeEntitiesCb: (activeEntities: string[]) => void,
        switchNotificationsEnabledCb: (active: boolean) => void,
        console: Console,
        activationRuleCb: (props: {
            ruleName: string;
            active: boolean
        }) => void
    }
) => {
    const {
        activeEntitiesCb,
        entitiesActiveTopic,
        mqttClient,
        rules,
        activationRuleCb,
        switchNotificationsEnabledCb
    } = props;

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

    const { notificationsEnabledEntity } = getBasicMqttEntities();

    if (switchNotificationsEnabledCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device: pluginId });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchNotificationsEnabledCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchNotificationsEnabledCb(false);
                }

                await mqttClient.publish(stateTopic, message, notificationsEnabledEntity.retain);
            }
        });
    }

    for (const rule of rules) {
        const ruleActiveEntity = getRuleMqttEntities({ rule, forDiscovery: false }).find(item => item.identifier === MqttEntityIdentifier.RuleActive);
        if (ruleActiveEntity) {
            const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: ruleActiveEntity, device: pluginId });
            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    if (message === PAYLOAD_ON) {
                        activationRuleCb({
                            active: true,
                            ruleName: rule.name,
                        });
                    } else if (message === PAYLOAD_OFF) {
                        activationRuleCb({
                            active: false,
                            ruleName: rule.name,
                        });
                    }

                    await mqttClient.publish(stateTopic, message, ruleActiveEntity.retain);
                }
            });
        }
    }
}

export const subscribeToAlarmSystemMqttTopics = async (
    props: {
        mqttClient?: MqttClient,
        modeSwitchCb: (mode: SecuritySystemMode) => void,
        console: Console,
    }
) => {
    const {
        mqttClient,
        modeSwitchCb,
    } = props;

    if (!mqttClient) {
        return;
    }

    const { alarmSystemEntity } = getBasicMqttEntities();

    if (modeSwitchCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: alarmSystemEntity, device: alarmSystemId });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                modeSwitchCb(message as SecuritySystemMode);

                await mqttClient.publish(stateTopic, message, alarmSystemEntity.retain);
            }
        });
    }
}

const getPtzCommandEntities = (device: ScryptedDeviceBase) => {
    const {
        ptzDownEntity,
        ptzLeftEntity,
        ptzRightEntity,
        ptzUpEntity,
        ptzZoomInEntity,
        ptzZoomOutEntity,
    } = getBasicMqttEntities();

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

export const subscribeToCameraMqttTopics = async (
    props: {
        mqttClient?: MqttClient,
        rules: BaseRule[],
        device: ScryptedDeviceBase,
        console: Console,
        switchRecordingCb?: (active: boolean) => void,
        switchSnapshotsCb?: (active: boolean) => void,
        switchRebroadcastCb?: (active: boolean) => void,
        switchNotificationsEnabledCb: (active: boolean) => void,
        switchOccupancyCheckCb: (active: boolean) => void,
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
        switchSnapshotsCb,
        switchRebroadcastCb,
        switchNotificationsEnabledCb,
        switchOccupancyCheckCb,
        rebootCb,
        ptzCommandCb,
        device,
    } = props;
    if (!mqttClient) {
        return;
    }

    for (const rule of rules) {
        const mqttEntity = getRuleMqttEntities({ rule, device, forDiscovery: false })?.find(item => item.identifier === MqttEntityIdentifier.RuleActive);

        if (mqttEntity) {
            const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity, device });

            await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
                if (messageTopic === commandTopic) {
                    if (message === PAYLOAD_ON) {
                        activationRuleCb({
                            active: true,
                            ruleName: rule.name,
                            ruleType: rule.ruleType
                        });
                    } else if (message === PAYLOAD_OFF) {
                        activationRuleCb({
                            active: false,
                            ruleName: rule.name,
                            ruleType: rule.ruleType
                        });
                    }

                    await mqttClient.publish(stateTopic, message, mqttEntity.retain);
                }
            });
        }
    }

    const {
        occupancyCheckEnabledEntity,
        notificationsEnabledEntity,
        ptzDownEntity,
        ptzLeftEntity,
        ptzPresetEntity,
        ptzRightEntity,
        ptzUpEntity,
        ptzZoomInEntity,
        ptzZoomOutEntity,
        rebootEntity,
        recordingEntity,
        snapshotsEntity,
        rebroadcastEntity,
    } = getBasicMqttEntities();

    if (switchRecordingCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: recordingEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchRecordingCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchRecordingCb(false);
                }

                await mqttClient.publish(stateTopic, message, recordingEntity.retain);
            }
        });
    }

    if (switchSnapshotsCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: snapshotsEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchSnapshotsCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchSnapshotsCb(false);
                }

                await mqttClient.publish(stateTopic, message, snapshotsEntity.retain);
            }
        });
    }

    if (switchRebroadcastCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: rebroadcastEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchRebroadcastCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchRebroadcastCb(false);
                }

                await mqttClient.publish(stateTopic, message, rebroadcastEntity.retain);
            }
        });
    }

    if (switchNotificationsEnabledCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchNotificationsEnabledCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchNotificationsEnabledCb(false);
                }

                await mqttClient.publish(stateTopic, message, notificationsEnabledEntity.retain);
            }
        });
    }

    if (rebootCb) {
        const { commandTopic } = getMqttTopics({ mqttEntity: rebootEntity, device });
        await mqttClient.subscribe([commandTopic], async (messageTopic) => {
            if (messageTopic === commandTopic) {
                if (messageTopic === PAYLOAD_PRESS) {
                    rebootCb();

                    await mqttClient.publish(commandTopic, '', true);
                }
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
                    } else if (message === PAYLOAD_PRESS) {
                        if (commandEntity.entity === ptzZoomInEntity.entity) {
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

                        await mqttClient.publish(commandTopic, '', true);
                    }
                }
            });
        }
    }

    if (switchOccupancyCheckCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: occupancyCheckEnabledEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchOccupancyCheckCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchOccupancyCheckCb(false);
                }

                await mqttClient.publish(stateTopic, message, occupancyCheckEnabledEntity.retain);
            }
        });
    }
}

export const subscribeToNotifierMqttTopics = async (
    props: {
        mqttClient?: MqttClient,
        device: ScryptedDeviceBase,
        console: Console,
        switchNotificationsEnabledCb: (active: boolean) => void,
        snoozeCb: (props: { snoozeId: string, snoozeTime: number, cameraId: string }) => void,
    }
) => {
    const {
        mqttClient,
        device,
        switchNotificationsEnabledCb,
        snoozeCb,
    } = props;

    if (!mqttClient) {
        return;
    }

    const {
        notificationsEnabledEntity,
        snoozeEntity,
    } = getBasicMqttEntities();

    if (switchNotificationsEnabledCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                if (message === PAYLOAD_ON) {
                    switchNotificationsEnabledCb(true);
                } else if (message === PAYLOAD_OFF) {
                    switchNotificationsEnabledCb(false);
                }

                await mqttClient.publish(stateTopic, message, notificationsEnabledEntity.retain);
            }
        });
    }

    if (snoozeCb) {
        const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: snoozeEntity, device });
        await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
            if (messageTopic === commandTopic) {
                const payload = safeParseJson(message);
                const { snoozeId, snoozeTime, cameraId } = payload;

                if (cameraId && snoozeId && snoozeTime) {
                    snoozeCb({ cameraId, snoozeId, snoozeTime: Number(snoozeTime) });
                    await mqttClient.publish(commandTopic, '', true);
                }
            }
        });
    }
}

export const subscribeToSensorMqttTopics = async (
    props: {
        mqttClient?: MqttClient,
        device: ScryptedDeviceBase,
        console: Console,
    }
) => {
    const {
        mqttClient,
        device,
    } = props;
    if (!mqttClient) {
        return;
    }
    // TODO: Subscribe for rules and so on

    // if (switchNotificationsEnabledCb) {
    //     const { commandTopic, stateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device });
    //     await mqttClient.subscribe([commandTopic, stateTopic], async (messageTopic, message) => {
    //         if (messageTopic === commandTopic) {
    //             switchNotificationsEnabledCb(message === PAYLOAD_ON);

    //             await mqttClient.publish(stateTopic, message, notificationsEnabledEntity.retain);
    //         }
    //     });
    // }
}

const getMqttDevice = async (device: MqttDeviceType) => {
    let deviceId: string;
    let mqttDevice: AutodiscoveryConfig['dev'];

    if (typeof device === 'object') {
        deviceId = device.id;
        const localEndpoint = await sdk.endpointManager.getLocalEndpoint();
        const deviceConfigurationUrl = `${new URL(localEndpoint).origin}/endpoint/@scrypted/core/public/#/device/${deviceId}`;
        mqttDevice = {
            ids: `${idPrefix}-${device.id}`,
            name: `${device.name}`,
            manufacturer: namePrefix,
            model: `${device?.info?.manufacturer ?? ''} ${device?.info?.model ?? ''}`,
            via_device: pluginIds,
            configuration_url: deviceConfigurationUrl
        }
    } else {
        if (device === peopleTrackerId) {
            deviceId = peopleTrackerId;
            mqttDevice = {
                ids: `${idPrefix}-${peopleTrackerId}`,
                name: `${namePrefix} people tracker`,
                manufacturer: namePrefix,
                via_device: pluginIds,
            }
        } else if (device === pluginId) {
            deviceId = pluginId;
            mqttDevice = {
                ids: pluginIds,
                name: `${namePrefix} plugin settings`,
                manufacturer: namePrefix,
            }
        } else if (device === alarmSystemId) {
            deviceId = alarmSystemId;
            mqttDevice = {
                ids: `${idPrefix}-${alarmSystemId}`,
                name: `${namePrefix} alarm system`,
                manufacturer: namePrefix,
                via_device: pluginIds,
            }
        }
    }

    return {
        mqttDevice,
        deviceId,
    }
}

const getCameraClassEntities = async (props: {
    device: ScryptedDeviceBase & ObjectDetector,
    console: Console,
}) => {
    const { console, device } = props;
    const enabledClasses: string[] = [];
    if (device.interfaces.includes(ScryptedInterface.MotionSensor)) {
        enabledClasses.push(DetectionClass.Motion);
    }

    if (device.type === ScryptedDeviceType.Doorbell) {
        enabledClasses.push(DetectionClass.Doorbell);
    }

    if (device.interfaces.includes(ScryptedInterface.ObjectDetector)) {
        try {
            const objectTypes = await device.getObjectTypes();
            const detectionClassesSet = new Set<string>();

            for (const supportedClass of objectTypes.classes) {
                const defaultClass = detectionClassesDefaultMap[supportedClass];
                if (defaultClass || isAudioClassname(supportedClass)) {
                    detectionClassesSet.add(supportedClass);
                } else {
                    console.log(`Class ${supportedClass} not supported`);
                }
            }

            enabledClasses.push(
                ...Array.from(detectionClassesSet),
                DetectionClass.AnyObject,
            );
        } catch { }
    }

    return getDetectionClassMqttEntities(uniq(enabledClasses));
}

const getDetectionZoneEntities = (zones: string[]) => {
    const entries: MqttEntity[] = []

    for (const zone of zones) {
        const entityZoneName = toSnakeCase(zone);

        for (const className of detectionClassForObjectsReporting) {
            const friendlyClassName = toTitleCase(className);
            entries.push(
                {
                    entity: `${entityZoneName}_${className}_detected`,
                    name: `${zone} - ${friendlyClassName} detected`,
                    domain: 'binary_sensor',
                    className,
                    valueToDispatch: PAYLOAD_OFF,
                    deviceClass: 'motion',
                    identifier: MqttEntityIdentifier.Detected
                },
                {
                    entity: `${entityZoneName}_${className}${lastImageSuffix}`,
                    name: `${zone} - ${friendlyClassName} last image`,
                    domain: 'image',
                    className,
                    retain: true,
                    identifier: MqttEntityIdentifier.LastImage
                },
                {
                    entity: `${entityZoneName}_${className}${lastDetectionSuffix}`,
                    name: `${zone} - ${friendlyClassName} last detection`,
                    domain: 'sensor',
                    className,
                    icon: 'mdi:clock',
                    deviceClass: 'timestamp',
                    retain: true,
                    disabled: true,
                    identifier: MqttEntityIdentifier.LastDetection
                },
            );
        }
    }

    return entries;
}

export const setupCameraAutodiscovery = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase & ObjectDetector,
    console: Console,
    rules: BaseRule[],
    zones: string[],
    occupancyEnabled: boolean,
}) => {
    const { device, mqttClient, rules, console, occupancyEnabled, zones } = props;

    if (!mqttClient) {
        return;
    }

    const detectionMqttEntities = (await getCameraClassEntities({ device, console })).filter(entity => {
        if (entity.identifier === MqttEntityIdentifier.Object && !occupancyEnabled) {
            return false;
        } else {
            return true;
        }
    });

    const {
        occupancyCheckEnabledEntity,
        audioPressureEntity,
        batteryEntity,
        notificationsEnabledEntity,
        onlineEntity,
        ptzPresetEntity,
        rebootEntity,
        recordingEntity,
        snapshotsEntity,
        rebroadcastEntity,
        sleepingEntity,
        triggeredEntity,
    } = getBasicMqttEntities();

    const mqttEntities = [
        triggeredEntity,
        notificationsEnabledEntity,
        rebroadcastEntity,
        snapshotsEntity,
        ...detectionMqttEntities
    ];

    if (device.interfaces.includes(ScryptedInterface.ObjectDetector)) {
        mqttEntities.push(cloneDeep(occupancyCheckEnabledEntity));
    }

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

    if (device.interfaces.includes(ScryptedInterface.AudioVolumeControl)) {
        mqttEntities.push(audioPressureEntity);
    }

    if (device.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
        const presets = Object.values(device.ptzCapabilities.presets ?? {});
        if (presets?.length) {
            mqttEntities.push({ ...ptzPresetEntity, options: presets });
        }

        const commandEntities = getPtzCommandEntities(device);
        mqttEntities.push(...commandEntities);
    }

    for (const rule of rules) {
        const ruleEntities = getRuleMqttEntities({ rule, device, forDiscovery: true });

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

    mqttEntities.push(...getDetectionZoneEntities(zones));

    return await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, device, console });
}

export const setupNotifierAutodiscovery = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase & Notifier,
    console: Console,
}) => {
    const { device, mqttClient, console } = props;

    if (!mqttClient) {
        return;
    }

    const {
        notificationsEnabledEntity,
    } = getBasicMqttEntities();

    const mqttEntities = [
        notificationsEnabledEntity,
    ];

    return await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, device, console });
}

export const setupSensorAutodiscovery = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    rules: BaseRule[],
    console: Console,
}) => {
    const { device, mqttClient, console, rules } = props;

    if (!mqttClient) {
        return;
    }

    // const {} = getBasicMqttEntities();

    const mqttEntities = [
    ];

    for (const rule of rules) {
        const ruleEntities = getRuleMqttEntities({ rule, device, forDiscovery: true });

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

    return await publishMqttEntitiesDiscovery({ mqttClient, mqttEntities, device, console });
}

export const publishResetDetectionsEntities = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase & ObjectDetector,
    console: Console,
    classnames?: string[],
    zones: string[],
}) => {
    const { device, mqttClient, console, classnames, zones } = props;

    if (!mqttClient) {
        return;
    }

    let mqttEntities: MqttEntity[] = [
        ...(await getCameraClassEntities({ device, console })),
        ...getDetectionZoneEntities(zones)
    ];

    mqttEntities = mqttEntities.filter(item =>
        item.identifier === MqttEntityIdentifier.Detected &&
        (classnames ? classnames.includes(item.className) : true)
    );

    console.info(`Resetting detection entities: ${mqttEntities.map(item => item.className).join(', ')}`);

    for (const mqttEntity of mqttEntities) {
        const { stateTopic } = getMqttTopics({ mqttEntity, device });

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

    mqttEntities.push(...getRuleMqttEntities({ rule, device, forDiscovery: false }).filter(item => item.identifier === MqttEntityIdentifier.Triggered));

    for (const mqttEntity of mqttEntities) {
        const { stateTopic } = getMqttTopics({ mqttEntity, device });

        await mqttClient.publish(stateTopic, false, mqttEntity.retain);
    }
}

export const getClassnameEntities = async (props: { device: DeviceInterface, detection: ObjectDetectionResult }) => {
    const { detection, device } = props;
    const objectTypes = await device.getObjectTypes();

    let detectionClass = objectTypes.classes.includes(detection.className) ?
        detection.className :
        detectionClassesDefaultMap[detection.className];

    if (isAudioClassname(detection.className) && detection.label) {
        detectionClass = detection.label
    }

    if (detectionClass) {
        const parentClass = getParentDetectionClass({ className: detectionClass, label: detection.label });
        const specificClassEntries = getDetectionClassMqttEntities([detectionClass]);
        const parentClassEntries = parentClass ? getDetectionClassMqttEntities([parentClass]) ?? [] : [];

        return [...specificClassEntries, ...parentClassEntries];
    } else {
        return [];
    }
}

export const publishBasicDetectionData = async (props: {
    mqttClient?: MqttClient,
    device: DeviceInterface,
    console: Console,
    detection?: ObjectDetectionResult,
    detectionsPerZone: DetectionsPerZone,
    triggerTime: number,
}) => {
    const {
        mqttClient,
        device,
        detection,
        triggerTime,
        console,
        detectionsPerZone,
    } = props;

    if (!mqttClient) {
        return;
    }

    try {
        const classEntries = await getClassnameEntities({
            detection,
            device
        });

        classEntries.push(...getZoneEntities(detectionsPerZone));

        console.debug(`Relevant detections to publish: ${JSON.stringify({ detection, classEntries })}`);

        for (const entry of classEntries.filter(entity => entity.identifier !== MqttEntityIdentifier.LastImage)) {
            const { identifier, retain } = entry;
            let value: any;

            if (identifier === MqttEntityIdentifier.Detected) {
                value = true;
            } else if (identifier === MqttEntityIdentifier.LastLabel) {
                value = detection?.label || null;
            } else if (identifier === MqttEntityIdentifier.LastDetection) {
                if (triggerTime) {
                    value = new Date(triggerTime).toISOString();
                }
            }

            if (value) {
                const { stateTopic } = getMqttTopics({ mqttEntity: entry, device });
                await mqttClient.publish(stateTopic, value, retain);
            }
        }
    } catch (e) {
        console.log(`Error publishing ${JSON.stringify({
            detection,
            triggerTime,
        })}`, e);
    }
}

export const publishPeopleData = async (props: {
    mqttClient?: MqttClient,
    console: Console,
    faces: string[],
    b64Image?: string,
    room?: string,
    imageSource: ImageSource,
    triggerTime?: number,
}) => {
    const {
        mqttClient,
        console,
        room,
        b64Image,
        faces,
        imageSource,
        triggerTime,
    } = props;

    if (!mqttClient) {
        return;
    }

    try {

        for (const face of faces) {
            const personEntities = getPersonMqttEntities(face);

            for (const entry of personEntities) {
                const { identifier, retain } = entry;
                let value: any;

                if (identifier === MqttEntityIdentifier.LastImage && b64Image) {
                    console.log(`Person ${face} found in ${room}, image found from ${imageSource}`);
                    value = b64Image || null;
                } else if (identifier === MqttEntityIdentifier.PersonRoom && room) {
                    value = room;
                } else if (identifier === MqttEntityIdentifier.LastTrigger && triggerTime) {
                    value = new Date(triggerTime).toISOString();
                }

                if (value) {
                    const { stateTopic } = getMqttTopics({ mqttEntity: entry, device: peopleTrackerId });
                    await mqttClient.publish(stateTopic, value, retain);
                }
            }
        }
    } catch (e) {
        console.log(`Error publishing faces data ${JSON.stringify({
            faces,
        })}`, e);
    }
}

const getZoneEntities = (detectionsPerZone: DetectionsPerZone) => {
    const entries: MqttEntity[] = [];

    const zones = detectionsPerZone.keys();
    for (const zone of zones) {
        const zoneEntities = getDetectionZoneEntities([zone]);
        const classesInZone: string[] = Array.from(detectionsPerZone.get(zone).values());

        entries.push(...zoneEntities.filter(item => classesInZone.includes(item.className)));
    }

    return entries;
}

export const publishClassnameImages = async (props: {
    mqttClient?: MqttClient,
    device: DeviceInterface,
    console: Console,
    triggerTime: number,
    detections?: ObjectDetectionResult[],
    b64Image?: string,
    imageUrl?: string,
    detectionsPerZone: DetectionsPerZone,
}) => {
    const {
        mqttClient,
        device,
        detections = [],
        console,
        b64Image,
        detectionsPerZone
    } = props;

    if (!mqttClient) {
        return;
    }
    console.info(`Publishing image for classnames: ${detections.map(data => data.className).join(', ')}`);

    const entries = getZoneEntities(detectionsPerZone)
        .filter(item => item.identifier === MqttEntityIdentifier.LastImage);

    try {
        for (const detection of detections) {
            const classEntries = await getClassnameEntities({
                detection,
                device
            });

            const mqttEntity = classEntries.find(entry => entry.identifier === MqttEntityIdentifier.LastImage);
            entries.push(mqttEntity);
        }

        for (const mqttEntity of entries) {
            const { stateTopic } = getMqttTopics({ mqttEntity, device });
            await mqttClient.publish(stateTopic, b64Image, false);
        }
    } catch (e) {
        console.log(`Error publishing ${JSON.stringify({ detections })}`, e);
    }
}

export const publishCameraValues = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    isRecording?: boolean,
    isSnapshotsEnabled?: boolean,
    isRebroadcastEnabled?: boolean,
    checkOccupancy?: boolean,
    notificationsEnabled: boolean,
    console: Console,
    rulesToEnable: BaseRule[],
    rulesToDisable: BaseRule[],
}) => {
    const {
        device,
        mqttClient,
        isRecording,
        isSnapshotsEnabled,
        isRebroadcastEnabled,
        notificationsEnabled,
        rulesToDisable,
        rulesToEnable,
        console,
        checkOccupancy,
    } = props;

    if (!mqttClient) {
        return;
    }

    const {
        occupancyCheckEnabledEntity,
        batteryEntity,
        notificationsEnabledEntity,
        onlineEntity,
        recordingEntity,
        snapshotsEntity,
        rebroadcastEntity,
        sleepingEntity,
        audioPressureEntity
    } = getBasicMqttEntities();

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
            await mqttClient.publish(stateTopic, isRecording ? PAYLOAD_ON : PAYLOAD_OFF, recordingEntity.retain);
        }
        
        const { stateTopic: snapshotsStateTopic } = getMqttTopics({ mqttEntity: snapshotsEntity, device });
        await mqttClient.publish(snapshotsStateTopic, isSnapshotsEnabled ? PAYLOAD_ON : PAYLOAD_OFF, snapshotsEntity.retain);
       
        const { stateTopic: rebroadcastStateTopic } = getMqttTopics({ mqttEntity: rebroadcastEntity, device });
        await mqttClient.publish(rebroadcastStateTopic, isRebroadcastEnabled ? PAYLOAD_ON : PAYLOAD_OFF, rebroadcastEntity.retain);
       
        if (device.interfaces.includes(ScryptedInterface.AudioVolumeControl)) {
            const { stateTopic } = getMqttTopics({ mqttEntity: audioPressureEntity, device });
            await mqttClient.publish(stateTopic, device.audioVolumes?.dBFS, audioPressureEntity.retain);
        }

        const { stateTopic: notificationsEnabledStateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device });
        await mqttClient.publish(notificationsEnabledStateTopic, notificationsEnabled ? PAYLOAD_ON : PAYLOAD_OFF, notificationsEnabledEntity.retain);

        const { stateTopic: occupancyCheckEnabledEntityTopic } = getMqttTopics({ mqttEntity: occupancyCheckEnabledEntity, device });
        await mqttClient.publish(occupancyCheckEnabledEntityTopic, checkOccupancy ? PAYLOAD_ON : PAYLOAD_OFF, occupancyCheckEnabledEntity.retain);
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

export const publishPluginValues = async (props: {
    mqttClient?: MqttClient,
    notificationsEnabled: boolean,
    rulesToEnable: BaseRule[],
    rulesToDisable: BaseRule[],
    rpcObjects?: number,
    rssMemoryMB?: number,
    heapMemoryMB?: number,
    pendingResults?: number,
}) => {
    const {
        mqttClient,
        notificationsEnabled,
        rulesToDisable,
        rulesToEnable,
        rpcObjects,
        rssMemoryMB,
        heapMemoryMB,
        pendingResults,
    } = props;

    if (!mqttClient) {
        return;
    }

    const {
        notificationsEnabledEntity,
        rpcObjectsEntity,
        rssMemoryEntity,
        heapMemoryEntity,
        pendingResultsEntity,
    } = getBasicMqttEntities();

    const { stateTopic: notificationsEnabledStateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device: pluginId });
    await mqttClient.publish(notificationsEnabledStateTopic, notificationsEnabled ? PAYLOAD_ON : PAYLOAD_OFF, notificationsEnabledEntity.retain);

    if (rpcObjects !== undefined) {
        const { stateTopic } = getMqttTopics({ mqttEntity: rpcObjectsEntity, device: pluginId });
        await mqttClient.publish(stateTopic, String(rpcObjects), rpcObjectsEntity.retain);
    }
    if (rssMemoryMB !== undefined) {
        const { stateTopic } = getMqttTopics({ mqttEntity: rssMemoryEntity, device: pluginId });
        await mqttClient.publish(stateTopic, String(rssMemoryMB), rssMemoryEntity.retain);
    }
    if (heapMemoryMB !== undefined) {
        const { stateTopic } = getMqttTopics({ mqttEntity: heapMemoryEntity, device: pluginId });
        await mqttClient.publish(stateTopic, String(heapMemoryMB), heapMemoryEntity.retain);
    }
    if (pendingResults !== undefined) {
        const { stateTopic } = getMqttTopics({ mqttEntity: pendingResultsEntity, device: pluginId });
        await mqttClient.publish(stateTopic, String(pendingResults), pendingResultsEntity.retain);
    }

    for (const rule of rulesToEnable) {
        await publishRuleCurrentlyActive({
            console: console,
            mqttClient,
            rule,
            active: true,
        });
    }

    for (const rule of rulesToDisable) {
        await publishRuleCurrentlyActive({
            console: console,
            mqttClient,
            rule,
            active: false,
        });
    }
}

export const publishAlarmSystemValues = async (props: {
    mqttClient?: MqttClient,
    mode: string,
    info?: any
}) => {
    const {
        mqttClient,
        info,
        mode
    } = props;

    if (!mqttClient) {
        return;
    }

    const {
        alarmSystemEntity,
    } = getBasicMqttEntities();

    const { stateTopic, infoTopic } = getMqttTopics({ mqttEntity: alarmSystemEntity, device: alarmSystemId });
    await mqttClient.publish(stateTopic, mode, alarmSystemEntity.retain);
    info && await mqttClient.publish(infoTopic, JSON.stringify(info), alarmSystemEntity.retain);
}

export const reportNotifierValues = async (props: {
    mqttClient?: MqttClient,
    device?: ScryptedDeviceBase,
    notificationsEnabled: boolean,
    console: Console,
}) => {
    const { device, mqttClient, notificationsEnabled, console } = props;

    if (!mqttClient) {
        return;
    }

    const {
        notificationsEnabledEntity,
    } = getBasicMqttEntities();

    if (device) {
        const { stateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device });
        await mqttClient.publish(stateTopic, notificationsEnabled ? PAYLOAD_ON : PAYLOAD_OFF, notificationsEnabledEntity.retain);
    }
}

export const reportSensorValues = async (props: {
    mqttClient?: MqttClient,
    device?: ScryptedDeviceBase,
    console: Console,
}) => {
    const { device, mqttClient } = props;

    if (!mqttClient) {
        return;
    }

    if (device) {
        // const { stateTopic } = getMqttTopics({ mqttEntity: notificationsEnabledEntity, device });
        // await mqttClient.publish(stateTopic, notificationsEnabled ? PAYLOAD_ON : PAYLOAD_OFF, notificationsEnabledEntity.retain);
    }
}

export const publishRuleData = async (props: {
    device: ScryptedDeviceBase,
    rule: BaseRule,
    console: Console,
    mqttClient?: MqttClient,
    b64Image: string,
    triggerTime: number,
    triggerValue?: boolean,
    isValueChanged?: boolean
    skipMqttImage?: boolean,
}) => {
    const {
        isValueChanged,
        console,
        device,
        mqttClient,
        rule,
        b64Image,
        triggerTime,
        triggerValue,
        skipMqttImage,
    } = props;

    if (!mqttClient) {
        return;
    }

    let mqttEntities = getRuleMqttEntities({ rule, device, forDiscovery: false });

    if (rule.ruleType === RuleType.Occupancy && !isValueChanged) {
        mqttEntities = mqttEntities.filter(item => item.identifier === MqttEntityIdentifier.Occupied);
    }

    console.info(`Updating data for rule ${rule.name}: triggered ${triggerValue} and image is present: ${!!b64Image}. Entities ${JSON.stringify(mqttEntities)}`);

    for (const mqttEntity of mqttEntities) {
        const { identifier, retain } = mqttEntity;
        const { stateTopic } = getMqttTopics({ mqttEntity, device });

        let value: any;

        if ([MqttEntityIdentifier.Triggered, MqttEntityIdentifier.Occupied].includes(identifier)) {
            if (triggerValue != undefined) {
                value = triggerValue ?? false;
            }
        } else if (identifier === MqttEntityIdentifier.LastTrigger) {
            if (triggerValue != undefined && triggerTime) {
                value = new Date(triggerTime).toISOString();
            }
        } else if (identifier === MqttEntityIdentifier.LastImage && b64Image) {
            if (!skipMqttImage) {
                value = b64Image || null;
            }
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

    const mqttEntity = getRuleMqttEntities({ rule, device, forDiscovery: false }).find(item => item.identifier === MqttEntityIdentifier.RuleRunning);

    const { stateTopic } = getMqttTopics({ mqttEntity, device });
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

    const mqttEntity = getRuleMqttEntities({ rule, device, forDiscovery: false }).find(item => item.identifier === MqttEntityIdentifier.RuleActive);

    const { stateTopic } = getMqttTopics({ mqttEntity, device });
    const isActive = enabled ?? false;

    await mqttClient.publish(stateTopic, JSON.stringify(isActive), mqttEntity.retain);
}

export const publishOccupancy = async (props: {
    mqttClient?: MqttClient,
    device: ScryptedDeviceBase,
    console: Console,
    objectsDetected: ObjectsDetected,
    occupancyRulesData: OccupancyRuleData[],
}) => {
    const { mqttClient, device, objectsDetected, occupancyRulesData, console } = props;

    if (!mqttClient) {
        return;
    }

    try {
        // Publish the occupancy data for each detection class
        const entities = getDetectionClassMqttEntities(detectionClassForObjectsReporting).filter(entity => entity.identifier === MqttEntityIdentifier.Object);
        for (const mqttEntity of entities) {
            const { stateTopic } = getMqttTopics({ mqttEntity, device });
            const classObjects = objectsDetected.detections.filter(det => mqttEntity.className === detectionClassesDefaultMap[det.className])?.length;

            await mqttClient.publish(stateTopic, classObjects, mqttEntity.retain);
        }

        for (const occupancyRuleData of occupancyRulesData) {
            const { occupies, rule, b64Image, triggerTime, changed } = occupancyRuleData;

            await publishRuleData({
                b64Image,
                console,
                device,
                mqttClient,
                rule,
                triggerTime,
                triggerValue: occupies,
                isValueChanged: changed,
            });
        }
    } catch (e) {
        console.log(`Error in publishOccupancy ${JSON.stringify({
            objectsDetected,
            occupancyRulesData
        })}`, e);
    }
}
