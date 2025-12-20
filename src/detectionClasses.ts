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
    Doorbell = 'doorbell',
    Sensor = 'sensor',
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
    'licensePlate',

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

export const audioLabels = [
    "speech", "scream", "babbling", "yell", "bellow", "whoop", "whispering", "laughter", "snicker",
    "crying", "sigh", "singing", "choir", "sodeling", "chant", "mantra", "child_singing",
    "synthetic_singing", "rapping", "humming", "groan", "grunt", "whistling", "breathing",
    "wheeze", "snoring", "gasp", "pant", "snort", "cough", "throat_clearing", "sneeze",
    "sniff", "run", "shuffle", "footsteps", "chewing", "biting", "gargling", "stomach_rumble",
    "burping", "hiccup", "fart", "hands", "finger_snapping", "clapping", "heartbeat",
    "heart_murmur", "cheering", "applause", "chatter", "crowd", "children_playing",
    "pets", "bark", "yip", "howl", "bow-wow", "growling", "whimper_dog", "purr", "meow", "hiss",
    "caterwaul", "livestock", "clip-clop", "neigh", "cattle", "moo", "cowbell", "pig", "oink",
    "goat", "bleat", "fowl", "chicken", "cluck", "cock-a-doodle-doo", "turkey", "gobble", "duck",
    "quack", "goose", "honk", "wild_animals", "roaring_cats", "roar", "chird", "chirp", "squawk",
    "coo", "crow", "caw", "hoot", "flapping_wings", "dogs", "rats", "patter", "insect", "cricket",
    "mosquito", "fly", "buzz", "frog", "croak", "rattle", "whale_vocalization", "music",
    "musical_instrument", "plucked_string_instrument", "guitar", "electric_guitar", "bass_guitar",
    "acoustic_guitar", "steel_guitar", "tapping", "strum", "banjo", "sitar", "mandolin", "zither",
    "ukulele", "keyboard", "piano", "electric_piano", "organ", "electronic_organ", "hammond_organ",
    "synthesizer", "sampler", "harpsichord", "percussion", "drum_kit", "drum_machine", "drum",
    "snare_drum", "rimshot", "drum_roll", "bass_drum", "timpani", "tabla", "cymbal", "hi-hat",
    "wood_block", "tambourine", "maraca", "gong", "tubular_bells", "mallet_percussion", "marimba",
    "glockenspiel", "vibraphone", "steelpan", "orchestra", "brass_instrument", "french_horn",
    "trumpet", "trombone", "bowed_string_instrument", "string_section", "violin", "pizzicato",
    "cello", "double_bass", "wind_instrument", "flute", "saxophone", "clarinet", "harp", "bell",
    "church_bell", "jingle_bell", "bicycle_bell", "tuning_fork", "chime", "wind_chime",
    "change_ringing", "harmonica", "accordion", "bagpipes", "didgeridoo", "shofar", "theremin",
    "singing_bowl", "scratching", "pop_music", "hip_hop_music", "beatboxing", "rock_music",
    "heavy_metal", "punk_rock", "grunge", "progressive_rock", "rock_and_roll", "psychedelic_rock",
    "rhythm_and_blues", "soul_music", "reggae", "country", "swing_music", "bluegrass", "funk",
    "folk_music", "middle_eastern_music", "jazz", "disco", "classical_music", "opera",
    "electronic_music", "house_music", "techno", "dubstep", "drum_and_bass", "electronica",
    "electronic_dance_music", "ambient_music", "trance_music", "music_of_latin_america",
    "salsa_music", "flamenco", "blues", "music_for_children", "new-age_music", "vocal_music",
    "a_capella", "music_of_africa", "afrobeat", "christian_music", "gospel_music", "music_of_asia",
    "carnatic_music", "music_of_bollywood", "ska", "traditional_music", "independent_music",
    "song", "background_music", "theme_music", "jingle", "soundtrack_music", "lullaby",
    "video_game_music", "christmas_music", "dance_music", "wedding_music", "happy_music",
    "sad_music", "tender_music", "exciting_music", "angry_music", "scary_music", "wind",
    "rustling_leaves", "wind_noise", "thunderstorm", "thunder", "water", "rain", "raindrop",
    "rain_on_surface", "stream", "waterfall", "ocean", "waves", "steam", "gurgling", "fire",
    "crackle", "sailboat", "rowboat", "motorboat", "air_brake", "air_horn",
    "reversing_beeps", "ice_cream_truck", "aircraft_engine", "jet_engine", "propeller",
    "fixed-wing_aircraft", "engine", "light_engine", "dental_drill's_drill", "lawn_mower",
    "chainsaw", "medium_engine", "heavy_engine", "engine_knocking", "engine_starting", "idling",
    "accelerating", "door", "doorbell", "ding-dong", "sliding_door", "slam", "knock", "tap",
    "squeak", "cupboard_open_or_close", "drawer_open_or_close", "dishes", "cutlery", "chopping",
    "frying", "microwave_oven", "blender", "water_tap", "sink", "bathtub", "hair_dryer",
    "toilet_flush", "toothbrush", "electric_toothbrush", "vacuum_cleaner", "zipper",
    "keys_jangling", "coin", "scissors", "electric_shaver", "shuffling_cards", "typing",
    "typewriter", "computer_keyboard", "writing", "alarm", "telephone", "telephone_bell_ringing",
    "ringtone", "telephone_dialing", "dial_tone", "busy_signal", "alarm_clock", "siren",
    "civil_defense_siren", "buzzer", "smoke_detector", "fire_alarm", "foghorn", "whistle",
    "steam_whistle", "mechanisms", "ratchet", "clock", "tick", "tick-tock", "gears", "pulleys",
    "sewing_machine", "mechanical_fan", "air_conditioning", "cash_register", "printer", "camera",
    "single-lens_reflex_camera", "tools", "hammer", "jackhammer", "sawing", "filing", "sanding",
    "power_tool", "drill", "explosion", "gunshot", "machine_gun", "fusillade", "artillery_fire",
    "cap_gun", "fireworks", "firecracker", "burst", "eruption", "boom", "wood", "chop", "splinter",
    "crack", "glass", "chink", "shatter", "liquid", "splash", "slosh", "squish", "drip", "pour",
    "trickle", "gush", "fill", "spray", "pump", "stir", "boiling", "sonar", "arrow", "whoosh",
    "thump", "thunk", "electronic_tuner", "effects_unit", "chorus_effect", "basketball_bounce",
    "bang", "slap", "whack", "smash", "breaking", "bouncing", "whip", "flap", "scratch", "scrape",
    "rub", "roll", "crushing", "crumpling", "tearing", "beep", "ping", "ding", "clang", "squeal",
    "creak", "rustle", "whir", "clatter", "sizzle", "clicking", "clickety-clack", "rumble", "plop",
    "jingle", "hum", "zing", "boing", "crunch", "silence", "sine_wave", "harmonic", "chirp_tone",
    "sound_effect", "pulse", "inside", "outside", "reverberation", "echo", "noise",
    "environmental_noise", "static", "mains_hum", "distortion", "sidetone", "cacophony",
    "white_noise", "pink_noise", "throbbing", "vibration", "television", "radio", "field_recording"
];

export const audioClasses: string[] = [DetectionClass.Audio];

export const doorbellClasses = [
    DetectionClass.Doorbell,

    'ring',
];

export const isFaceClassname = (classname: string) => faceClasses.includes(classname);
export const isPlateClassname = (classname: string) => licensePlateClasses.includes(classname);
export const isAnimalClassname = (classname: string) => animalClasses.includes(classname);
export const isPersonClassname = (classname: string) => personClasses.includes(classname);
export const isVehicleClassname = (classname: string) => vehicleClasses.includes(classname);
export const isMotionClassname = (classname: string) => motionClasses.includes(classname);
export const isDoorbellClassname = (classname: string) => doorbellClasses.includes(classname);
export const isPackageClassname = (classname: string) => packageClasses.includes(classname);
export const isAudioLabel = (label: string) => audioClasses.includes(label) || audioLabels.includes(label);
export const isObjectLabel = (label: string) => !isAudioLabel(label);
export const isAudioClassname = (classname: string) => audioClasses.includes(classname) || isAudioLabel(classname);
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
    ...audioClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Audio }), {}),
    ...doorbellClasses.reduce((tot, curr) => ({ ...tot, [curr]: DetectionClass.Doorbell }), {}),
}

export const getParentDetectionClass = (det: { label?: string, className: string }) => {
    const { className } = det;
    const baseMap = {
        [DetectionClass.Face]: DetectionClass.Person,
        [DetectionClass.Plate]: DetectionClass.Vehicle,
    };

    const parentGroup = detectionClassesDefaultMap[className];
    if (parentGroup && parentGroup !== className) {
        return parentGroup;
    } else {
        return baseMap[className];
    }
};

// visual similarity
const similarCharacters = [
    ['0', 'O', 'D'],
    ['1', 'I'],
    ['2', 'Z'],
    ['4', 'A'],
    ['5', 'S'],
    ['8', 'B'],
    ['6', 'G'],
    // not sure about this one.
    ['A', '4'],
    ['C', 'G'],
    ['E', 'F'],
];

const similarCharactersMap = new Map<string, Set<string>>();
for (const similarCharacter of similarCharacters) {
    for (const character of similarCharacter) {
        if (!similarCharactersMap.has(character)) {
            similarCharactersMap.set(character, new Set());
        }
        for (const similar of similarCharacter) {
            similarCharactersMap.get(character)!.add(similar);
        }
    }
}

const isSameCharacter = (c1: string, c2: string) => {
    if (c1 === c2)
        return true;

    return similarCharactersMap.get(c1)?.has(c2);
}

export const levenshteinDistance = (str1: string, str2: string): number => {
    // todo: handle lower/uppercase similarity in similarCharacters above.
    // ie, b is visualy similar to 6, but does not really look like B.
    // others include e and C. v, u and Y. l, i, 1.
    str1 = str1.toUpperCase();
    str2 = str2.toUpperCase();

    const len1 = str1.length;
    const len2 = str2.length;

    // If either string is empty, the distance is the length of the other string
    if (len1 === 0) return len2;
    if (len2 === 0) return len1;

    let prev: number[] = new Array(len2 + 1);
    let curr: number[] = new Array(len2 + 1);

    // Initialize the first row of the matrix to be the index of the second string
    for (let i = 0; i <= len2; i++) {
        prev[i] = i;
    }

    for (let i = 1; i <= len1; i++) {
        // Initialize the current row with the distance from the previous row's first element
        curr[0] = i;

        for (let j = 1; j <= len2; j++) {
            let cost = isSameCharacter(str1.charAt(i - 1), str2.charAt(j - 1)) ? 0 : 1;

            // Compute the minimum of three possible operations: insertion, deletion, or substitution
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }

        // Swap the previous and current rows for the next iteration
        const temp = prev;
        prev = curr;
        curr = temp;
    }

    return prev[len2];
}
