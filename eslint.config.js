const js = require("@eslint/js");
const { FlatCompat } = require("@eslint/eslintrc");
const path = require("path");
const { fileURLToPath } = require("url");

// Mimic CommonJS variables -- not needed in CJS file but good practice if moving to MJS
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname,
});

module.exports = [
    js.configs.recommended,
    ...compat.extends("plugin:react/recommended"),
    ...compat.extends("plugin:@typescript-eslint/recommended"),
    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            parser: require("@typescript-eslint/parser"),
        },
        rules: {
            "react/react-in-jsx-scope": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": "warn",
            "react/no-unescaped-entities": "off"
        },
        settings: {
            react: {
                version: "detect"
            }
        }
    }
];
