import "dotenv/config";
import { startServer } from "./start";

// AURORA_AUTO_OPEN=false lets a silent/background launch (e.g. a scheduled
// task at logon) skip popping a browser tab every time.
startServer({ openBrowser: process.env.AURORA_AUTO_OPEN !== "false" }).catch((err) => {
  console.error(err);
  process.exit(1);
});
