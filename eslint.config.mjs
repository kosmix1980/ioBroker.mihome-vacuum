// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';

export default [
    ...config,

    {
        // specify files to exclude from linting here
        ignores: [
            '.dev-server/',
            '.vscode/',
            '*.test.js',
            'test/**/*.js',
            '*.config.mjs',
            'build',
            'admin/build',
            'admin/words.js',
            'admin/admin.d.ts',
            '**/adapter-config.d.ts',
            'gulpfile.js',
            'widgets/',
        ],
    },

    {
        // Migration keeps CommonJS interop (`import x = require` / dynamic require)
        // and gradual typing (@ts-nocheck). Tighten these rules later.
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/no-types': 'off',
            'jsdoc/require-param-description': 'off',
            '@typescript-eslint/no-this-alias': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-redundant-type-constituents': 'off',
            '@typescript-eslint/dot-notation': 'off',
            '@typescript-eslint/await-thenable': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/prefer-promise-reject-errors': 'off',
            '@typescript-eslint/no-unsafe-declaration-merging': 'off',
            'prettier/prettier': 'off',
            'no-unused-vars': 'off',
            'no-prototype-builtins': 'off',
            'prefer-const': 'off',
            'import/no-duplicates': 'off',
            '@typescript-eslint/no-use-before-define': 'off',
            '@typescript-eslint/no-unused-expressions': 'off',
        },
    },
];
