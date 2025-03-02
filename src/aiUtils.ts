import axios from "axios";
import AdvancedNotifierPlugin from "./main";
import { AiPlatform, getAiSettingKeys } from "./utils";
import { ObjectDetectionResult } from "@scrypted/sdk";

export enum AiPromptPreset {
    Regular = 'Regular',
    Mysterious = 'Mysterious',
}

export const promptPresets: Record<AiPromptPreset, string> = {
    [AiPromptPreset.Regular]: 'Create a notification suitable description of the image provided by the user. Describe the people, animals (coloring and breed), or vehicles (color and model) in the image. Do not describe scenery or static objects. Do not direct the user to click the notification. The original notification metadata may be provided and can be used to provide additional context for the new notification, but should not be used verbatim.',
    [AiPromptPreset.Mysterious]: `Create a fun and engaging notification based on the image provided by the user.  
If the image contains a person, describe them in a lighthearted way (e.g., 'A mysterious visitor', 'A friendly neighbor', 'Someone looking suspiciously at the door').  
If an animal is present, describe it with humor and personality. Include its type, color, and breed (if applicable). Example: 'A tiny, fluffy criminal (golden retriever) has been spotted near the snacks!'  
If a vehicle is present, describe its type, color, and any visible branding. Prioritize delivery vehicles (e.g., 'A FedEx truck is here – package day! 🎁').  
If the image includes text, extract key words that might be useful (e.g., 'A sign reads: Beware of dog!').  
DO NOT describe static objects, backgrounds, or scenery.  
The response must be humorous, engaging, and under 130 characters. Do not tell the user to click the notification. If multiple interesting things are in the image, describe the most notable one. OSD texts on the image should be ignored. Output language should be italian`,
}

export const createOpenAiTemplate = (props: {
    systemPrompt: string,
    model: string,
    imageUrl: string,
    originalTitle: string,
    detection?: ObjectDetectionResult,
}) => {
    const { imageUrl, originalTitle, model, systemPrompt, detection } = props;

    let text = `Original notification message is ${originalTitle}}.`;

    if (detection?.label) {
        text += ` In the image is present a familiar person with name ${detection.label}`;
    }

    const schema = "The response must be in JSON format with a message 'title', 'subtitle', and 'body'. The title and subtitle must not be more than 24 characters each. The body must not be more than 130 characters."
    return {
        model,
        messages: [
            {
                role: "system",
                content: systemPrompt + ' ' + schema,
            },
            {
                role: "user",
                content: [
                    {
                        type: 'text',
                        text,
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageUrl,
                        }
                    }
                ]
            }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "notification_response",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        },
                        subtitle: {
                            type: "string"
                        },
                        body: {
                            type: "string"
                        }
                    },
                    required: ["title", "subtitle", "body"],
                    additionalProperties: false
                }
            }
        }
    }
};

export const getAiMessage = async (props: {
    plugin: AdvancedNotifierPlugin,
    originalTitle: string,
    detection?: ObjectDetectionResult,
    imageUrl: string,
    logger: Console
}) => {
    const { originalTitle, detection, plugin, imageUrl, logger } = props;

    let title;
    let message;
    let data;

    try {
        const { aiPlatform } = plugin.storageSettings.values
        const { apiKeyKey, apiUrlKey, modelKey, systemPromptKey } = getAiSettingKeys(aiPlatform);

        const apiKey = plugin.storageSettings.getItem(apiKeyKey);
        const apiUrl = plugin.storageSettings.getItem(apiUrlKey);
        const model = plugin.storageSettings.getItem(modelKey);
        const systemPrompt = plugin.storageSettings.getItem(systemPromptKey);

        logger.debug(`Calling ${aiPlatform} with ${JSON.stringify({
            aiPlatform,
            apiKey,
            apiUrl,
            model,
            systemPrompt,
            originalTitle,
        })}`);

        if (aiPlatform === AiPlatform.OpenAi) {
            const messageTemplate = createOpenAiTemplate({
                imageUrl,
                model,
                originalTitle,
                systemPrompt,
                detection,
            });

            const response = await axios.post<any>(apiUrl, messageTemplate, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
            });

            data = response.data;

            logger.debug(`Response from ${aiPlatform}: ${JSON.stringify(response.data)}`);
            const jsonMessage = response.data?.choices?.[0]?.message?.content;
            if (jsonMessage) {
                const parsedMessage = JSON.parse(jsonMessage);
                title = parsedMessage.title;
                message = parsedMessage.body;
            }
        }
    } catch (e) {
        logger.log('Error in getAiMessage', e);
    } finally {
        return {
            data,
            message,
            title,
        };
    }
}