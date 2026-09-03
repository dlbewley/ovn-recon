/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    // spike/ carries its own config (see spike/react-topology/jest.config.js);
    // .claude/ holds session worktrees whose copies of the tree would triple
    // the suite and trip haste-map duplicate warnings. The pattern is anchored
    // to <rootDir> on purpose: an unanchored '/.claude/' also matched every
    // test INSIDE a worktree (its path contains /.claude/worktrees/), so jest
    // run from a worktree found no tests at all.
    testPathIgnorePatterns: ['/node_modules/', '/spike/', '<rootDir>/.claude/'],
    modulePathIgnorePatterns: ['<rootDir>/.claude/'],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    moduleNameMapper: {
        "\\.(css|less|scss|sass)$": "<rootDir>/__mocks__/styleMock.js",
        "\\.(jpg|jpeg|png|gif|eot|otf|webp|svg|ttf|woff|woff2|mp4|webm|wav|mp3|m4a|aac|oga)$": "<rootDir>/__mocks__/fileMock.js"
    }
};
