import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Server action modules ("use server"). Next's action transform turns a
    // type-only re-export like `export type { X }` into a runtime reference,
    // which crashes every action in the file. Declare or import types instead.
    files: ["src/app/**/actions.ts", "src/app/**/*-actions.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportNamedDeclaration[exportKind='type'][declaration=null]",
          message:
            "Don't re-export types from a \"use server\" file; Next turns them into runtime references. Import the type from its source module instead.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 63k-line visual prototype — kept as a design reference only, not built.
    "reference/**",
  ]),
]);

export default eslintConfig;
