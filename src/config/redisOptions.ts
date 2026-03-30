const host = process.env.REDIS_HOST;
const port = Number(process.env.REDIS_PORT);

const isValidConfig =
  typeof host === "string" &&
  host.length > 0 &&
  Number.isInteger(port) &&
  port > 0;

export const redisConnection = isValidConfig
  ? {
      host,
      port,
      password: process.env.REDIS_PASSWORD || undefined,
    }
  : null;