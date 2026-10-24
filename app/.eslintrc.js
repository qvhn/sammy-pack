module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // `const { dropMe: _drop, ...rest } = obj` is the idiomatic way to omit a
    // key, and the destructured binding is unused on purpose. The base config
    // already allows `_`-prefixed ARGS; this extends the same convention to
    // variables so the omit-a-key idiom doesn't need a disable comment.
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
  },
};
