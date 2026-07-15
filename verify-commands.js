const fs = require('fs');
const path = require('path');

const root = __dirname;
const registry = JSON.parse(fs.readFileSync(path.join(root, 'commands.json'), 'utf8'));
const deploy = fs.readFileSync(path.join(root, 'deploy-commands.js'), 'utf8');
const handlers = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

const names = registry.map(command => command.name);
const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
const missingDeploy = names.filter(name => !deploy.includes(`.setName("${name}")`));
const missingHandlers = names.filter(name => !handlers.includes(`interaction.commandName === "${name}"`));
const handlerNames = [...handlers.matchAll(/interaction\.commandName === "([^"]+)"/g)].map(match => match[1]);
const extraHandlers = [...new Set(handlerNames.filter(name => !names.includes(name)))];

const report = {
  ok: duplicateNames.length === 0 && missingDeploy.length === 0 && missingHandlers.length === 0 && extraHandlers.length === 0,
  total: names.length,
  commands: names,
  duplicateNames,
  missingDeploy,
  missingHandlers,
  extraHandlers,
  checkedAt: new Date().toISOString()
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
