import { SecuritySystemMode } from "@scrypted/sdk";
import { StorageSetting, StorageSettings } from "@scrypted/sdk/storage-settings";
import { deviceFilter, sensorsFilter } from "./utils";

export const supportedAlarmModes = [
    SecuritySystemMode.AwayArmed,
    SecuritySystemMode.HomeArmed,
    SecuritySystemMode.NightArmed,
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