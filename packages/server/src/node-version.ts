// Must run before the SQLite addon loads: on older Node it crashes the process with no message.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Tracer needs Node.js 22.12 or newer (found ${process.version}). Run "nvm use 22" and start again.`);
  process.exit(1);
}
