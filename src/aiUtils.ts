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
    Manual = 'Manual',
}

export enum AiPlatform {
    OpenAi = 'OpenAi',
    GoogleAi = 'GoogleAi',
    AnthropicClaude = 'AnthropicClaude',
    Groq = 'Groq',
}

export const getAiSettingKeys = () => {
    const llmDeviceKey = `llmDevice`;
    const aiPlatformKey = `aiPlatform`;
    const systemPromptKey = `aiSystemPrompt`;
    const occupancyPromptKey = `aiOccupancyPrompt`;

    return {
        llmDeviceKey,
        aiPlatformKey,
        systemPromptKey,
        occupancyPromptKey
    };
}

export const getManualAiSettingKeys = (aiPlatform: AiPlatform) => {
    const apiKeyKey = `${aiPlatform}:aiApiKey`;
    const apiUrlKey = `${aiPlatform}:aiApiUrl`;
    const modelKey = `${aiPlatform}:aiModel`;

    return {
        apiKeyKey,
        apiUrlKey,
        modelKey,
    }
}

export const getAiSettings = (props: {
    storage: StorageSettings<PluginSettingKey>,
    logger: Console,
    onRefresh: () => Promise<void>
}) => {
    const { storage, onRefresh } = props;
    const { aiSource } = storage.values;

    const { aiPlatformKey, llmDeviceKey, systemPromptKey, occupancyPromptKey } = getAiSettingKeys();
    const aiPlatform = storage.getItem(aiPlatformKey as any) as AiPlatform ?? AiPlatform.OpenAi;

    const settings: StorageSetting[] = [];

    if (aiSource === AiSource.LLMPlugin) {
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
    } else if (aiSource === AiSource.Manual) {
        settings.push(
            {
                key: aiPlatformKey,
                title: 'AI Platform',
                type: 'string',
                group: 'AI',
                immediate: true,
                choices: Object.values(AiPlatform),
                defaultValue: AiPlatform.OpenAi,
                onPut: async () => await onRefresh()
            }
        );

        const { apiKeyKey, apiUrlKey, modelKey } = getManualAiSettingKeys(aiPlatform);

        if ([AiPlatform.OpenAi].includes(aiPlatform)) {
            settings.push(
                {
                    key: apiUrlKey,
                    group: 'AI',
                    title: 'API URL',
                    description: 'The API URL of the OpenAI compatible server.',
                    defaultValue: 'https://api.openai.com/v1/chat/completions',
                },
            );
        }

        if (
            [AiPlatform.OpenAi,
            AiPlatform.GoogleAi,
            AiPlatform.AnthropicClaude,
            AiPlatform.Groq,
            ].includes(aiPlatform)) {
            settings.push(
                {
                    key: apiKeyKey,
                    title: 'API Key',
                    description: 'The API Key or token.',
                    group: 'AI',
                },
                {
                    key: modelKey,
                    group: 'AI',
                    title: 'Model',
                    description: 'The model to use to generate the image description. Must be vision capable.',
                    defaultValue: defaultModel[aiPlatform],
                }
            );
        }
    }

    if (aiSource !== AiSource.Disabled) {
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

// To Remove when LLM is official
export const defaultModel: Record<AiPlatform, string> = {
    [AiPlatform.AnthropicClaude]: 'claude-3-opus-20240229',
    [AiPlatform.OpenAi]: 'gpt-4o',
    [AiPlatform.GoogleAi]: 'gemini-1.5-flash',
    [AiPlatform.Groq]: 'llama-3.2-90b-vision-preview',
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

const executeOpenAi = async (props: {
    systemPrompt: string,
    model: string,
    b64Image: string,
    originalTitle: string,
    detection?: ObjectDetectionResult,
    logger: Console,
    apiUrl: string,
    apiKey: string
}) => {
    const { b64Image, originalTitle, model, systemPrompt, detection, logger, apiKey, apiUrl } = props;
    const imageUrl = `data:image/jpeg;base64,${b64Image}`;

    let text = `Original notification message is ${originalTitle}}.`;

    if (detection?.label) {
        text += ` In the image is present a familiar person with name ${detection.label}`;
    }

    const schema = "The response must be in JSON format with a message 'title', 'subtitle', and 'body'. The title and subtitle must not be more than 24 characters each. The body must not be more than 130 characters."
    const template = {
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
    };

    const response = await axios.post<any>(apiUrl, template, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
    });

    logger.debug(`Response from ${AiPlatform.OpenAi}: ${JSON.stringify(response.data)}`);
    const jsonMessage = response.data?.choices?.[0]?.message?.content;
    if (jsonMessage) {
        const parsedMessage = JSON.parse(jsonMessage);
        const title = parsedMessage.title;
        const message = parsedMessage.body;

        return {
            title,
            message
        }
    }

    return {};
}

const executeAnthropicClaude = async (props: {
    systemPrompt: string,
    model: string,
    b64Image: string,
    logger: Console,
    apiKey: string
}) => {
    const { b64Image, model, systemPrompt, logger, apiKey } = props;

    const anthropic = new Anthropic({ apiKey });

    const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        messages: [
            {
                role: "user", content: [
                    { type: "text", text: systemPrompt },
                    { type: "image", source: { type: "base64", data: b64Image, media_type: 'image/jpeg' } }
                ]
            }
        ]
    });

    logger.debug(`Response from ${AiPlatform.AnthropicClaude}: ${JSON.stringify(response.content)}`);
    const textResponse = response.content.find(item => item.type === "text");
    return textResponse?.text;
}

const executeGroq = async (props: {
    systemPrompt: string,
    model: string,
    b64Image: string,
    logger: Console,
    apiKey: string
}) => {
    const { b64Image, model, systemPrompt, logger, apiKey } = props;

    const groq = new Groq({ apiKey });

    const response = await groq.chat.completions.create({
        model,
        messages: [
            { role: 'user', content: systemPrompt },
            { role: 'user', content: `data:image/jpeg;base64,${b64Image}` }
        ],
        max_tokens: 1024,
    });

    const data = response.choices[0].message.content;
    logger.debug(`Response from ${AiPlatform.Groq}: ${JSON.stringify(data)}`);
    return data;
}

export const getAiMessage = async (props: {
    plugin: AdvancedNotifierPlugin,
    originalTitle: string,
    detection?: ObjectDetectionResult,
    b64Image: string,
    logger: Console,
    timeStamp: number,
    device: ScryptedDeviceBase
}) => {
    const { device, originalTitle, detection, plugin, logger, b64Image, timeStamp } = props;

    const cacheKey = `${device.id}_${timeStamp}`;
    let title = originalTitle;
    let message = plugin.aiMessageResponseMap[cacheKey];
    let fromCache = false;

    try {
        if (!message) {
            const { aiSource } = plugin.storageSettings.values;
            const { aiPlatformKey, llmDeviceKey, systemPromptKey } = getAiSettingKeys();
            const systemPrompt = plugin.storageSettings.getItem(systemPromptKey as any);

            if (aiSource === AiSource.Manual) {
                const aiPlatform = plugin.storageSettings.getItem(aiPlatformKey as any);
                const { apiKeyKey, apiUrlKey, modelKey } = getManualAiSettingKeys(aiPlatform);

                const apiKey = plugin.storageSettings.getItem(apiKeyKey as any);
                const apiUrl = plugin.storageSettings.getItem(apiUrlKey as any);
                const model = plugin.storageSettings.getItem(modelKey as any);

                logger.debug(`Calling ${aiPlatform} with ${JSON.stringify({
                    aiPlatform,
                    apiKey,
                    apiUrl,
                    model,
                    systemPrompt,
                    originalTitle,
                })}`);

                if (aiPlatform === AiPlatform.OpenAi) {
                    const result = await executeOpenAi({
                        apiKey,
                        apiUrl,
                        b64Image,
                        logger,
                        model,
                        originalTitle,
                        systemPrompt,
                        detection,
                    });

                    title = result.title ?? originalTitle;
                    message = result.message;
                } else if (aiPlatform === AiPlatform.GoogleAi) {
                    const result = await executeGoogleAi({
                        apiKey,
                        b64Image,
                        logger,
                        model,
                        systemPrompt,
                    });

                    message = result;
                } else if (aiPlatform === AiPlatform.AnthropicClaude) {
                    const result = await executeAnthropicClaude({
                        apiKey,
                        b64Image,
                        logger,
                        model,
                        systemPrompt,
                    });

                    message = result;
                } else if (aiPlatform === AiPlatform.Groq) {
                    const result = await executeGroq({
                        apiKey,
                        b64Image,
                        logger,
                        model,
                        systemPrompt,
                    });

                    message = result;
                }
            } else if (aiSource === AiSource.LLMPlugin) {
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
                logger.log(`${llmDeviceParent.name} result: ${JSON.stringify({ ...res, question })}`);

                response = res.choices[0]?.message?.content;
            }
        }
    } catch (e) {
        logger.log('Error in confirmDetection', e);
    } finally {
        return {
            response,
        }
    }
}