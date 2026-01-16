import { SecuritySystemMode } from "@scrypted/sdk";
import { StorageSetting, StorageSettings } from "@scrypted/sdk/storage-settings";
import { ExtendedNotificationAction, getAssetsParams, getWebhooks, safeParseJson, sensorsFilter } from "./utils";
import AdvancedNotifierPlugin from "./main";

export enum AlarmEvent {
    Preactivation = 'Preactivation',
    Activate = 'Activate',
    Blocked = 'Blocked',
    Trigger = 'Trigger',
    DefuseAuto = 'DefuseAuto',
    DefuseManual = 'DefuseManual',
    RiarmAuto = 'RiarmAuto',
    Disarm = 'Disarm',
}

export const getAlarmKeys = (props: {
    mode: SecuritySystemMode,
}) => {
    const { mode } = props;

    const bypassableDevicesKey = `${mode}:bypassableDevices`;
    const preActivationTimeKey = `${mode}:preActivationTime`;
    const autoDisarmTimeKey = `${mode}:autoDisarmTime`;
    const autoRiarmTimeKey = `${mode}:autoRiarmTime`;

    return {
        bypassableDevicesKey,
        preActivationTimeKey,
        autoDisarmTimeKey,
        autoRiarmTimeKey,
    };
};

export const getAlarmDefaults = (props: { mode: SecuritySystemMode }) => {
    const { mode } = props;

    let preactivationTime: number;
    let autoDisarmTime: number;
    let autoRiarmTime: number;

    switch (mode) {
        case (SecuritySystemMode.AwayArmed): {
            preactivationTime = 30;
            autoRiarmTime = 60;
            break;
        }
        case (SecuritySystemMode.HomeArmed): {
            preactivationTime = 0;
            autoRiarmTime = 30;
            break;
        }
        case (SecuritySystemMode.NightArmed): {
            preactivationTime = 0;
            autoRiarmTime = 30;
            break;
        }
    }

    return {
        preactivationTime,
        autoDisarmTime,
        autoRiarmTime,
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
        autoRiarmTimeKey,
    } = getAlarmKeys({ mode });
    const { autoDisarmTime, preactivationTime, autoRiarmTime } = getAlarmDefaults({ mode });
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
    const autoRiarmTimeSetting: StorageSetting = {
        key: autoRiarmTimeKey,
        title: `Auto riarm time (seconds)`,
        description: 'Automatically riarm the alarm on trigger. Set 0 to keep the alarm active until manual action',
        group,
        type: 'number',
        defaultValue: autoRiarmTime,
    };

    return [
        bypassableDevicesSetting,
        preActivationTimeSetting,
        autoDisarmTimeSetting,
        autoRiarmTimeSetting,
    ];
};

export interface ModeData {
    currentlyActive: boolean;
    bypassableDevices: string[];
    preActivationTime: number;
    autoDisarmTime: number;
    autoRiarmTime: number;
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
        autoRiarmTimeKey,
    } = getAlarmKeys({ mode });
    const {
        autoDisarmTime: autoDisarmTimeDefault,
        autoRiarmTime: autoRiarmTimeDefault,
        preactivationTime: preactivationTimeDefault } = getAlarmDefaults({ mode });

    const bypassableDevices = safeParseJson<string[]>(storage.getItem(bypassableDevicesKey), []);
    const preActivationTime = safeParseJson<number>(storage.getItem(preActivationTimeKey), preactivationTimeDefault);
    const autoDisarmTime = safeParseJson<number>(storage.getItem(autoDisarmTimeKey), autoDisarmTimeDefault);
    const autoRiarmTime = safeParseJson<number>(storage.getItem(autoRiarmTimeKey), autoRiarmTimeDefault);
    const currentMode = safeParseJson<SecuritySystemMode>(storage.getItem('activeMode'));

    const data: ModeData = {
        autoDisarmTime,
        bypassableDevices,
        currentlyActive: currentMode === mode,
        preActivationTime,
        autoRiarmTime,
    };

    return data;
};

export const getAlarmWebhookUrls = async (props: {
    deactivateMessage: string,
    setModeMessage: string,
    modeHomeText: string,
    modeNightText: string,
    modeAwayText: string,
    plugin: AdvancedNotifierPlugin
}) => {
    const {
        deactivateMessage,
        modeAwayText,
        modeHomeText,
        modeNightText,
        setModeMessage,
        plugin
    } = props;
    const actions: ExtendedNotificationAction[] = [];

    const { setAlarm } = await getWebhooks();

    try {
        const {
            paramString,
            publicPathnamePrefix,
            assetsOrigin,
        } = await getAssetsParams({ plugin });

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
                url: `${assetsOrigin}${publicPathnamePrefix}${setAlarm}/${alarmMode}?${paramString}`,
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
            "value_template": "{{ trigger.event.data.action_name is defined and trigger.event.data.action_name is match('scrypted_an_alarm_.*') or trigger.event.data.action is defined and trigger.event.data.action is match('scrypted_an_alarm.*') }}"
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