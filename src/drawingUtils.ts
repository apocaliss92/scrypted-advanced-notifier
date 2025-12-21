import sdk, { Image, ObjectDetectionResult, MediaObject, ScryptedMimeTypes, ImageOptions } from "@scrypted/sdk";
import sharp from "sharp";
import { DetectionClass, detectionClassesDefaultMap } from "./detectionClasses";
import { moToB64 } from "./utils";
import AdvancedNotifierPlugin, { PluginSettingKey } from "./main";

const detectionClassClorMap: Partial<Record<string, PluginSettingKey>> = {
    [DetectionClass.Animal]: 'postProcessingAnimalBoundingColor',
    [DetectionClass.Vehicle]: 'postProcessingVehicleBoundingColor',
    [DetectionClass.Person]: 'postProcessingPersonBoundingColor',
    [DetectionClass.Face]: 'postProcessingFaceBoundingColor',
    [DetectionClass.Plate]: 'postProcessingPlateBoundingColor',
    Other: 'postProcessingOtherBoundingColor',
};

export const addBoundingBoxesToImage = async (props: {
    inputDimensions?: [number, number],
    detections?: ObjectDetectionResult[],
    image: MediaObject;
    plugin: AdvancedNotifierPlugin;
}) => {
    const { detections, inputDimensions, image, plugin } = props;
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');

    const {
        postProcessingMarkingSizeIncrease,
        postProcessingLineThickness: thickness,
        postProcessingFontSize: fontSize,
        postProcessingShowScore: showScore
    } = plugin.storageSettings.values;

    if (!detections.length) {
        return {
            newB64Image: await moToB64(image),
            newImage: image,
        }
    }

    try {
        const svgRectsAndTexts = detections.map(({ boundingBox, label, className, score }) => {
            let labelText = `${label || className}`;
            if (showScore) {
                labelText += `: ${Math.floor(score * 100)}%`
            }
            const cropResult = getCropResizeOptions({
                inputDimensions,
                sizeIncrease: postProcessingMarkingSizeIncrease,
                boundingBox,
            });

            if (!cropResult) {
                throw new Error(`Fail on getCropResizeOptions: ${JSON.stringify({
                    inputDimensions,
                    sizeIncrease: postProcessingMarkingSizeIncrease,
                    boundingBox
                })}`);
            }

            const { crop } = cropResult;
            // const [x, y, width, height] = boundingBox;
            const { left: x, top: y, width, height } = crop;
            const classNameParsed = detectionClassesDefaultMap[className] ?? 'Other';
            const padding = 4;
            const textWidth = labelText.length * (fontSize * 0.6);
            const labelX = x;
            const labelY = y - fontSize - 4;

            const colorSettingKey = detectionClassClorMap[classNameParsed];
            const color = plugin.storageSettings.values[colorSettingKey];

            return `
            <rect 
                x="${x}" 
                y="${y}" 
                width="${width}" 
                height="${height}" 
                fill="none" 
                stroke="${color}" 
                stroke-width="${thickness}" 
                />
            <rect
                x="${labelX}"
                y="${labelY}"
                width="${textWidth + padding * 2}"
                height="${fontSize + padding}"
                fill="${color}"
                rx="3"
                />
            <text
                x="${labelX + padding}"
                y="${labelY + fontSize}"
                fill="black"
                font-size="${fontSize}"
                font-family="sans-serif"
            >
                ${labelText}
            </text>
        `;
        }).join('\n');

        const svgOverlay = `
        <svg width="${inputDimensions[0]}" height="${inputDimensions[1]}" xmlns="http://www.w3.org/2000/svg">
          ${svgRectsAndTexts}
        </svg>
      `;

        const outputBuffer = await sharp(bufferImage)
            .composite([
                {
                    input: Buffer.from(svgOverlay),
                    top: 0,
                    left: 0,
                    blend: 'over',
                }
            ])
            .toBuffer();

        const newB64Image = outputBuffer.toString('base64');
        const newImage = await sdk.mediaManager.createMediaObject(outputBuffer, 'image/jpeg');

        return {
            newB64Image,
            newImage,
        };
    } catch (e) {
        throw new Error(`Error in marking boundaries add :${JSON.stringify({
            error: e.message,
            inputDimensions,
        })}`);
    }
}

export const addZoneClipPathToImage = async (props: {
    clipPaths?: number[][][],
    image: MediaObject;
    console: Console,
    scale?: number;
    plugin?: AdvancedNotifierPlugin;
}) => {
    const { image, clipPaths, console, scale = 1, plugin } = props;

    try {
        if (!clipPaths || !clipPaths.length) {
            const newB64Image = await moToB64(image);

            return {
                newB64Image,
                newImage: image,
            };
        }

        const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');
        const metadata = await sharp(bufferImage).metadata();

        const inputWidth = metadata.width;
        const inputHeight = metadata.height;

        const zeroPoint = (1 - scale) / 2;
        const {
            postProcessingFillOpacity,
            postProcessingZonesColor,
            postProcessingZonesStrokeWidth,
        } = plugin?.storageSettings?.values || {};

        const strokeColor = postProcessingZonesColor || 'red';
        const strokeWidth = postProcessingZonesStrokeWidth ?? 3;
        const opacity = typeof postProcessingFillOpacity === 'number' ? postProcessingFillOpacity : 30;
        const clampedOpacity = Math.max(0, Math.min(100, opacity));
        const fillOpacity = clampedOpacity / 100;

        const polygons = clipPaths
            .filter(path => path && path.length)
            .map(path => {
                const points = path.map(([x, y]) => {
                    let nx = x;
                    let ny = y;
                    if (nx > 1 || ny > 1) {
                        nx = nx / 100;
                        ny = ny / 100;
                    }

                    const px = (zeroPoint + nx * scale) * inputWidth;
                    const py = (zeroPoint + ny * scale) * inputHeight;
                    return `${px},${py}`;
                }).join(' ');

                const fillAttributes = clampedOpacity > 0
                    ? `fill="${strokeColor}" fill-opacity="${fillOpacity}"`
                    : `fill="none"`;

                return `<polygon points="${points}" ${fillAttributes} stroke="${strokeColor}" stroke-width="${strokeWidth}" />`;
            })
            .join('\n');

        const svgOverlay = `
    <svg width="${inputWidth}" height="${inputHeight}" xmlns="http://www.w3.org/2000/svg">
        ${polygons}
    </svg>
    `;

        const outputBuffer = await sharp(bufferImage)
            .composite([
                {
                    input: Buffer.from(svgOverlay),
                    top: 0,
                    left: 0,
                    blend: 'over',
                }
            ])
            .toBuffer();

        const newB64Image = outputBuffer.toString('base64');
        const newImage = await sdk.mediaManager.createMediaObject(outputBuffer, 'image/jpeg');

        return {
            newB64Image,
            newImage,
        };
    } catch (e) {
        console.error(`Error in adding zone clip path to image: ${e.message}`);
        const newB64Image = await moToB64(image);

        return {
            newB64Image,
            newImage: image,
        };
    }
}

export const cropImageToDetection = async (props: {
    inputDimensions: [number, number],
    boundingBox: [number, number, number, number],
    image: MediaObject;
    plugin: AdvancedNotifierPlugin;
    sizeIncrease?: number;
    console: Console
}) => {
    const { image, boundingBox, inputDimensions, plugin, sizeIncrease, console } = props;
    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(image, ScryptedMimeTypes.Image);

    const { postProcessingCropSizeIncrease, postProcessingAspectRatio } = plugin.storageSettings.values;
    const { crop, boundingBox: newBoundingBox } = getCropResizeOptions({
        inputDimensions,
        aspectRatio: postProcessingAspectRatio || 'camera',
        sizeIncrease: sizeIncrease ?? postProcessingCropSizeIncrease,
        boundingBox,
    });

    if (crop) {
        try {
            const newImage = await convertedImage.toImage({
                crop
            });
            const newB64Image = await moToB64(newImage);

            return {
                newB64Image,
                newImage,
            };
        } catch (e) {
            console.error(`${e.message}: ${JSON.stringify({
                crop,
                newBoundingBox,
            })}`);
            return {};
        }
    } else {
        const newB64Image = await moToB64(image);

        return {
            newB64Image,
            newImage: image
        };
    }
}

export const getCropResizeOptionsOld = (props: {
    inputDimensions?: [number, number],
    boundingBox: [number, number, number, number],
    aspectRatio?: number
}): { crop: ImageOptions['crop'], boundingBox: [number, number, number, number] } => {
    const {
        inputDimensions,
        boundingBox,
        aspectRatio,
    } = props;

    if (!boundingBox || !inputDimensions) {
        return undefined;
    }

    const targetAspectRatio = aspectRatio || (inputDimensions[0] / inputDimensions[1]);

    const sizeIncrease = 1.2;
    const [boundingBoxXTmp, boundingBoxYTmp, boundingBoxWidthTmp, boundingBoxHeightTmp] = boundingBox;

    const newBoundingBox: [number, number, number, number] = [
        boundingBoxXTmp + boundingBoxWidthTmp / 2 - boundingBoxWidthTmp * sizeIncrease / 2,
        boundingBoxYTmp + boundingBoxHeightTmp / 2 - boundingBoxHeightTmp * sizeIncrease / 2,
        boundingBoxWidthTmp * sizeIncrease,
        boundingBoxHeightTmp * sizeIncrease
    ];
    // const [boundingBoxX, boundingBoxY, boundingBoxWidth, boundingBoxHeight] = newBoundingBox;
    const [boundingBoxX, boundingBoxY, boundingBoxWidth, boundingBoxHeight] = boundingBox;

    const centerY = boundingBoxY + boundingBoxHeight / 2;

    let cropWidth = boundingBoxWidth;
    let cropHeight = cropWidth / targetAspectRatio;

    if (cropHeight < boundingBoxHeight) {
        cropHeight = boundingBoxHeight;
        cropWidth = cropHeight * targetAspectRatio;
    }

    const centerX = boundingBoxX + boundingBoxWidth / 2;
    let cropLeft = centerX - cropWidth / 2;

    if (cropLeft < 0) {
        cropLeft = 0;
    } else if (cropLeft + cropWidth > inputDimensions[0]) {
        cropLeft = inputDimensions[0] - cropWidth;
    }

    let cropTop = centerY - cropHeight / 2;

    if (cropTop < 0) {
        cropTop = 0;
    } else if (cropTop + cropHeight > inputDimensions[1]) {
        cropTop = inputDimensions[1] - cropHeight;
    }

    cropLeft = Math.min(inputDimensions[0], Math.max(0, cropLeft));
    cropTop = Math.min(inputDimensions[1], Math.max(0, cropTop));

    const finalWidth = Math.min(inputDimensions[0], cropWidth);
    const finalHeight = Math.min(inputDimensions[1], cropHeight);

    return {
        crop: {
            left: cropLeft,
            top: cropTop,
            width: finalWidth,
            height: finalHeight
        },
        boundingBox: newBoundingBox
    };
}

export const getCropResizeOptions = (props: {
    inputDimensions?: [number, number],
    boundingBox: [number, number, number, number],
    aspectRatio?: 'camera' | number,
    sizeIncrease?: number
}): { crop: ImageOptions['crop'], boundingBox: [number, number, number, number] } => {
    const {
        inputDimensions,
        boundingBox,
        aspectRatio,
        sizeIncrease = 1.2
    } = props;

    if (!boundingBox || !inputDimensions) {
        return undefined;
    }

    const [inputWidth, inputHeight] = inputDimensions;
    const targetAspectRatio = aspectRatio === 'camera' ? (inputWidth / inputHeight) : aspectRatio;

    const [originalX, originalY, originalWidth, originalHeight] = boundingBox;

    const centerX = originalX + originalWidth / 2;
    const centerY = originalY + originalHeight / 2;

    const newWidth = originalWidth * sizeIncrease;
    const newHeight = originalHeight * sizeIncrease;

    const newBoundingBox: [number, number, number, number] = [
        centerX - newWidth / 2,
        centerY - newHeight / 2,
        newWidth,
        newHeight
    ];

    let cropWidth = newWidth;
    let cropHeight = newHeight;

    if (targetAspectRatio) {
        cropHeight = cropWidth / targetAspectRatio;

        if (cropHeight < newHeight) {
            cropHeight = newHeight;
            cropWidth = cropHeight * targetAspectRatio;
        }
    }

    let cropLeft = centerX - cropWidth / 2;
    let cropTop = centerY - cropHeight / 2;

    if (cropLeft < 0) {
        cropLeft = 0;
    } else if (cropLeft + cropWidth > inputWidth) {
        cropLeft = inputWidth - cropWidth;
    }

    if (cropTop < 0) {
        cropTop = 0;
    } else if (cropTop + cropHeight > inputHeight) {
        cropTop = inputHeight - cropHeight;
    }

    const finalWidth = Math.min(cropWidth, inputWidth - cropLeft);
    const finalHeight = Math.min(cropHeight, inputHeight - cropTop);

    return {
        crop: {
            left: Math.round(cropLeft),
            top: Math.round(cropTop),
            width: Math.round(finalWidth),
            height: Math.round(finalHeight)
        },
        boundingBox: newBoundingBox
    };
};