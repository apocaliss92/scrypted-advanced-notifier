export const intervalIdKey = 'activeStreamsIntervalId';
export const camerasKey = 'activeStreamsCameras';
export const peopleKey = 'activeStreamsPeople';
export const ipsKey = 'activeStreamsIps';
export const mqttHostKey = 'activeStreamsMqttHost';
export const mqttUsernameKey = 'activeStreamsMqttUsername';
export const mqttPasswordKey = 'activeStreamsMqttPassword';

export interface StreamInfo {
    ip: string;
    camera: string;
}

export interface KnownPersonResult {
    cameraName: string,
    cameraId: string,
    person: string,
    settings: StreamInfo[]
}

export interface CameraData { id: string, name: string, activeStreams: number }