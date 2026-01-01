const fs = require('fs');
const path = require('path');

const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = require(packageJsonPath);

const chartYamlPath = path.resolve(__dirname, '../charts/ovn-recon/Chart.yaml');

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

// Sync Helm chart appVersion
if (fs.existsSync(chartYamlPath)) {
    const chartYaml = fs.readFileSync(chartYamlPath, 'utf8');
    const appVersionRegex = /^appVersion:\s*["']?(.+?)["']?$/m;
    const match = chartYaml.match(appVersionRegex);

    if (match) {
        const oldAppVersion = match[1];
        if (oldAppVersion !== newVersion) {
            const updatedChartYaml = chartYaml.replace(
                appVersionRegex,
                `appVersion: "${newVersion}"`
            );
            fs.writeFileSync(chartYamlPath, updatedChartYaml);
            console.log(`Updated Helm chart appVersion from ${oldAppVersion} to ${newVersion}`);
        } else {
            console.log(`Helm chart appVersion is already up to date (${newVersion})`);
        }
    }
}
