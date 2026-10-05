import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AI_PROVIDERS } from "./providers/catalog.mjs";

// Which provider and model plan login tests. Holds no secret: keys stay in the
// macOS Keychain, one slot per provider.
// A model name is a plain identifier such as gpt-4.1-mini or openai/gpt-4.1-mini.
// A web address is refused here so no URL can be typed into the model field.
export const ModelName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/-]+$/)
  .refine((model) => !model.includes("://"), "A model name cannot be a web address.");

const Settings = z.object({
  provider: z.enum(Object.keys(AI_PROVIDERS)),
  model: ModelName,
});

export const DEFAULT_AI_SETTINGS = { provider: "openai", model: AI_PROVIDERS.openai.defaultModel };

export function readAiSettings(directory) {
  const file = join(directory, "ai-settings.json");
  if (!existsSync(file)) return { ...DEFAULT_AI_SETTINGS };
  try {
    return Settings.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function writeAiSettings(directory, input) {
  const settings = Settings.parse(input);
  const file = join(directory, "ai-settings.json");
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(temp, file);
  return settings;
}
