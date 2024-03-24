import pino from "pino";

const transport = pino.transport({
    targets: [
        {
            level: 'trace',
            target: 'pino-pretty',
            options: {},
        },
    ],
});

export const logger = pino(
    {
        level: "info",
        base: null,
        serializers: {
            req: pino.stdSerializers.req,
            res: pino.stdSerializers.res,
        },
    },
    transport
);