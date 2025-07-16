import sdk, { Image, ObjectDetectionResult, MediaObject, ScryptedMimeTypes, ImageOptions } from "@scrypted/sdk";
import sharp from "sharp";
import { DetectionClass, detectionClassesDefaultMap } from "./detectionClasses";
import { moToB64 } from "./utils";

const fontSize = 20;
const thickness = 4;

const detectionClassClorMap: Partial<Record<string, string>> = {
    [DetectionClass.Animal]: '#2ECC40',
    [DetectionClass.Vehicle]: '#0074D9',
    [DetectionClass.Person]: '#FF4136',
    [DetectionClass.Face]: '#FF851B',
    [DetectionClass.Plate]: '#B10DC9',
    Other: '#AAAAAA',
};

export const addBoundingBoxesToImage = async (props: {
    inputDimensions?: [number, number],
    detections?: ObjectDetectionResult[],
    image: MediaObject;
    withScores?: boolean
}) => {
    const { detections, inputDimensions, image, withScores } = props;
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');

    const svgRectsAndTexts = detections.map(({ boundingBox, label, className, score }) => {
        let labelText = `${label || className}`;
        if (withScores) {
            labelText += `: ${Math.floor(score * 100)}%`
        }
        const [x, y, width, height] = boundingBox;
        const classNameParsed = detectionClassesDefaultMap[className] ?? 'Other';
        const padding = 4;
        const textWidth = labelText.length * (fontSize * 0.6);
        const labelX = x;
        const labelY = y - fontSize - 4;

        const color = detectionClassClorMap[classNameParsed];

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
}

export const addZoneClipPathToImage = async (props: {
    clipPath?: number[][],
    image: MediaObject;
}) => {
    const { image, clipPath } = props;
    const bufferImage = await sdk.mediaManager.convertMediaObjectToBuffer(image, 'image/jpeg');
    const metadata = await sharp(bufferImage).metadata();

    const inputWidth = metadata.width;
    const inputHeight = metadata.height;

    const scale = 0.9;
    const zeroPoint = (1 - scale) / 2;

    const polygonPoints = clipPath.map(([x, y]) => {
        const px = (zeroPoint + x * scale) * inputWidth;
        const py = (zeroPoint + y * scale) * inputHeight;
        return `${px},${py}`;
    }).join(' ');

    const svgOverlay = `
    <svg width="${inputWidth}" height="${inputHeight}" xmlns="http://www.w3.org/2000/svg">
        <polygon points="${polygonPoints}"
           fill="rgba(255,0,0,0.3)"
           stroke="red"
           stroke-width="3" />
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
}

export const cropImageToDetection = async (props: {
    inputDimensions: [number, number],
    boundingBox: [number, number, number, number],
    image: MediaObject;
}) => {
    const { image, boundingBox, inputDimensions } = props;
    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(image, ScryptedMimeTypes.Image);

    const { crop, boundingBox: newBoundingBox } = getCropResizeOptions({
        inputDimensions,
        aspectRatio: 1,
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
            throw new Error(`${e.message}: ${JSON.stringify({
                crop,
                newBoundingBox,
            })}`)
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
    aspectRatio?: number,
    sizeIncrease?: number // Aggiungo questo parametro configurabile
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
    const targetAspectRatio = aspectRatio || (inputWidth / inputHeight);

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
    let cropHeight = cropWidth / targetAspectRatio;

    if (cropHeight < newHeight) {
        cropHeight = newHeight;
        cropWidth = cropHeight * targetAspectRatio;
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