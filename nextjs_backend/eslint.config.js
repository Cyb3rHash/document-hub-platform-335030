/** @type {import("eslint").FlatConfig[]} */
const jsConfig = {
  files: ['**/*.js'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'commonjs',
  },
  rules: {
    semi: ['error', 'always'],
    quotes: ['error', 'single'],
  },
};

const ignoreConfig = {
  ignores: ['node_modules/**'],
};

module.exports = [ignoreConfig, jsConfig];