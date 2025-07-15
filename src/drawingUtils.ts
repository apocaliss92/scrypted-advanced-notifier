import sdk, { Image, ObjectDetectionResult, MediaObject, ScryptedMimeTypes } from "@scrypted/sdk";
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

    const [x, y, width, height] = boundingBox;
    const [inputWidth, inputHeight] = inputDimensions;

    if (width <= 0 || height <= 0 || x < 0 || y < 0) {
        throw new Error(`Invalid bounding box: [${x}, ${y}, ${width}, ${height}]`);
    }

    const marginRatio = 0.2;
    const marginX = width * marginRatio;
    const marginY = height * marginRatio;

    let cropX = x - marginX;
    let cropY = y - marginY;
    let cropWidth = width + marginX * 2;
    let cropHeight = height + marginY * 2;

    cropX = Math.max(0, cropX);
    cropY = Math.max(0, cropY);

    cropWidth = Math.min(cropWidth, inputWidth - cropX);
    cropHeight = Math.min(cropHeight, inputHeight - cropY);

    cropWidth = Math.max(1, cropWidth);
    cropHeight = Math.max(1, cropHeight);

    const finalCropX = Math.max(0, Math.round(cropX));
    const finalCropY = Math.max(0, Math.round(cropY));
    const finalCropWidth = Math.max(1, Math.round(cropWidth));
    const finalCropHeight = Math.max(1, Math.round(cropHeight));

    if (finalCropX + finalCropWidth > inputWidth || finalCropY + finalCropHeight > inputHeight) {
        throw new Error(`Crop area exceeds image boundaries: crop[${finalCropX}, ${finalCropY}, ${finalCropWidth}, ${finalCropHeight}] vs image[${inputWidth}, ${inputHeight}]`);
    }

    const newImage = await convertedImage.toImage({
        crop: {
            width: finalCropWidth,
            height: finalCropHeight,
            left: finalCropX,
            top: finalCropY,
        }
    });
    const newB64Image = await moToB64(newImage);

    return {
        newB64Image,
        newImage,
    };
}

export const getCropResizeOptions = (props: {
    inputDimensions?: [number, number],
    boundingBox: [number, number, number, number],
    aspectRatio?: number
}) => {
    const {
        inputDimensions,
        boundingBox,
        aspectRatio,
    } = props;

    if (!boundingBox || !inputDimensions) {
        return {};
    }

    const imageAspectRatio = inputDimensions[0] / inputDimensions[1];
    const targetAspectRatio = aspectRatio || imageAspectRatio;
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
        left: cropLeft,
        top: cropTop,
        width: finalWidth,
        height: finalHeight
    };
}