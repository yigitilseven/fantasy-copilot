import fs from "node:fs";
import path from "node:path";

/** Tiny JSON file store for the ops processes (scheduler, browser worker): atomic writes, tolerant reads. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(fs.readFileSync(file, "utf8")) as object) } as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
