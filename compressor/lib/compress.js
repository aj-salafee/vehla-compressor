import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A result must be at least this much smaller than the original to be kept.
const MIN_SAVING = 0.97;

const VIDEO = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]);
const ALREADY_COMPRESSED = new Set([
  ".zip", ".gz", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".docx", ".xlsx",
  ".pptx", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".gif",
]);

export function classify(file) {
  if (file.isDirectory) return "generic";
  const ext = path.extname(file.path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext === ".png") return "png";
  if (ext === ".heic") return "heic";
  if (ext === ".webp") return "webp";
  if (ext === ".pdf") return "pdf";
  if (VIDEO.has(ext)) return "video";
  if (ALREADY_COMPRESSED.has(ext)) return "skip";
  return "generic";
}

export function run(cmd, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    const timer =
      timeoutMs && setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

async function haveTool(name) {
  const { code } = await run("/usr/bin/which", [name]);
  return code === 0;
}

async function sizeOf(p) {
  const stat = await fs.stat(p);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(p)) total += await sizeOf(path.join(p, entry));
  return total;
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// "photo.jpg" -> "photo (1).jpg" when the name is already taken.
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 1; await exists(candidate); n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

async function probeAudioCodecs(p) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", p],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(out.split("\n").map((l) => l.trim()).filter(Boolean)));
  });
}

// Audio that is safe to copy untouched (no quality loss, and the only option
// for codecs ffmpeg cannot decode, such as the iPhone's spatial "apple_apac").
const COPYABLE_AUDIO = new Set(["aac", "apple_apac", "alac", "ac3", "eac3", "mp3"]);

async function videoPlan(file, stagedIn) {
  const stem = path.basename(file.path, path.extname(file.path));
  const codecs = await probeAudioCodecs(stagedIn);
  const copyAudio = codecs.length > 0 && codecs.every((c) => COPYABLE_AUDIO.has(c));
  // APAC only lives in QuickTime containers.
  const container = codecs.includes("apple_apac") ? "mov" : "mp4";
  return {
    outName: `${stem}-compressed.${container}`,
    cmd: "ffmpeg",
    args: (i, o) => [
      "-v", "error", "-y", "-i", i, "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
      "-c:v", "libx265", "-crf", "24", "-preset", "medium", "-tag:v", "hvc1",
      ...(copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k"]),
      "-movflags", "+faststart", o,
    ],
  };
}

// Returns { outName, build(inPath, outPath, ctx) } for each kind.
// Every builder returns the argv for the tool, never a shell string.
async function plan(kind, file) {
  const ext = path.extname(file.path);
  const stem = path.basename(file.path, ext);
  switch (kind) {
    case "jpeg":
      return {
        outName: `${stem}-compressed${ext}`,
        cmd: "/usr/bin/sips",
        args: (i, o) => ["-s", "format", "jpeg", "-s", "formatOptions", "85", i, "--out", o],
      };
    case "heic":
      return {
        outName: `${stem}-compressed${ext}`,
        cmd: "/usr/bin/sips",
        args: (i, o) => ["-s", "format", "heic", "-s", "formatOptions", "80", i, "--out", o],
      };
    case "webp":
      return {
        outName: `${stem}-compressed${ext}`,
        cmd: "cwebp",
        args: (i, o) => ["-q", "85", "-m", "6", "-metadata", "none", i, "-o", o],
      };
    case "png":
      return (await haveTool("oxipng"))
        ? {
            outName: `${stem}-compressed${ext}`,
            cmd: "oxipng",
            args: (i, o) => ["-o", "4", "--strip", "safe", "--out", o, i],
          }
        : {
            outName: `${stem}-compressed${ext}`,
            cmd: "ffmpeg",
            args: (i, o) => ["-v", "error", "-y", "-i", i, "-c:v", "png", "-compression_level", "9", "-pred", "mixed", o],
          };
    case "pdf":
      return {
        outName: `${stem}-compressed${ext}`,
        cmd: "gs",
        args: (i, o) => [
          "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.6", "-dPDFSETTINGS=/printer",
          "-dDetectDuplicateImages=true", "-dCompressFonts=true",
          "-dNOPAUSE", "-dQUIET", "-dBATCH", `-sOutputFile=${o}`, i,
        ],
      };
    case "video":
      return {
        outName: `${stem}-compressed.mp4`,
        cmd: "ffmpeg",
        args: (i, o) => [
          "-v", "error", "-y", "-i", i, "-map", "0:v:0", "-map", "0:a?", "-sn",
          "-c:v", "libx265", "-crf", "24", "-preset", "medium", "-tag:v", "hvc1",
          "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", o,
        ],
      };
    case "generic":
      return {
        outName: `${path.basename(file.path)}.zip`,
        cmd: "/usr/bin/zip",
        zip: true,
      };
    default:
      return null;
  }
}

async function copyOriginal(file, destDir) {
  if (path.dirname(file.path) === destDir) return null; // already there
  const target = await uniquePath(destDir, path.basename(file.path));
  await fs.cp(file.path, target, { recursive: true, errorOnExist: true, force: false });
  return path.basename(target);
}

/**
 * Compress one file into destDir and save a copy of the original beside it.
 * Resolves to a result object; sets `timedOut` when the time budget ran out
 * (nothing is written to destDir in that case).
 */
export async function compressOne(file, destDir, { timeoutMs } = {}) {
  const kind = classify(file);
  const result = { name: file.name, kind, status: "error", before: 0, after: 0 };

  try {
    result.before = await sizeOf(file.path);

    if (file.isDirectory && (destDir === file.path || destDir.startsWith(file.path + path.sep))) {
      result.note = "The destination folder is inside the folder being compressed.";
      return result;
    }

    const job = await plan(kind, file);
    if (!job) {
      result.originalCopy = await copyOriginal(file, destDir);
      result.status = "already-compressed";
      result.note = "This file type is already compressed, so only the original was saved.";
      return result;
    }

    // Helper tools work on a private copy in the temp folder. Only this Node
    // process touches the user's folders, because macOS privacy protection
    // (Desktop, Documents, Downloads...) can block tools launched by Vehla.
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), "vehla-compressor-"));
    try {
      const stagedIn = path.join(stage, path.basename(file.path));
      await fs.cp(file.path, stagedIn, { recursive: true });
      const activeJob = kind === "video" ? await videoPlan(file, stagedIn) : job;
      const finalPath = await uniquePath(destDir, activeJob.outName);
      const stagedOut = path.join(stage, `result${path.extname(finalPath)}`);

      let outcome;
      if (job.zip) {
        const args = file.isDirectory
          ? ["-9", "-q", "-r", "-X", stagedOut, `./${path.basename(stagedIn)}`]
          : ["-9", "-q", "-X", "-j", stagedOut, stagedIn];
        outcome = await run(job.cmd, args, { cwd: stage, timeoutMs });
      } else {
        outcome = await run(job.cmd, activeJob.args(stagedIn, stagedOut), { timeoutMs });
      }

      if (outcome.timedOut) {
        result.timedOut = true;
        return result;
      }
      if (outcome.code !== 0) {
        result.note = `${path.basename(job.cmd)} failed: ${outcome.stderr.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${outcome.code}`}`;
        return result;
      }

      const after = await sizeOf(stagedOut);
      result.originalCopy = await copyOriginal(file, destDir);

      if (after < result.before * MIN_SAVING) {
        const tmpPath = path.join(destDir, `.${path.basename(finalPath)}.partial`);
        try {
          await fs.copyFile(stagedOut, tmpPath);
          await fs.rename(tmpPath, finalPath);
        } catch (error) {
          await fs.rm(tmpPath, { force: true });
          throw error;
        }
        result.status = "compressed";
        result.after = after;
        result.outName = path.basename(finalPath);
      } else {
        result.status = "already-optimal";
        result.after = result.before;
        result.note = "Already well optimised. No smaller version without losing quality, so only the original was saved.";
      }
      return result;
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  } catch (error) {
    const blocked =
      ["EPERM", "EACCES"].includes(error.code) || /operation not permitted|permission denied/i.test(error.message);
    result.note = blocked
      ? `macOS blocked Vehla from writing to ${destDir}. Allow it under System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then try again.`
      : error.message;
    return result;
  }
}

/**
 * Process files in order. With `deadlineAt`, files that cannot finish in time
 * (and all videos) are returned in `deferred` for the background worker.
 */
export async function runBatch(files, destDir, { deadlineAt } = {}) {
  const results = [];
  const deferred = [];
  for (const file of files) {
    const remaining = deadlineAt ? deadlineAt - Date.now() : undefined;
    if (deadlineAt && (classify(file) === "video" || remaining < 1500)) {
      deferred.push(file);
      continue;
    }
    const result = await compressOne(file, destDir, { timeoutMs: remaining });
    if (result.timedOut) deferred.push(file);
    else results.push(result);
  }
  return { results, deferred };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export function describe(result) {
  switch (result.status) {
    case "compressed": {
      const saved = Math.round((1 - result.after / result.before) * 100);
      return `${formatBytes(result.before)} → ${formatBytes(result.after)} (−${saved}%)`;
    }
    case "already-optimal":
    case "already-compressed":
      return result.note;
    default:
      return `Failed: ${result.note ?? "unknown error"}`;
  }
}

export async function openInFileManager(dir) {
  spawn("/usr/bin/open", [dir], { detached: true, stdio: "ignore" }).unref();
}

export async function notifyUser(title, message) {
  await run("/usr/bin/osascript", [
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e", "end run",
    message, title,
  ]);
}
