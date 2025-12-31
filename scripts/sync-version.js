const fs = require('fs');
const path = require('path');

const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = require(packageJsonPath);

const oldVersion = packageJson.consolePlugin.version;
const newVersion = packageJson.version;

if (oldVersion !== newVersion) {
    packageJson.consolePlugin.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4) + '\n');
    console.log(`Updated consolePlugin.version from ${oldVersion} to ${newVersion}`);
} else {
    console.log(`consolePlugin.version is already up to date (${newVersion})`);
}
