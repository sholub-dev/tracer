// v13 package.json "exports" omits its bundled typings, so NodeNext cannot find them.
declare module "better-sqlite3-multiple-ciphers" {
  import Database = require("better-sqlite3");
  export = Database;
}
