import { Camera, ScryptedDeviceBase, Settings, VideoClips } from "@scrypted/sdk";

export enum DeviceType {
    Camera,
    Window,
    Lock
}

export type DeviceInterface = Camera & ScryptedDeviceBase & VideoClips & Settings;