import axios from "axios";
import AdvancedNotifierPlugin from "./main";
import { AiPlatform, getAiSettingKeys } from "./utils";

export const createOpenAiTemplate = (props: {
    systemPrompt: string, model: string, imageUrl: string, originalTitle: string
}) => {
    const { imageUrl, originalTitle, model, systemPrompt } = props;
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
                        text: `Original notification metadata: ${originalTitle}}`,
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
    imageUrl: string,
    logger: Console
}) => {
    const { originalTitle, plugin, imageUrl, logger } = props;

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