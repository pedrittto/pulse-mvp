const restrictedNextDocument = {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'next/document',
            message:
              'Do not import next/document in App Router. Use app/layout.tsx for <html>/<body>.',
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'JSXIdentifier[name=/^(Html|Head|Main|NextScript)$/]',
        message: 'Do not use Document primitives (Html/Head/Main/NextScript) in App Router.',
      },
    ],
  },
};

module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'next/typescript'],
  ignorePatterns: ['**/node_modules/**', '**/.next/**', '**/out/**', '**/build/**'],
  overrides: [
    {
      files: ['**/*.{ts,tsx,js,jsx,mdx}'],
      ...restrictedNextDocument,
    },
  ],
};


