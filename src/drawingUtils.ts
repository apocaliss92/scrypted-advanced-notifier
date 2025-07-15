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
    inputDimensions?: [number, number],
    boundingBox?: [number, number, number, number],
    image: MediaObject;
    asSquare?: boolean
}) => {
    const { image, boundingBox, inputDimensions, asSquare, } = props;
    const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(image, ScryptedMimeTypes.Image);

    const [x, y, width, height] = boundingBox;
    const [inputWidth, inputHeight] = inputDimensions;

    const marginRatio = 0.1;
    let cropWidth: number;
    let cropHeight: number;
    let cropX: number;
    let cropY: number;

    if (asSquare) {
        const marginX = width * marginRatio;
        const marginY = height * marginRatio;

        cropX = x - marginX;
        cropY = y - marginY;
        cropWidth = width + marginX * 2;
        cropHeight = height + marginY * 2;

        const side = Math.max(cropWidth, cropHeight);

        cropX = x + width / 2 - side / 2;
        cropY = y + height / 2 - side / 2;

        cropX = Math.max(0, cropX);
        cropY = Math.max(0, cropY);
        cropWidth = inputWidth - cropX;
        cropHeight = inputHeight - cropY;
        const squareSide = Math.min(side, cropWidth, cropHeight);
        cropX = squareSide;
        cropY = squareSide;
    } else {
        const imageRatio = inputWidth / inputHeight;

        const marginX = width * marginRatio;
        const marginY = height * marginRatio;

        cropX = x - marginX;
        cropY = y - marginY;
        cropWidth = width + marginX * 2;
        cropHeight = height + marginY * 2;

        const cropRatio = cropWidth / cropHeight;

        if (cropRatio > imageRatio) {
            const newHeight = cropWidth / imageRatio;
            const diff = newHeight - cropHeight;
            cropY -= diff / 2;
            cropHeight = newHeight;
        } else {
            const newWidth = cropHeight * imageRatio;
            const diff = newWidth - cropWidth;
            cropX -= diff / 2;
            cropWidth = newWidth;
        }

        cropX = Math.max(0, cropX);
        cropY = Math.max(0, cropY);
        cropWidth = Math.min(inputWidth - cropX, cropWidth);
        cropHeight = Math.min(inputHeight - cropY, cropHeight);
    }

    const newImage = await convertedImage.toImage({
        crop: {
            width: Math.round(cropWidth),
            height: Math.round(cropHeight),
            left: Math.round(cropX),
            top: Math.round(cropY),
        }
    });
    const newB64Image = await moToB64(newImage);

    return {
        newB64Image,
        newImage,
    };
}

export const cropImageToDetectionV2 = async (props: {
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