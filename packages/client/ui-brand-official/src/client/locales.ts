/** Product names remain identical in both supported locales. */
export const zh = {
  name: 'ione harness',
  product: 'ione',
  family: 'harness',
} satisfies Record<string, string>

/** English wordmark labels, with the same keys as the Chinese dictionary. */
export const en = { ...zh } satisfies Record<keyof typeof zh, string>
