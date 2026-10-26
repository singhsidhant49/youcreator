import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",

  base: {
    application: "youcreator",
  },

  redact: {
    paths: [
      "apiKey",
      "authorization",
      "headers.authorization",
      "password",
      "token",
    ],
    censor: "[REDACTED]",
  },
});
