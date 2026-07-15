const { spawn } = require("child_process");

function run(name, command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  child.on("exit", code => {
    console.log(`[${name}] terminó con código ${code}`);
  });

  return child;
}

run("web", "node", ["server.js"]);
run("bot", "node", ["discord-bot.js"]);
