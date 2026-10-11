import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, runStoreExtension } from "@vehla/store-sdk";
import { describe, formatBytes, openInFileManager, runBatch } from "./lib/compress.js";

// Vehla kills a command after 15 s; stop starting new work a little earlier.
const BUDGET_MS = 10_000;
const WORKER = fileURLToPath(new URL("./worker.js", import.meta.url));

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

async function saveDestination(dataDirectory, destDir) {
  if (!dataDirectory) return;
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(path.join(dataDirectory, "state.json"), JSON.stringify({ destDir }));
}

async function loadDestination(dataDirectory) {
  if (!dataDirectory) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dataDirectory, "state.json"), "utf8")).destDir;
  } catch {
    return null;
  }
}

async function compress({ context }) {
  const { files: rawFiles, destination, openFolder } = context.formValues;
  const files = [...new Map(asArray(rawFiles).map((f) => [f.path, f])).values()];
  if (files.length === 0) throw new Error("Choose at least one file to compress.");
  if (!destination?.path) throw new Error("Choose a destination folder.");

  const destDir = path.resolve(destination.path);
  const stat = await fs.stat(destDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("The destination must be a folder.");
  await fs.access(destDir, fs.constants.W_OK).catch(() => {
    throw new Error("Vehla can't write to that folder. Choose another destination.");
  });

  await saveDestination(context.dataDirectory, destDir);

  const { results, deferred } = await runBatch(files, destDir, {
    deadlineAt: Date.now() + BUDGET_MS,
  });

  if (deferred.length > 0) {
    const payload = JSON.stringify({ files: deferred, destDir, openFolder: Boolean(openFolder) });
    spawn(process.execPath, [WORKER, payload], { detached: true, stdio: "ignore" }).unref();
  } else if (openFolder) {
    await openInFileManager(destDir);
  }

  const compressed = results.filter((r) => r.status === "compressed");
  const before = compressed.reduce((sum, r) => sum + r.before, 0);
  const after = compressed.reduce((sum, r) => sum + r.after, 0);

  const sections = [];
  if (results.length > 0) {
    sections.push({
      title: "Results",
      items: results.map((r) => ({ type: "detail", label: r.name, value: describe(r) })),
    });
  }
  if (deferred.length > 0) {
    sections.push({
      title: "Still working",
      items: [
        {
          type: "markdown",
          text:
            `${deferred.length} larger file${deferred.length === 1 ? " is" : "s are"} ` +
            `compressing in the background (${deferred.map((f) => f.name).join(", ")}). ` +
            "You'll get a notification when finished.",
        },
      ],
    });
  }

  return Store.view({
    title: compressed.length > 0 ? `Saved ${formatBytes(before - after)}` : "Compression finished",
    subtitle: destDir,
    sections,
  });
}

async function openFolder({ context }) {
  const destDir = await loadDestination(context.dataDirectory);
  if (!destDir) return Store.showMessage("No destination folder yet. Run “Compress Files” first.");
  const stat = await fs.stat(destDir).catch(() => null);
  if (!stat?.isDirectory()) return Store.showMessage("The last destination folder no longer exists.");
  await openInFileManager(destDir);
  return Store.showMessage(`Opened ${destDir}`);
}

runStoreExtension(async (invocation) => {
  switch (invocation.commandID) {
    case "compress":
      return compress(invocation);
    case "open-folder":
      return openFolder(invocation);
    default:
      throw new Error(`Unknown command: ${invocation.commandID}`);
  }
});
