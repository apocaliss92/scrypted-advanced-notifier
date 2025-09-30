import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory, Part } from "@google/generative-ai";
import sdk, { ChatCompletion, ChatCompletionCreateParamsNonStreaming, ObjectDetectionResult, ScryptedDeviceBase } from "@scrypted/sdk";
import axios from "axios";
import Groq from "groq-sdk";
import AdvancedNotifierPlugin, { PluginSettingKey } from "./main";
import { StorageSetting, StorageSettings } from '@scrypted/sdk/storage-settings';
import { safeParseJson } from './utils';
import { DetectionClass } from './detectionClasses';

export enum AiSource {
    Disabled = 'Disabled',
    LLMPlugin = 'LLM plugin',
}

export const getAiSettingKeys = () => {
    const llmDeviceKey = `llmDevice`;
    const systemPromptKey = `aiSystemPrompt`;
    const occupancyPromptKey = `aiOccupancyPrompt`;

    return {
        llmDeviceKey,
        systemPromptKey,
        occupancyPromptKey
    };
}

export const getAiSettings = (props: {
    storage: StorageSettings<PluginSettingKey>,
    logger: Console,
    onRefresh: () => Promise<void>
}) => {
    const { storage, onRefresh, logger } = props;
    const { aiSource } = storage.values;

    const { llmDeviceKey, systemPromptKey, occupancyPromptKey } = getAiSettingKeys();

    const settings: StorageSetting[] = [];

    if (aiSource !== AiSource.Disabled) {
        settings.push(
            {
                key: llmDeviceKey,
                title: 'LLM tool',
                group: 'AI',
                type: 'device',
                immediate: true,
                deviceFilter: ({ ScryptedInterface, interfaces }) => {
                    return interfaces.includes(ScryptedInterface.ChatCompletion);
                },
                onPut: async () => await onRefresh()
            }
        );
        settings.push({
            key: systemPromptKey,
            group: 'AI',
            subgroup: 'Prompts',
            title: 'Detections prompt',
            type: 'textarea',
            description: 'Prompt to analyze snapshots for detections.',
            defaultValue: 'Create a notification suitable description of the image provided by the user. Describe the people, animals (coloring and breed), or vehicles (color and model) in the image. Do not describe scenery or static objects. Do not direct the user to click the notification. The original notification metadata may be provided and can be used to provide additional context for the new notification, but should not be used verbatim.',
        });
        settings.push({
            key: occupancyPromptKey,
            group: 'AI',
            subgroup: 'Prompts',
            title: 'Occupancy prompt',
            type: 'textarea',
            description: 'Prompt to check occupancy rules. Use the placeholder ${class} to specify the object type watched',
            defaultValue: 'Carefully analyze this image. Count how many distinct physical objects of type {class} are at least partially overlapping or visibly touching the shape of red color. Do not count shadows, textures, or flat surfaces like the ground. Respond with a single number only, with no explanation',
        });
    }

    return settings;
}

const createLlmMessageTemplate = (props: {
    systemPrompt: string,
    b64Image: string,
    originalTitle: string,
    detection?: ObjectDetectionResult,
}): ChatCompletionCreateParamsNonStreaming => {
    const { b64Image, originalTitle, detection, systemPrompt } = props;
    const imageUrl = `data:image/jpeg;base64,${b64Image}`;

    let text = `Original notification message is ${originalTitle}}.`;

    if (detection?.label) {
        text += ` In the image is present a familiar person with name ${detection.label}`;
    }

    const schema = "The response must be in JSON format with a message 'title', 'subtitle', and 'body'. The title and subtitle must not be more than 24 characters each. The body must not be more than 130 characters."
    return {
        model: undefined,
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
    };
}

const createLlmQuestionTemplate = (props: {
    question: string,
    b64Image: string,
}): ChatCompletionCreateParamsNonStreaming => {
    const { b64Image, question } = props;

    return {
        model: undefined,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/jpeg;base64,${b64Image}`
                        }
                    },
                    {
                        type: "text",
                        text: `${question}`
                    }
                ]
            }
        ],
    };
}

export const executeGoogleAi = async (props: {
    systemPrompt: string,
    model: string,
    b64Image: string,
    apiKey: string,
    logger: Console
}) => {
    const { model, systemPrompt, apiKey, b64Image, logger } = props;

    try {
        const promptText = systemPrompt || 'Describe this image in detail';

        const genAI = new GoogleGenerativeAI(apiKey);
        const generativeModel = genAI.getGenerativeModel({ model });

        const generationConfig = {
            temperature: 0.4,
            topK: 32,
            topP: 1,
            maxOutputTokens: 4096,
        };

        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        ];

        // Format the image part using the received Base64 data and mimeType
        const imagePart: Part = {
            inlineData: {
                data: b64Image,
                mimeType: 'image/jpeg',
            },
        };

        const parts: Part[] = [
            { text: promptText },
            imagePart,
        ];

        const result = await generativeModel.generateContent({
            contents: [{ role: 'user', parts }],
            generationConfig,
            safetySettings,
        });

        // Handle cases where the response might be blocked or missing text
        if (!result.response || !result.response.candidates || result.response.candidates.length === 0) {
            // Check for specific finish reasons like safety
            const finishReason = result.response?.promptFeedback?.blockReason;
            let blockMessage = "Analysis response is empty or blocked.";
            if (finishReason) {
                blockMessage += ` Reason: ${finishReason}`;
            }
            logger.error(blockMessage);
            return null;
        }

        return result.response.text();

    } catch (error: any) {
        logger.error("Error analyzing image:", error);
        let errorMessage = "Failed to analyze image.";
        // Improved error handling for common issues
        if (error instanceof SyntaxError) { // Handle JSON parsing errors
            errorMessage = "Invalid request format.";
            logger.error(errorMessage);
            return null;
        } else if (error.message && error.message.includes('API key not valid')) {
            errorMessage = "Invalid API Key provided. Please check your key and try again.";
        } else if (error.message && error.message.includes('quota')) { // Handle quota errors
            errorMessage = "API quota exceeded. Please check your usage limits.";
        } else if (error.message) {
            errorMessage += ` Reason: ${error.message}`;
        }
        logger.error(errorMessage);
        return null;
    }
};

export const getAiMessage = async (props: {
    plugin: AdvancedNotifierPlugin,
    originalTitle: string,
    detection?: ObjectDetectionResult,
    b64Image: string,
    logger: Console,
    timeStamp: number,
    device: ScryptedDeviceBase,
    prompt: string
}) => {
    const { device, originalTitle, detection, plugin, logger, b64Image, timeStamp, prompt: systemPrompt } = props;

    const cacheKey = `${device.id}_${timeStamp}`;
    let title = originalTitle;
    let message = plugin.aiMessageResponseMap[cacheKey];
    let fromCache = false;

    try {
        if (!message) {
            const { aiSource } = plugin.storageSettings.values;
            const { llmDeviceKey } = getAiSettingKeys();

            if (aiSource === AiSource.LLMPlugin) {
                const llmDeviceParent = plugin.storageSettings.getItem(llmDeviceKey as any) as ScryptedDeviceBase;

                if (llmDeviceParent) {
                    const llmDevice = sdk.systemManager.getDeviceById<ChatCompletion>(llmDeviceParent.id);
                    const template = createLlmMessageTemplate({
                        b64Image,
                        originalTitle,
                        detection,
                        systemPrompt,
                    })
                    const res = await llmDevice.getChatCompletion(template);
                    logger.log(`${llmDeviceParent.name} result: ${JSON.stringify({ ...res, systemPrompt })}`);

                    const resJson = safeParseJson(res.choices[0]?.message?.content);
                    message = resJson?.body;
                }
            } else {
                logger.error(`Ai provider Manual is not supported anymore. Install LLM plugin and select it in the AI section`);
            }
        } else {
            fromCache = true
        }
    } catch (e) {
        logger.log('Error in getAiMessage', e);
    } finally {
        plugin.aiMessageResponseMap[cacheKey] = message;

        return {
            message,
            title,
            fromCache,
        }
    }
}

export const checkObjectsOccupancy = async (props: {
    plugin: AdvancedNotifierPlugin,
    b64Image: string,
    logger: Console,
    detectionClass: DetectionClass,
}) => {
    const { b64Image, logger, plugin, detectionClass } = props;

    const { occupancyPromptKey } = getAiSettingKeys();
    let question: string = plugin.storageSettings.getItem(occupancyPromptKey as any);
    question = question?.replaceAll('{class}', detectionClass);

    let response: string;

    try {
        const { aiSource } = plugin.storageSettings.values;
        const { llmDeviceKey } = getAiSettingKeys();

        if (aiSource === AiSource.LLMPlugin) {
            const llmDeviceParent = plugin.storageSettings.getItem(llmDeviceKey as any) as ScryptedDeviceBase;

            if (llmDeviceParent) {
                const llmDevice = sdk.systemManager.getDeviceById<ChatCompletion>(llmDeviceParent.id);
                const template = createLlmQuestionTemplate({
                    b64Image,
                    question
                })
                const res = await llmDevice.getChatCompletion(template);
                logger.log(`${llmDeviceParent.name} result: ${JSON.stringify({ ...res, question })}`);

                response = res.choices[0]?.message?.content;
            }
        }
    } catch (e) {
        logger.log('Error in checkObjectsOccupancy', e);
    } finally {
        return {
            response,
        }
    }
}

export const confirmDetection = async (props: {
    plugin: AdvancedNotifierPlugin,
    b64Image: string,
    logger: Console,
    prompt: string
}) => {
    const { b64Image, logger, plugin, prompt } = props;

    let response: string;
    const question = `${prompt}. Respond with "yes" or "no" only, with no explanation.`

    try {
        const { aiSource } = plugin.storageSettings.values;
        const { llmDeviceKey } = getAiSettingKeys();

        if (aiSource === AiSource.LLMPlugin) {
            const llmDeviceParent = plugin.storageSettings.getItem(llmDeviceKey as any) as ScryptedDeviceBase;

            if (llmDeviceParent) {
                const llmDevice = sdk.systemManager.getDeviceById<ChatCompletion>(llmDeviceParent.id);
                const template = createLlmQuestionTemplate({
                    b64Image,
                    question
                })
                const res = await llmDevice.getChatCompletion(template);
                logger.log(`LLM filter response from ${llmDeviceParent.name}. Result: ${JSON.stringify({ ...res, question })}`);

                response = res.choices[0]?.message?.content;
            }
        } else {
            logger.error(`Ai provider Manual is not supported anymore. Install LLM plugin and select it in the AI section`);
        }
    } catch (e) {
        logger.log('Error in confirmDetection', e);
    } finally {
        return {
            response,
        }
    }
}