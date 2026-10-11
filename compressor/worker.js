// Detached helper: finishes jobs that do not fit in Vehla's 15-second window
// (mainly video), then notifies the user and optionally opens the folder.
import { describe, notifyUser, openInFileManager, runBatch } from "./lib/compress.js";

const { files, destDir, openFolder } = JSON.parse(process.argv[2]);

try {
  const { results } = await runBatch(files, destDir);
  const done = results.filter((r) => r.status === "compressed").length;
  const failed = results.filter((r) => r.status === "error");
  const summary = failed.length
    ? `${done} compressed, ${failed.length} failed. ${failed[0].name}: ${describe(failed[0])}`
    : `${results.length} file${results.length === 1 ? "" : "s"} processed, ${done} compressed.`;
  await notifyUser("Compressor finished", summary);
  if (openFolder) await openInFileManager(destDir);
} catch (error) {
  await notifyUser("Compressor failed", error.message);
}
