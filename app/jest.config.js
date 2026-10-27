module.exports = {
  preset: '@react-native/jest-preset',
  // Machine-independence pin (agent-slot pool) — see jest.setup.ts.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Tests own their git repos: drop a GIT_DIR inherited from a hook — see jest.global-setup.js.
  globalSetup: '<rootDir>/jest.global-setup.js',
  moduleNameMapper: {
    // Resolve the workspace SDK + queue-service packages to their SOURCE so
    // tests run without first building each dist/ (matching the no-build
    // convention the source-* adapter tests rely on). The engine's
    // webhook-auth re-exports the client signer from `@sammy-pack/sdk`, so a
    // few engine tests pull the SDK index in transitively.
    '^@sammy-pack/sdk$': '<rootDir>/packages/sdk/src/index.ts',
    // The workspace packages' sources use extensioned ESM imports
    // (`./foo.js`, `../index.js`) between their own modules — correct for
    // their NodeNext output, but jest's resolver won't add `.ts` for an
    // explicit `.js`. Strip the extension off RELATIVE specifiers so jest
    // resolves them via moduleFileExtensions: a `./foo.js` whose real file
    // is `./foo.ts` now resolves, and a genuine `./foo.js` still resolves
    // (the resolver re-adds `.js`). Anchored to `./` and `../`, so bare
    // package specifiers are untouched.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
