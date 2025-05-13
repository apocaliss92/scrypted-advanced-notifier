import sdk, { NotificationAction, SecuritySystemMode } from "@scrypted/sdk";
import { StorageSetting, StorageSettings } from "@scrypted/sdk/storage-settings";
import { deviceFilter, getWebooks, sensorsFilter } from "./utils";

export const supportedAlarmModes = [
    SecuritySystemMode.AwayArmed,
    SecuritySystemMode.NightArmed,
    SecuritySystemMode.HomeArmed,
];

export const getAlarmKeys = (props: {
    mode: SecuritySystemMode,
}) => {
    const { mode } = props;

    const bypassableDevicesKey = `${mode}:bypassableDevices`;
    const preActivationTimeKey = `${mode}:preActivationTime`;
    const autoDisarmTimeKey = `${mode}:autoDisarmTime`;

    return {
        bypassableDevicesKey,
        preActivationTimeKey,
        autoDisarmTimeKey,
    };
};

export const getAlarmDefaults = (props: { mode: SecuritySystemMode }) => {
    const { mode } = props;

    let preactivationTime: number;
    let autoDisarmTime: number;

    switch (mode) {
        case (SecuritySystemMode.AwayArmed): {
            preactivationTime = 30;
            autoDisarmTime = 60;
            break;
        }
        case (SecuritySystemMode.HomeArmed): {
            preactivationTime = 0;
            autoDisarmTime = 30;
            break;
        }
        case (SecuritySystemMode.NightArmed): {
            preactivationTime = 0;
            autoDisarmTime = 30;
            break;
        }
    }

    return {
        preactivationTime,
        autoDisarmTime,
    };
}

export const getAlarmSettings = (props: {
    mode: SecuritySystemMode,
}) => {
    const { mode } = props;
    const {
        bypassableDevicesKey,
        preActivationTimeKey,
        autoDisarmTimeKey,
    } = getAlarmKeys({ mode });
    const { autoDisarmTime, preactivationTime } = getAlarmDefaults({ mode });
    const group = `Mode: ${mode}`;

    const bypassableDevicesSetting: StorageSetting = {
        key: bypassableDevicesKey,
        title: `Bypassable devices`,
        description: 'Devices that can be in active state before activating the mode. Devices not present in this list will prevent the mode activation',
        group,
        type: 'device',
        deviceFilter: sensorsFilter,
        multiple: true,
        defaultValue: [],
    };
    const preActivationTimeSetting: StorageSetting = {
        key: preActivationTimeKey,
        title: `Pre activation time (seconds)`,
        description: 'Time to wait until the mode is actually set on manual action',
        group,
        type: 'number',
        defaultValue: preactivationTime,
    };
    const autoDisarmTimeSetting: StorageSetting = {
        key: autoDisarmTimeKey,
        title: `Auto disarm time (seconds)`,
        description: 'Automatically disarm the alarm on trigger. Set 0 to keep the alarm active until manual action',
        group,
        type: 'number',
        defaultValue: autoDisarmTime,
    };

    return [
        bypassableDevicesSetting,
        preActivationTimeSetting,
        autoDisarmTimeSetting,
    ];
};

export interface ModeData {
    currentlyActive: boolean;
    bypassableDevices: string[];
    preActivationTime: number;
    autoDisarmTime: number;
};

export const getModeEntity = (props: {
    mode: SecuritySystemMode,
    storage: StorageSettings<any>,
}) => {
    const { mode, storage } = props;
    const {
        bypassableDevicesKey,
        preActivationTimeKey,
        autoDisarmTimeKey,
    } = getAlarmKeys({ mode });
    const {
        autoDisarmTime: autoDisarmTimeDefault,
        preactivationTime: preactivationTimeDefault } = getAlarmDefaults({ mode });

    const bypassableDevices = storage.getItem(bypassableDevicesKey) as string[] ?? [];
    const preActivationTime = storage.getItem(preActivationTimeKey) as number ?? preactivationTimeDefault;
    const autoDisarmTime = storage.getItem(autoDisarmTimeKey) as number ?? autoDisarmTimeDefault;
    const currentMode = storage.getItem('activeMode') as SecuritySystemMode;

    const data: ModeData = {
        autoDisarmTime,
        bypassableDevices,
        currentlyActive: currentMode === mode,
        preActivationTime,
    };

    return data;
};

export const getAlarmWebhookUrls = async (props: {
    deactivateMessage: string,
    setModeMessage: string,
    modeHomeText: string,
    modeNightText: string,
    modeAwayText: string
}) => {
    const {
        deactivateMessage,
        modeAwayText,
        modeHomeText,
        modeNightText,
        setModeMessage
    } = props;

    const actions: NotificationAction[] = [];

    const { setAlarm } = await getWebooks();

    try {
        const cloudEndpointRaw = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });

        const [cloudEndpoint, parameters] = cloudEndpointRaw.split('?') ?? '';

        const paramString = parameters ? `?${parameters}` : '';

        for (const alarmMode of [
            SecuritySystemMode.Disarmed,
            SecuritySystemMode.NightArmed,
            SecuritySystemMode.AwayArmed,
            SecuritySystemMode.HomeArmed,
        ]) {
            let title = '';
            if (alarmMode === SecuritySystemMode.Disarmed) {
                title = deactivateMessage
            } else {
                const modeText = alarmMode === SecuritySystemMode.AwayArmed ?
                    modeAwayText : alarmMode === SecuritySystemMode.HomeArmed ?
                        modeHomeText : modeNightText;
                title = setModeMessage.replace('${mode}', modeText);
            }
            actions.push({
                url: `${cloudEndpoint}${setAlarm}/${alarmMode}${paramString}`,
                title,
                action: `scrypted_an_alarm_${alarmMode}`,
            });
        }
    } catch (e) {
        console.log('Error fetching webhookUrls. Probably Cloud plugin is not setup correctly', e.message);
    }

    return actions;
}

export const haAlarmAutomationId = 'scrypted_advanced_security_system_alarm_action';
export const haAlarmAutomation = {
    "alias": "Scrypted advanced security system alarm action",
    "description": "Automation auto-generated by the scrypted's plugin Advanced notifier to handle alarm actions",
    "trigger": [
        {
            "platform": "event",
            "event_type": "mobile_app_notification_action"
        },
        {
            "platform": "event",
            "event_type": "ios.action_fired"
        }
    ],
    "condition": [
        {
            "condition": "template",
            "value_template": "{{ trigger.event.data.action_name is match('scrypted_an_alarm_.*') or trigger.event.data.action is match('scrypted_an_alarm.*') }}"
        }
    ],
    "action": [
        {
            "variables": {
                "event_name": "{% if 'action' in trigger.event.data %}{{ trigger.event.data.action }}{% else %}{{ trigger.event.data.actionName }}{% endif %}",
                "suffix": "{% set prefix = 'scrypted_an_alarm_' %} {{ event_name[prefix|length:] }}",
                "parts": "{{ suffix.split('_') }}",
                "mode": "{{ parts[0] }}",
            }
        },
        {
            "action": "mqtt.publish",
            "data": {
                "qos": "0",
                "topic": "scrypted/scrypted-an-alarm-system/alarm-system/set",
                "payload": "{{ mode }}"
            }
        }
    ],
    "mode": "single"
};