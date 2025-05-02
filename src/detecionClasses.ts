export enum DetectionClass {
    Motion = 'motion',
    Person = 'person',
    Vehicle = 'vehicle',
    Animal = 'animal',
    Audio = 'audio',
    AnyObject = 'any_object',
    Face = 'face',
    Plate = 'plate',
    Package = 'package',
    DoorSensor = 'sensor_open',
    DoorLock = 'lock_open',
}

export const classnamePrio: Partial<Record<DetectionClass, number>> = {
    [DetectionClass.Face]: 1,
    [DetectionClass.Plate]: 1,
    [DetectionClass.Person]: 2,
    [DetectionClass.Vehicle]: 3,
    [DetectionClass.Animal]: 4,
    [DetectionClass.Package]: 5,
    [DetectionClass.Motion]: 6,
}

export const basicDetectionClasses = [
    DetectionClass.Vehicle,
    DetectionClass.Person,
    DetectionClass.Animal,
];

export const defaultDetectionClasses = Object.values(DetectionClass);

export const animalClasses = [
    // General
    DetectionClass.Animal,

    // Camera specific
    'dog_cat',

    // Mammals
    'dog',
    'cat',
    'horse',
    'sheep',
    'cow',
    'elephant',
    'bear',
    'zebra',
    'giraffe',
    'mouse',
    'rabbit',
    'deer',
    'lion',
    'tiger',

    // Birds
    'bird',
    'eagle',
    'owl',
    'pigeon',

    // Marine Animals
    'fish',
    'whale',
    'dolphin',

    // Reptiles/Amphibians
    'snake',
    'turtle',
    'lizard'
];

export const personClasses = [
    // General
    DetectionClass.Person,

    // Camera specific
    'people',

    // Activities
    'pedestrian',
    'rider',
    'driver',
    'cyclist',
    'skier',
    'skateboarder',

    // Body Parts
    'face',
    'hand',
    'head',
    'body'
];

export const vehicleClasses = [
    // General
    DetectionClass.Vehicle,

    // Road Vehicles
    'car',
    'truck',
    'bus',
    'motorcycle',
    'bicycle',
    'van',

    // Special Vehicles
    'ambulance',
    'police_car',
    'fire_truck',

    // Public Transportation
    'train',
    'subway',
    'tram',

    // Others
    'airplane',
    'boat',
    'ship',
    'helicopter'
];

export const faceClasses = [
    DetectionClass.Face,

    // Main Face Components
    'eyes',
    'nose',
    'mouth',
    'ears',
    'eyebrows',

    // Detailed Eye Features
    'left_eye',
    'right_eye',
    'pupil',
    'iris',
    'eyelid',
    'eye_corner',

    // Detailed Mouth Features
    'upper_lip',
    'lower_lip',
    'teeth',

    // Other Facial Features
    'chin',
    'cheek',
    'forehead',
    'jaw',

    // Facial Accessories
    'glasses',
    'sunglasses',
    'facial_hair',
    'beard',
    'mustache',

    // Facial Landmarks
    'facial_landmark',
    'facial_keypoint'
];

export const licensePlateClasses = [
    DetectionClass.Plate,

    // Plate Types
    'license_plate',
    'front_plate',
    'rear_plate',
    'motorcycle_plate',
    'temporary_plate',
    'dealer_plate',

    // Plate Components
    'plate_number',
    'plate_character',
    'plate_digit',
    'plate_letter',
    'plate_symbol',
    'plate_region',
    'plate_country_identifier',

    // Plate Features
    'plate_frame',
    'plate_bolt',
    'plate_sticker',
    'plate_validation_tag',

    // Plate Conditions
    'damaged_plate',
    'obscured_plate',
    'dirty_plate'
];

export const motionClasses = [
    DetectionClass.Motion,
    'movement',

    // Reolink battery cams
    'other',
]

export const packageClasses = [
    DetectionClass.Package,
    'packet',
]

export const objectClasses = [
    DetectionClass.AnyObject,
    'object',
]

export const isFaceClassname = (classname: string) => faceClasses.includes(classname);
export const isPlateClassname = (classname: string) => licensePlateClasses.includes(classname);
export const isAnimalClassname = (classname: string) => animalClasses.includes(classname);
export const isPersonClassname = (classname: string) => personClasses.includes(classname);
export const isVehicleClassname = (classname: string) => vehicleClasses.includes(classname);
export const isMotionClassname = (classname: string) => motionClasses.includes(classname);
export const isPackageClassname = (classname: string) => packageClasses.includes(classname);
export const isLabelDetection = (classname: string) => isFaceClassname(classname) || isPlateClassname(classname);
export const isObjectClassname = (classname: string) =>
    isPackageClassname(classname) ||
    isAnimalClassname(classname) ||
    isPersonClassname(classname) ||
    isVehicleClassname(classname);

export const detectionClassesDefaultMap: Record<string, DetectionClass> = {
    ...animalClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Animal }), {}),
    ...personClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Person }), {}),
    ...vehicleClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Vehicle }), {}),
    ...motionClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Motion }), {}),
    ...packageClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Package }), {}),
    ...faceClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Face }), {}),
    ...licensePlateClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Plate }), {}),
    ...objectClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.AnyObject }), {}),
}

export const parentDetectionClassMap: Partial<Record<DetectionClass, DetectionClass>> = {
    [DetectionClass.Face]: DetectionClass.Person,
    [DetectionClass.Plate]: DetectionClass.Vehicle,
}