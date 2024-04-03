import { retrieveEnv, logger } from './lib';
import { Connection } from './lib/backpack';
import { TgBot } from './lib/telegbot/telegbot';

const BACKPACK_API_KEY = retrieveEnv('BACKPACK_API_KEY');
const BACKPACK_API_SECRET = retrieveEnv('BACKPACK_API_SECRET');

const TG_BOT_API_TOKEN = retrieveEnv('TELEGRAM_BOT_API_TOKEN');
const TG_TARGET_CHAT_ID = retrieveEnv('TELEGRAM_TARGET_CHAT_ID');
const TG_NOTIFY_INTERVAL = 3600000;

const SYMBOL = retrieveEnv('SYMBOL');
const LOWER_PRICE = parseFloat(retrieveEnv('LOWER_PRICE'));
const UPPER_PRICE = parseFloat(retrieveEnv('UPPER_PRICE'));
const PRICE_DECIMAL = parseFloat(retrieveEnv('PRICE_DECIMAL'));
const NUMBER_OF_GRIDS = parseInt(retrieveEnv('NUMBER_OF_GRIDS'));
const QUANTITY_PER_GRID = parseFloat(retrieveEnv('QUANTITY_PER_GRID'));


const connection = new Connection(BACKPACK_API_KEY, BACKPACK_API_SECRET);

const bot_notify = () => {
    if(TG_BOT_API_TOKEN == ''){
        return;
    }
    const bot = new TgBot(TG_BOT_API_TOKEN, TG_TARGET_CHAT_ID);
    setInterval(async () => {
        try {
            const { lastPrice: lastPrice } = await connection.apiCall("ticker", { symbol: SYMBOL });
            const orders = await connection.apiCall("orderQueryAll", { symbol: SYMBOL });

            let bid = orders.filter((order: any) => order['side']== 'Bid').length;
            let ask = orders.length - bid;
            
            bot.notify(`
<b>[${SYMBOL}] ${lastPrice}</b>
Bid: ${bid} | Ask: ${ask}
            `, { parse_mode: "html" });
        } catch (error) {
            logger.error(`[${SYMBOL}] Notify user failed: ${error}`);
        }
    }, TG_NOTIFY_INTERVAL);
}

const run = async () => {
    const gridStep = (UPPER_PRICE - LOWER_PRICE) / NUMBER_OF_GRIDS;

    let orders: number[] = [];
    for (let i = 0; i < NUMBER_OF_GRIDS; i++) {
        let price = LOWER_PRICE + i * gridStep;
        orders.push(price);
    }

    const _ = await connection.apiCall("orderCancelAll", { symbol: SYMBOL });
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const { lastPrice: lastPrice } = await connection.apiCall("ticker", { symbol: SYMBOL });

    const orderExecute = async (clientId: number, price: number, side: string, notice: boolean = false) => {
        const _ = await connection.apiCall("orderExecute", {
            clientId: clientId,
            orderType: "Limit",
            price: price.toFixed(PRICE_DECIMAL),
            quantity: QUANTITY_PER_GRID,
            side: side,
            symbol: SYMBOL,
            timeInForce: "GTC"
        });
        logger.info(`[${SYMBOL}] ${side} ${QUANTITY_PER_GRID}_${price.toFixed(PRICE_DECIMAL)}.`);
    };
    orders.forEach(async (price, index) => await orderExecute(index, price, price < lastPrice ? 'Bid' : 'Ask'));

    connection.onOrderUpdate(async (orderUpdateEvent: any) => {
        try {
            const eventType = orderUpdateEvent['e'];
            if (eventType === 'orderFill') {
                const index = parseInt(orderUpdateEvent['c'] ? orderUpdateEvent['c'] : -1);
                if (index < 1 || index >= orders.length - 1) {
                    return;
                }
                const side = orderUpdateEvent['S'];
                const clientId = side == 'Bid' ? index + 1 : index - 1;
                const order = await connection.apiCall("orderQuery", { symbol: SYMBOL, clientId: clientId });
                if (order == null) {
                    const _ = await orderExecute(clientId, orders[clientId], side == "Bid" ? "Ask" : "Bid", true);
                }
            }
        } catch (error: any) {
            logger.error(`[${SYMBOL}] ${error.toString()}`);
        }
    });

    // telegram bot notify
    bot_notify();
};

run();
