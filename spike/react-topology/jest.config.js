/** Spike-local jest config (ovn-recon-s3t.10). Transforms PatternFly ESM/TS
 *  sources, which the project config does not need to do. Delete with the spike. */
module.exports = {
    rootDir: '../..',
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    testMatch: ['<rootDir>/spike/react-topology/*.spike.test.ts'],
    transform: {
        '^.+\\.(ts|tsx|js|jsx)$': ['ts-jest', {
            tsconfig: { allowJs: true, esModuleInterop: true, jsx: 'react', target: 'es2019', module: 'commonjs' },
            diagnostics: false,
        }],
    },
    transformIgnorePatterns: ['node_modules/(?!(@patternfly|d3|d3-[a-z-]+|internmap|delaunator|robust-predicates)/)'],
    moduleNameMapper: {
        '\\.(css|less|scss|sass)$': '<rootDir>/__mocks__/styleMock.js',
    },
};
