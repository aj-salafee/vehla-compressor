import { Store, runStoreExtension } from "@vehla/store-sdk";

runStoreExtension(async ({ commandID, query }) => {
  if (commandID === "greet") {
    return Store.showMessage(`Hello, ${query || "world"}!`);
  }
  throw new Error(`Unknown command: ${commandID}`);
});
