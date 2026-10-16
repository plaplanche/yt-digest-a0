import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["playwright-report/", "test-results/"] }, js.configs.recommended, tseslint.configs.strict);
