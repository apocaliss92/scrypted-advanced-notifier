
import { ScryptedDeviceBase, SecuritySystem, SecuritySystemMode } from '@scrypted/sdk';
import AdvancedNotifierPlugin from './main';

export class AdvancedNotifierAlarmSystem extends ScryptedDeviceBase implements SecuritySystem {
    constructor(nativeId: string, private plugin: AdvancedNotifierPlugin) {
        super(nativeId);
    }

    armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        throw new Error('Method not implemented.');
    }

    disarmSecuritySystem(): Promise<void> {
        throw new Error('Method not implemented.');
    }

}
