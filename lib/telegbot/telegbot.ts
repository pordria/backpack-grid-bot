import axios from 'axios';

export class TgBot {
    /** @internal */ _token: string;
    /** @internal */ _chatID: string;

    constructor(
        token: string,
        chatID: string,
    ) {
        this._token = token;
        this._chatID = chatID;
    }

    async notify(message: string, option?: {}) {
        try {
            const url = `https://api.telegram.org/bot${this._token}/sendMessage`;
            const params = {
                chat_id: this._chatID,
                text: message,
                ...option,
            };
            await axios.post(url, params);
        } catch (error) {
            throw error;
        }
    }
}