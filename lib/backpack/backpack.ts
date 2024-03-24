import crypto, { KeyObject } from 'crypto';
import axios from 'axios';
import qs from 'qs';
import WebSocket from 'ws';
import pino, { Logger } from "pino";

const API_ENDPOINT = 'https://api.backpack.exchange';
const WS_ENDPOINT = "wss://ws.backpack.exchange";

const DEFAULT_X_WINDOW = 5000;
const DEFAULT_WS_RECONNECT_TIMEOUT = 10000;
const BACKOFF_MILLSECONDS = 5000;

const BACKPACK_INSTRUCTIONS = {
    public: new Map<string, Record<string, string>>([
        ["assets", { method: "GET", url: `${API_ENDPOINT}/api/v1/assets` }],
        ["markets", { method: "GET", url: `${API_ENDPOINT}/api/v1/markets` }],
        ["ticker", { method: "GET", url: `${API_ENDPOINT}/api/v1/ticker` }],
        ["depth", { method: "GET", url: `${API_ENDPOINT}/api/v1/depth` }],
        ["klines", { method: "GET", url: `${API_ENDPOINT}/api/v1/klines` }],
        ["status", { method: "GET", url: `${API_ENDPOINT}/api/v1/status` }],
        ["ping", { method: "GET", url: `${API_ENDPOINT}/api/v1/ping` }],
        ["time", { method: "GET", url: `${API_ENDPOINT}/api/v1/time` }],
        ["trades", { method: "GET", url: `${API_ENDPOINT}/api/v1/trades` }],
    ]),
    private: new Map<string, Record<string, string>>([
        ["balanceQuery", { method: "GET", url: `${API_ENDPOINT}/api/v1/capital`, }],
        ["depositAddressQuery", { method: "GET", url: `${API_ENDPOINT}/wapi/v1/capital/deposit/address` }],
        ["depositQueryAll", { method: "GET", url: `${API_ENDPOINT}/wapi/v1/capital/deposits` }],

        ["orderHistoryQueryAll", { method: "GET", url: `${API_ENDPOINT}/wapi/v1/history/orders` }],
        ["fillHistoryQueryAll", { method: "GET", url: `${API_ENDPOINT}/wapi/v1/history/fills` }],

        ["orderQuery", { method: "GET", url: `${API_ENDPOINT}/api/v1/order` }],
        ["orderExecute", { method: "POST", url: `${API_ENDPOINT}/api/v1/order` }],
        ["orderCancel", { method: "DELETE", url: `${API_ENDPOINT}/api/v1/order` }],
        ["orderQueryAll", { method: "GET", url: `${API_ENDPOINT}/api/v1/orders` }],
        ["orderCancelAll", { method: "DELETE", url: `${API_ENDPOINT}/api/v1/orders` }],

        ["withdraw", { method: "POST", url: `${API_ENDPOINT}/wapi/v1/capital/withdrawals` }],
        ["withdrawalQueryAll", { method: "GET", url: `${API_ENDPOINT}/wapi/v1/capital/withdrawals` }],
    ]),
}

const ORDER_EVENT_TYPES = [
    "orderAccepted",
    "orderCancelled",
    "orderExpired",
    "orderFill",
];

/** @internal */
const _transport = pino.transport({
    targets: [
        {
          level: 'trace',
          target: 'pino/file',
          options: {
            destination: 'backpack.log',
          },
        },
        {
            level: 'trace',
            target: 'pino-pretty',
            options: {},
        },
    ],
});

/** @internal */
const _logger = pino(
    {
        level: "info",
        base: {
            app: "BACKPACK",
        },
        serializers: {
            req: pino.stdSerializers.req,
            res: pino.stdSerializers.res,
        },
    },
    _transport
);

/** @internal */
// https://stackoverflow.com/questions/71916954/crypto-sign-function-to-sign-a-message-with-given-private-key
function _toPkcs8der(rawB64: string): KeyObject {
    var rawPrivate = Buffer.from(rawB64, 'base64').subarray(0, 32);
    var prefixPrivateEd25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
    var der = Buffer.concat([prefixPrivateEd25519, rawPrivate]);
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })
}

/** @internal */
async function _rawRequest(method: string, url: string, headers: Record<string, string>, data: Record<string, any>) {
    headers["User-Agent"] = "Backpack Client";
    headers["Content-Type"] = "application/json; charset=utf-8";

    try {
        const config = {
            headers,
            params: method === "GET" ? data : undefined,
            data: method !== "GET" ? data : undefined
        };

        const response = await axios.request({ url, method, ...config });

        const contentType = response.headers["content-type"];
        if (contentType?.includes("application/json")) {
            const parsed = response.data;
            if (parsed.error && parsed.error.length) {
                const error = parsed.error
                    .filter((e: string) => e.startsWith("E"))
                    .map((e: string) => e.substring(1));
                if (!error.length) {
                    throw new Error("Unknown error");
                }
                throw new Error(`url=${url} body=${JSON.stringify(data)} err=${error.join(", ")}`);
            }
            return parsed;
        } else if (contentType?.includes("text/plain")) {
            return response.data;
        } else {
            return response;
        }
    } catch (error: any) {
        throw error;
    }
};

export type ConnectionConfig = {
    endpoint?: string,
    wsEndpoint?: string,
    xWindow?: number;
    wsReconnectTimeout?: number;
    logger?: Logger;
}

export class Connection {
    /** @internal */ _apiKey: string;
    /** @internal */ _apiSecret: KeyObject;

    /** @internal */ _endpoint: string;
    /** @internal */ _wsEndpoint: string;

    /** @internal */ _xWindow: number;
    /** @internal */ _wsReconnectTimeout: number;

    /** @internal */ _logger: Logger;

    /** @internal */ _isWsConnected: boolean;
    /** @internal */ _wss: WebSocket;

    constructor(
        apiKey: string,
        apiSecret: string,
        config?: ConnectionConfig
    ) {
        this._apiKey = apiKey;
        this._apiSecret = _toPkcs8der(apiSecret);

        this._endpoint = config?.endpoint || API_ENDPOINT;
        this._wsEndpoint = config?.wsEndpoint || WS_ENDPOINT;
        this._xWindow = config?.xWindow || DEFAULT_X_WINDOW;
        this._wsReconnectTimeout = config?.wsReconnectTimeout || DEFAULT_WS_RECONNECT_TIMEOUT;
        this._logger = config?.logger || _logger;

        this._isWsConnected = false;
        this._wss = new WebSocket(this._wsEndpoint);
    }

    /** @internal */
    private _signature = (instruction: string, params: {}, timestamp: number): string => {
        const _params = qs.stringify(params, { sort: (a, b): number => { return a.localeCompare(b) } });
        const _message = "instruction=" + instruction +
            (_params ? "&" + _params : "") +
            "&timestamp=" + timestamp +
            "&window=" + this._xWindow;
        return crypto.sign(null, Buffer.from(_message), this._apiSecret).toString("base64");
    };

    async apiCall(instruction: string, params: Object = {}, retry: number = 3): Promise<any> {
        try {
            const { method, url } = BACKPACK_INSTRUCTIONS.private.has(instruction)
                ? BACKPACK_INSTRUCTIONS.private.get(instruction)!
                : BACKPACK_INSTRUCTIONS.public.get(instruction)!;
            const _headers = () => {
                const timestamp = Date.now();
                const signature = this._signature(instruction, params, timestamp);
                return {
                    "X-Timestamp": timestamp,
                    "X-Window": this._xWindow,
                    "X-API-Key": this._apiKey,
                    "X-Signature": signature,
                };
            };
            let headers = BACKPACK_INSTRUCTIONS.public.has(instruction) ? {} : _headers();
            const response = await _rawRequest(method, url, headers, params);
            return response;
        } catch (error: any) {
            if (instruction == "orderQuery" && error.toString().indexOf('404') != -1) {
                return null;
            }
            if (retry > 0) {
                await new Promise((resolve) => setTimeout(resolve, BACKOFF_MILLSECONDS * (Math.random() + 1)));
                return await this.apiCall(instruction, params, retry - 1);
            } else {
                throw new Error(`API ${instruction} return ${error.toString()}:` +
                    `${error.response && error.response.data ? JSON.stringify(error.response.data) : ''}`);
            }
        }
    }

    onOrderUpdate(callback: any) {
        if (this._isWsConnected) {
            this._wss.close();
            this._isWsConnected = false;
        }

        if (!this._isWsConnected) {
            this._wss = new WebSocket(this._wsEndpoint!);
        }
        
        const subscribeMessage = () => {
            const timestamp = Date.now();
            const signature = this._signature('subscribe', {}, timestamp);
            const subscribeMessage = {
                method: "SUBSCRIBE",
                params: ["account.orderUpdate"],
                signature: [this._apiKey, signature, timestamp.toString(), this._xWindow.toString()]
            };
            return subscribeMessage;
        }

        this._wss.onopen = (event) => {
            this._logger.info('[BACKPACK] WebSocket opened.');
            this._wss.send(JSON.stringify(subscribeMessage()));
        };

        this._wss.onmessage = (event: WebSocket.MessageEvent) => {
            try {
                const eventInfo = JSON.parse(event.data.toString());
                if (eventInfo['data'] && ORDER_EVENT_TYPES.includes(eventInfo['data']['e'])) {
                    callback(eventInfo['data']);
                } else if (eventInfo['error'] && eventInfo['error']['message'] === 'Signature expired') {
                    this._logger.warn('[BACKPACK] Subscribe orderUpdate failed. Retry...');
                    this._wss.send(JSON.stringify(subscribeMessage()));
                } else {
                    this._logger.error(`[BACKPACK] Get unknown event: ${event.type}, ${event.data.toString()}`);
                }
            } catch (e) {
                this._logger.error(`[BACKPACK] Get unknown event: ${event.type}, ${event.data.toString()}`);
            }
        };

        this._wss.onerror = (event) => {
            this._logger.error(`[BACKPACK] WebSocket error: ${event}`)
            this._isWsConnected = false;
        }

        this._wss.onclose = (event) => {
            this._logger.warn("[BACKPACK] WebSocket closed.");
            this._isWsConnected = false;
            setTimeout(() => this.onOrderUpdate(callback), this._wsReconnectTimeout);
        }
    }
}