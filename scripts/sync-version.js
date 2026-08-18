const fs = require('fs');
const path = require('path');

const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = require(packageJsonPath);

const newVersion = packageJson.version;

// Sync consolePlugin.version
const oldConsolePluginVersion = packageJson.consolePlugin.version;
if (oldConsolePluginVersion !== newVersion) {
    packageJson.consolePlugin.version = newVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 4) + '\n');
    console.log(`Updated consolePlugin.version from ${oldConsolePluginVersion} to ${newVersion}`);
} else {
    console.log(`consolePlugin.version is already up to date (${newVersion})`);
}
