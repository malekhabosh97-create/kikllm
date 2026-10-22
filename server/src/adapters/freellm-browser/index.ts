import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { freellmModels, listModels } from "./models.js";

export const freellmBrowserAdapter: ServerAdapterModule = {
  type: "freellm_browser",
  execute,
  testEnvironment,
  models: freellmModels,
  listModels,
  supportsInstructionsBundle: true,
  getConfigSchema: () => ({
    fields: [
      {
        key: "model",
        name: "model",
        label: "Model",
        type: "select",
        defaultValue: "deepseek-normal",
        options: freellmModels.map((m) => ({ value: m.id, label: m.label })),
      },
    ],
  }),
};

export { execute, freellmModels, listModels };
