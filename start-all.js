const { spawn } = require("child_process");

function run(name, file) {
  const child = spawn(process.execPath, [file], { stdio: "inherit" });
  child.on("exit", code => console.log(`[${name}] terminó con código ${code}`));
  return child;
}

run("web", "server.js");
run("bot", "index.js");
