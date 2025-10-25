import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      // Forbid importing next/document in App Router projects
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/document",
              message:
                "Do not import next/document in App Router. Use app/layout.tsx for <html>/<body> only.",
            },
          ],
        },
      ],
      // Forbid Document primitives usage anywhere
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXIdentifier[name=/^(Html|Head|Main|NextScript)$/]",
          message: "Do not use Document primitives (Html/Head/Main/NextScript) in App Router.",
        },
      ],
    },
  },
  // Forbid <html>/<body> usage outside app/layout.tsx
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mdx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name=/^(html|body)$/]",
          message: "Use <html>/<body> only in app/layout.tsx.",
        },
      ],
    },
  },
  // Allow <html>/<body> in the canonical layout file
  {
    files: ["src/app/layout.tsx"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];

export default eslintConfig;
